// Pure decision logic for the Linear Software Factory controller.
// `decide` reads a Linear snapshot plus the durable ledger and returns steps.
// The controller (controller.ts) performs each step's I/O and then applies its
// ledger commit, so a failed step leaves the ledger unchanged and is retried.

import defaultConfig from './config.json'

export type Config = typeof defaultConfig
export const config: Config = defaultConfig

export type Role = 'plan' | 'build' | 'test' | 'integrate' | 'resolve'
export type Stage = Role
export type ThreadState = 'idle' | 'running' | 'awaiting-approval' | 'error' | 'missing' | 'unknown'

export const FAILURE_KINDS = [
	'test-failure',
	'build-failure',
	'conflict',
	'combined-test-failure',
	'push-rejected',
	'unclear-requirements',
	'setup',
	'dependency',
	'worker-error',
	'stale',
	'unknown',
] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]

export interface Issue {
	id: string // identifier, e.g. LOO-12
	title: string
	status: string
	statusType: string
	labels: string[]
	parentId: string | null
	blockedBy?: string[]
	createdAt?: string
}

export interface Failure {
	commentId: string
	issueId: string
	stage: Stage
	kind: FailureKind
	signature: string
	summary: string
}

export interface Job {
	key: string
	role: Role
	issueId: string
	attempt: number
	phase: 'claimed' | 'created' | 'started'
	threadId?: string
	createdAt: number
	startedAt?: number
	nudgedAt?: number
	idleSince?: number
	errorSince?: number
	directive?: Directive
	/** The dispatch marker comment was written to Linear. */
	commented?: boolean
}

export type RouteName =
	| 'repair'
	| 'repair-different'
	| 'integrate-retry'
	| 'retry'
	| 'resolve'
	| 'resolve-replan'
	| 'wait'

export interface Directive {
	route: RouteName
	text: string
	failure?: Failure
	resumeThreadId?: string
}

export interface Resolution {
	key: string
	issueId: string
	stage: Stage
	kind: FailureKind
	signature: string
	count: number
	lastRoute: RouteName
	firstAt: number
	lastAt: number
}

export interface Wait {
	until: number
	resume: Exclude<RouteName, 'wait'>
	stage: Stage
	failure: Failure
	reason: string
}

export interface Ledger {
	version: 1
	jobs: Record<string, Job>
	history: Array<{ key: string; role: Role; issueId: string; threadId?: string; outcome: string; at: number }>
	attempts: Record<string, number>
	resolutions: Record<string, Resolution>
	processed: Record<string, number>
	directives: Record<string, Directive>
	waits: Record<string, Wait>
	routesPerIssue: Record<string, number>
}

export function emptyLedger(): Ledger {
	return {
		version: 1,
		jobs: {},
		history: [],
		attempts: {},
		resolutions: {},
		processed: {},
		directives: {},
		waits: {},
		routesPerIssue: {},
	}
}

export interface Snapshot {
	now: number
	issues: Record<string, Issue>
	/** parent id -> child ids, complete for every idea and build issue in `issues`. */
	children: Record<string, string[]>
	/** Latest lsf-failure marker for issues carrying the resolution label. */
	failures: Record<string, Failure | null>
	/** Thread states for active ledger jobs and resume candidates. */
	threads: Record<string, ThreadState>
}

export interface Patch {
	state?: string
	addLabels?: string[]
	removeLabels?: string[]
}

export type Action =
	| { type: 'dispatch'; job: Job; patch: Patch; resetTests: string[]; cancelJobs: string[] }
	| { type: 'resume-dispatch'; jobKey: string }
	| { type: 'nudge'; jobKey: string; reason: string }
	| { type: 'cancel'; jobKey: string; reason: string }
	| { type: 'patch'; issueId: string; patch: Patch; comment?: string; resetTests?: string[]; cancelJobs?: string[] }
	| { type: 'report-failure'; issueId: string; stage: Stage; kind: FailureKind; signature: string; summary: string; patch: Patch; jobKey?: string }
	| { type: 'orphan'; issueId: string; role: Role }
	| { type: 'ledger' }

export interface Step {
	action: Action
	commit?: (ledger: Ledger) => void
	note: string
}

const TERMINAL = new Set(['completed', 'canceled', 'duplicate'])
export const isTerminal = (i: Issue | undefined) => !!i && TERMINAL.has(i.statusType)
const has = (i: Issue | undefined, label: string) => !!i && i.labels.includes(label)

export function jobKey(role: Role, issueId: string, attempt: number) {
	return `${role}:${issueId}:${attempt}`
}

export function normalizeSignature(sig: string) {
	return sig
		.toLowerCase()
		.replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
		.replace(/\d+(\.\d+)?\s*ms\b/g, '<ms>')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200)
}

export function resolutionKey(issueId: string, stage: Stage, signature: string) {
	return `${issueId}|${stage}|${normalizeSignature(signature)}`
}

/** Escalation ladder. `count` is how many times this exact failure signature was seen. */
export function routeFor(stage: Stage, kind: FailureKind, count: number): RouteName {
	if (kind === 'dependency') return 'wait'
	if (kind === 'unclear-requirements' || kind === 'setup') return count >= 3 ? 'resolve-replan' : 'resolve'
	if (kind === 'worker-error' || kind === 'stale') return count === 1 ? 'retry' : count >= 4 ? 'resolve-replan' : 'resolve'
	if (stage === 'resolve') return count === 1 ? 'resolve' : count === 2 ? 'resolve-replan' : 'wait'
	if (stage === 'plan') return count === 1 ? 'retry' : count >= 3 ? 'resolve-replan' : 'resolve'
	if (stage === 'integrate') {
		if (count === 1) return 'integrate-retry'
		if (count === 2) return 'repair'
		return count >= 4 ? 'resolve-replan' : 'resolve'
	}
	// build / test stage code failures
	if (count === 1) return 'repair'
	if (count === 2) return 'repair-different'
	return count >= 4 ? 'resolve-replan' : 'resolve'
}

export function backoffMs(cfg: Config, count: number) {
	const { dependencyBackoffBaseMs: base, dependencyBackoffMaxMs: max } = cfg.timing
	return Math.min(max, base * 2 ** Math.max(0, count - 1))
}

const EXCLUSIVE: Role[] = ['plan', 'build', 'integrate', 'resolve']

export function unitOf(snap: Snapshot, cfg: Config, issueId: string): string {
	const issue = snap.issues[issueId]
	if (issue && has(issue, cfg.labels.test) && issue.parentId) return issue.parentId
	return issueId
}

interface Ctx {
	snap: Snapshot
	ledger: Ledger
	cfg: Config
	steps: Step[]
	running: Record<Role, number>
	total: number
	busyIssues: Set<string>
	exclusiveUnits: Set<string>
	sharedUnits: Map<string, string[]> // unit -> active tester job keys
	integrateActive: boolean
}

export function decide(snap: Snapshot, ledger: Ledger, cfg: Config = config): Step[] {
	const ctx: Ctx = {
		snap,
		ledger,
		cfg,
		steps: [],
		running: { plan: 0, build: 0, test: 0, integrate: 0, resolve: 0 },
		total: 0,
		busyIssues: new Set(),
		exclusiveUnits: new Set(),
		sharedUnits: new Map(),
		integrateActive: false,
	}
	monitorJobs(ctx)
	routeFailures(ctx)
	expireWaits(ctx)
	dispatchWork(ctx)
	return ctx.steps
}

function occupy(ctx: Ctx, job: Pick<Job, 'role' | 'issueId' | 'key'>) {
	ctx.running[job.role]++
	ctx.total++
	ctx.busyIssues.add(job.issueId)
	const unit = unitOf(ctx.snap, ctx.cfg, job.issueId)
	if (EXCLUSIVE.includes(job.role)) ctx.exclusiveUnits.add(unit)
	else ctx.sharedUnits.set(unit, [...(ctx.sharedUnits.get(unit) ?? []), job.key])
	if (job.role === 'integrate') ctx.integrateActive = true
}

function capacity(ctx: Ctx, role: Role) {
	return ctx.running[role] < ctx.cfg.limits[role] && ctx.total < ctx.cfg.limits.total
}

/** Whether Linear still shows the job's stage as in progress (the worker has not reported). */
function stillInStage(ctx: Ctx, job: Job): boolean {
	const { cfg } = ctx
	const issue = ctx.snap.issues[job.issueId]
	if (!issue) return false
	if (has(issue, cfg.labels.resolution) && job.role !== 'resolve') return false
	switch (job.role) {
		case 'plan':
			return issue.status === cfg.statuses.active && !has(issue, cfg.labels.planned)
		case 'build':
		case 'test':
			return issue.status === cfg.statuses.active
		case 'integrate':
			return has(issue, cfg.labels.integrating) && !isTerminal(issue)
		case 'resolve': {
			// The resolver either removed the label or reported a new failure of its own.
			const f = ctx.snap.failures[issue.id]
			const reportedNew = !!f && f.commentId !== job.directive?.failure?.commentId && !ctx.ledger.processed[f.commentId]
			return has(issue, cfg.labels.resolution) && !reportedNew
		}
	}
}

function finishJob(outcome: string, job: Job) {
	return (l: Ledger) => {
		delete l.jobs[job.key]
		l.history.push({ key: job.key, role: job.role, issueId: job.issueId, threadId: job.threadId, outcome, at: Date.now() })
		if (l.history.length > 500) l.history.splice(0, l.history.length - 500)
	}
}

function stageRevert(cfg: Config, role: Role): Patch {
	switch (role) {
		case 'build':
		case 'test':
			return { state: cfg.statuses.ready, addLabels: [cfg.labels.resolution] }
		case 'integrate':
			return { removeLabels: [cfg.labels.integrating], addLabels: [cfg.labels.resolution] }
		case 'plan':
		case 'resolve':
			return { addLabels: [cfg.labels.resolution] }
	}
}

function monitorJobs(ctx: Ctx) {
	const { snap, cfg } = ctx
	for (const job of Object.values(ctx.ledger.jobs)) {
		if (job.phase !== 'started') {
			// The controller stopped mid-dispatch; finish dispatching idempotently.
			occupy(ctx, job)
			ctx.steps.push({ action: { type: 'resume-dispatch', jobKey: job.key }, note: `resume dispatch ${job.key}` })
			continue
		}
		const state: ThreadState = (job.threadId && snap.threads[job.threadId]) || 'missing'
		const inStage = stillInStage(ctx, job)
		const issue = snap.issues[job.issueId]
		if (!issue || !inStage) {
			if ((state === 'running' || state === 'unknown') && issue && !isTerminal(issue)) {
				// Reported but still finishing its turn (for example sending the callback).
				occupy(ctx, job)
				continue
			}
			ctx.steps.push({ action: { type: 'ledger' }, commit: finishJob('reported', job), note: `finished ${job.key}` })
			continue
		}
		const age = snap.now - (job.startedAt ?? job.createdAt)
		if (state === 'unknown' && age <= cfg.timing.maxRuntimeMs) {
			occupy(ctx, job)
			continue
		}
		if (state === 'running' || state === 'awaiting-approval') {
			if (age > cfg.timing.maxRuntimeMs) {
				ctx.steps.push({
					action: {
						type: 'report-failure', issueId: job.issueId, stage: job.role, kind: 'stale',
						signature: `stale ${job.role} exceeded max runtime`, summary: `Worker thread ${job.threadId} ran longer than ${Math.round(cfg.timing.maxRuntimeMs / 60000)} minutes; the controller cancelled it.`,
						patch: stageRevert(cfg, job.role), jobKey: job.key,
					},
					commit: finishJob('timed-out', job),
					note: `timeout ${job.key}`,
				})
				continue
			}
			occupy(ctx, job)
			if (job.idleSince || job.errorSince) ctx.steps.push({ action: { type: 'ledger' }, commit: (l) => { const j = l.jobs[job.key]; if (j) { delete j.idleSince; delete j.errorSince } }, note: `active again ${job.key}` })
			continue
		}
		if (state === 'error') {
			const since = job.errorSince ?? snap.now
			if (snap.now - since >= cfg.timing.errorGraceMs) {
				ctx.steps.push({
					action: {
						type: 'report-failure', issueId: job.issueId, stage: job.role, kind: 'worker-error',
						signature: `worker-error ${job.role}`, summary: `Worker thread ${job.threadId} stayed in the error state for ${Math.round((snap.now - since) / 60000)} minutes.`,
						patch: stageRevert(cfg, job.role), jobKey: job.key,
					},
					commit: finishJob('worker-error', job),
					note: `worker error ${job.key}`,
				})
			} else {
				occupy(ctx, job)
				if (!job.errorSince) ctx.steps.push({ action: { type: 'ledger' }, commit: (l) => { if (l.jobs[job.key]) l.jobs[job.key].errorSince = snap.now }, note: `error seen ${job.key}` })
			}
			continue
		}
		// idle or missing while Linear still shows the stage in progress
		const idleSince = job.idleSince ?? snap.now
		const idleFor = snap.now - idleSince
		if (state === 'idle' && !job.nudgedAt && idleFor >= cfg.timing.staleAfterIdleMs) {
			occupy(ctx, job)
			ctx.steps.push({
				action: { type: 'nudge', jobKey: job.key, reason: 'ended its turn without completing the Linear handoff' },
				commit: (l) => { const j = l.jobs[job.key]; if (j) { j.nudgedAt = snap.now; delete j.idleSince } },
				note: `nudge ${job.key}`,
			})
			continue
		}
		const nudgeExpired = job.nudgedAt && snap.now - job.nudgedAt >= cfg.timing.nudgeGraceMs && idleFor >= cfg.timing.staleAfterIdleMs
		if (state === 'missing' || state === 'unknown' || nudgeExpired) {
			ctx.steps.push({
				action: {
					type: 'report-failure', issueId: job.issueId, stage: job.role, kind: 'stale',
					signature: `stale ${job.role} abandoned`, summary: state === 'missing' ? `Worker thread ${job.threadId ?? '(none)'} is unavailable.` : `Worker thread ${job.threadId} stopped twice without completing the ${job.role} handoff in Linear.`,
					patch: stageRevert(cfg, job.role), jobKey: job.key,
				},
				commit: finishJob('stale', job),
				note: `stale ${job.key}`,
			})
			continue
		}
		occupy(ctx, job)
		if (!job.idleSince) ctx.steps.push({ action: { type: 'ledger' }, commit: (l) => { if (l.jobs[job.key]) l.jobs[job.key].idleSince = snap.now }, note: `idle seen ${job.key}` })
	}
}

function failureJobsToCancel(ctx: Ctx, unit: string) {
	return ctx.sharedUnits.get(unit) ?? []
}

function testChildren(ctx: Ctx, buildId: string) {
	return (ctx.snap.children[buildId] ?? []).filter((id) => has(ctx.snap.issues[id], ctx.cfg.labels.test))
}

function lastJobThread(ledger: Ledger, role: Role, issueId: string) {
	for (let i = ledger.history.length - 1; i >= 0; i--) {
		const h = ledger.history[i]
		if (h.role === role && h.issueId === issueId) return h.threadId
	}
	return undefined
}

const ROUTE_TEXT: Record<Exclude<RouteName, 'wait'>, string> = {
	repair: 'Repair: the previous attempt failed. Read the failure evidence below and in the issue comments, reproduce it, fix the root cause on the branch, and rerun the full suite before handing back.',
	'repair-different': 'Repair with a different approach: the same failure has now happened twice. Do not repeat the previous fix. Re-diagnose from scratch, consider rewriting the change, and verify against every acceptance criterion and the test sub-issues.',
	'integrate-retry': 'Integration retry: the previous integration attempt failed. Start again from the latest origin/main, resolve conflicts using the acceptance criteria of this issue and of the issues already on main, and rerun the combined suite.',
	retry: 'Retry: the previous worker for this stage stalled or errored without finishing. Inspect the issue comments and any existing branch, continue from the current state, and complete the stage.',
	resolve: 'Resolve: diagnose the failure below, make an executable recovery or repair, document your assumptions in Linear, and resume the stage.',
	'resolve-replan': 'Resolve with re-planning authority: earlier strategies for this failure did not make progress. Find a genuinely different approach. You may rewrite the acceptance criteria with documented assumptions, split the issue into smaller lsf:build issues, or cancel it in favour of a replacement, as long as the original idea is still delivered.',
}

/** Steps that put an issue on a route. Returns null when capacity is unavailable (retry next tick). */
function applyRoute(ctx: Ctx, issue: Issue, stage: Stage, route: Exclude<RouteName, 'wait'>, failure: Failure, extraCommit?: (l: Ledger) => void): boolean {
	const { cfg } = ctx
	const isTest = has(issue, cfg.labels.test)
	const buildId = isTest && issue.parentId ? issue.parentId : issue.id
	const build = ctx.snap.issues[buildId] ?? issue
	const unit = unitOf(ctx.snap, cfg, issue.id)
	const directive: Directive = { route, text: ROUTE_TEXT[route], failure }
	const removeLabels = [cfg.labels.resolution, cfg.labels.waiting]

	if (route === 'resolve' || route === 'resolve-replan') {
		if (!capacity(ctx, 'resolve') || ctx.exclusiveUnits.has(unit)) return false
		const attempt = (ctx.ledger.attempts[`resolve:${issue.id}`] ?? 0) + 1
		const job: Job = { key: jobKey('resolve', issue.id, attempt), role: 'resolve', issueId: issue.id, attempt, phase: 'claimed', createdAt: ctx.snap.now, directive }
		occupy(ctx, job)
		ctx.steps.push({
			action: { type: 'dispatch', job, patch: { addLabels: [cfg.labels.resolution], removeLabels: [cfg.labels.waiting] }, resetTests: [], cancelJobs: failureJobsToCancel(ctx, unit) },
			commit: (l) => { l.attempts[`resolve:${issue.id}`] = attempt; extraCommit?.(l) },
			note: `${route} ${issue.id}: resolver attempt ${attempt}`,
		})
		return true
	}

	if (route === 'repair' || route === 'repair-different' || (route === 'retry' && (stage === 'build' || (stage === 'test' && !isTest)))) {
		const resumeThreadId = route === 'repair' ? lastJobThread(ctx.ledger, 'build', buildId) : undefined
		const resetTests = testChildren(ctx, buildId).filter((id) => ctx.snap.issues[id]?.status !== cfg.statuses.ready)
		ctx.steps.push({
			action: {
				type: 'patch', issueId: buildId,
				patch: { state: cfg.statuses.ready, addLabels: [cfg.labels.repair], removeLabels: [...removeLabels, cfg.labels.integrating] },
				comment: `Factory routed this build to **${route}** after a ${stage} failure (\`${failure.kind}\`: ${failure.signature}). All test sub-issues will rerun after the repair.`,
				resetTests,
				cancelJobs: failureJobsToCancel(ctx, unit),
			},
			commit: (l) => { l.directives[`build:${buildId}`] = { ...directive, resumeThreadId }; extraCommit?.(l) },
			note: `${route} ${buildId}`,
		})
		ctx.busyIssues.add(buildId)
		if (isTest && issue.id !== buildId) ctx.busyIssues.add(issue.id)
		return true
	}

	if (route === 'integrate-retry') {
		ctx.steps.push({
			action: { type: 'patch', issueId: build.id, patch: { state: cfg.statuses.review, removeLabels: [...removeLabels, cfg.labels.integrating] }, comment: `Factory scheduled an **integration retry** after \`${failure.kind}\`: ${failure.signature}.` },
			commit: (l) => { l.directives[`integrate:${build.id}`] = directive; extraCommit?.(l) },
			note: `integrate-retry ${build.id}`,
		})
		ctx.busyIssues.add(build.id)
		return true
	}

	// retry of plan / test (test issue itself) / integrate / resolve stages
	const entry: Patch =
		stage === 'plan' ? { state: cfg.statuses.active, removeLabels: [...removeLabels, cfg.labels.planned] }
		: stage === 'test' ? { state: cfg.statuses.ready, removeLabels }
		: stage === 'integrate' ? { state: cfg.statuses.review, removeLabels: [...removeLabels, cfg.labels.integrating] }
		: { removeLabels: [cfg.labels.waiting], addLabels: [cfg.labels.resolution] }
	if (stage === 'resolve') return applyRoute(ctx, issue, stage, 'resolve', failure, extraCommit)
	const role: Role = stage
	ctx.steps.push({
		action: { type: 'patch', issueId: issue.id, patch: entry, comment: `Factory scheduled a **retry** of the ${stage} stage after \`${failure.kind}\`.` },
		commit: (l) => { l.directives[`${role}:${issue.id}`] = directive; extraCommit?.(l) },
		note: `retry ${stage} ${issue.id}`,
	})
	ctx.busyIssues.add(issue.id)
	return true
}

function routeFailures(ctx: Ctx) {
	const { snap, cfg, ledger } = ctx
	for (const issue of Object.values(snap.issues)) {
		if (!has(issue, cfg.labels.resolution) || has(issue, cfg.labels.hold) || isTerminal(issue)) continue
		if (ctx.busyIssues.has(issue.id)) continue
		const unit = unitOf(snap, cfg, issue.id)
		if (ctx.exclusiveUnits.has(unit)) continue
		const failure = snap.failures[issue.id]
		if (!failure) {
			// Label without evidence (for example added by hand): treat as an unknown failure for a resolver.
			const synthetic: Failure = { commentId: `none:${issue.id}`, issueId: issue.id, stage: 'resolve', kind: 'unknown', signature: 'resolution label without lsf-failure evidence', summary: 'The lsf:resolution-needed label is present but no lsf-failure comment was found.' }
			if (ledger.processed[synthetic.commentId]) continue
			applyRoute(ctx, issue, 'resolve', 'resolve', synthetic, (l) => { l.processed[synthetic.commentId] = snap.now })
			continue
		}
		if (ledger.processed[failure.commentId]) continue
		const key = resolutionKey(issue.id, failure.stage, `${failure.kind} ${failure.signature}`)
		const prev = ledger.resolutions[key]
		const count = (prev?.count ?? 0) + 1
		const totalRoutes = (ledger.routesPerIssue[issue.id] ?? 0) + 1
		let route = routeFor(failure.stage, failure.kind, count)
		const exhausted = totalRoutes > cfg.escalation.maxRoutesPerIssue
		const commit = (l: Ledger) => {
			l.processed[failure.commentId] = snap.now
			l.routesPerIssue[issue.id] = exhausted ? 0 : totalRoutes
			l.resolutions[key] = { key, issueId: issue.id, stage: failure.stage, kind: failure.kind, signature: failure.signature, count, lastRoute: exhausted ? 'wait' : route, firstAt: prev?.firstAt ?? snap.now, lastAt: snap.now }
		}
		if (route === 'wait' || exhausted) {
			const dependency = failure.kind === 'dependency'
			const until = snap.now + (dependency && !exhausted ? backoffMs(cfg, count) : cfg.timing.cooldownMs)
			const resume: Exclude<RouteName, 'wait'> = dependency && !exhausted ? 'retry' : 'resolve-replan'
			const reason = dependency && !exhausted ? 'external dependency' : 'repeated failures without progress; cooling down before a fresh diagnosis'
			ctx.steps.push({
				action: {
					type: 'patch', issueId: issue.id,
					patch: { removeLabels: [cfg.labels.resolution], addLabels: [cfg.labels.waiting] },
					comment: `Factory is **waiting** (${reason}). Automatic retry (${resume}) after ${new Date(until).toISOString()}. Unrelated work continues.\n\nFailure: \`${failure.kind}\` ${failure.signature}`,
					cancelJobs: failureJobsToCancel(ctx, unit),
				},
				commit: (l) => { commit(l); l.waits[issue.id] = { until, resume, stage: failure.stage, failure, reason } },
				note: `wait ${issue.id} until ${new Date(until).toISOString()}`,
			})
			ctx.busyIssues.add(issue.id)
			continue
		}
		applyRoute(ctx, issue, failure.stage, route, failure, commit)
	}
}

function expireWaits(ctx: Ctx) {
	const { snap, cfg, ledger } = ctx
	for (const issue of Object.values(snap.issues)) {
		if (!has(issue, cfg.labels.waiting) || has(issue, cfg.labels.hold) || isTerminal(issue)) continue
		if (ctx.busyIssues.has(issue.id) || ctx.exclusiveUnits.has(unitOf(snap, cfg, issue.id))) continue
		const wait = ledger.waits[issue.id]
		if (wait && wait.until > snap.now) {
			ctx.busyIssues.add(issue.id)
			continue
		}
		const failure: Failure = wait?.failure ?? { commentId: `wait:${issue.id}`, issueId: issue.id, stage: 'resolve', kind: 'unknown', signature: 'waiting label without ledger record', summary: 'Waiting label present without a ledger record; resuming with a resolver.' }
		const resume = wait?.resume ?? 'resolve'
		applyRoute(ctx, issue, wait?.stage ?? 'resolve', resume, failure, (l) => { delete l.waits[issue.id] })
		ctx.busyIssues.add(issue.id)
	}
}

function blockersDone(ctx: Ctx, issue: Issue) {
	return (issue.blockedBy ?? []).every((id) => isTerminal(ctx.snap.issues[id]))
}

function parked(ctx: Ctx, issue: Issue) {
	const { labels } = ctx.cfg
	return has(issue, labels.hold) || has(issue, labels.resolution) || has(issue, labels.waiting)
}

function dispatch(ctx: Ctx, role: Role, issue: Issue, patch: Patch, extra: Partial<Pick<Extract<Action, { type: 'dispatch' }>, 'resetTests' | 'cancelJobs'>> = {}) {
	const attempt = (ctx.ledger.attempts[`${role}:${issue.id}`] ?? 0) + 1
	const directive = ctx.ledger.directives[`${role}:${issue.id}`]
	const job: Job = { key: jobKey(role, issue.id, attempt), role, issueId: issue.id, attempt, phase: 'claimed', createdAt: ctx.snap.now, directive }
	occupy(ctx, job)
	ctx.steps.push({
		action: { type: 'dispatch', job, patch, resetTests: extra.resetTests ?? [], cancelJobs: extra.cancelJobs ?? [] },
		commit: (l) => { l.attempts[`${role}:${issue.id}`] = attempt; delete l.directives[`${role}:${issue.id}`] },
		note: `dispatch ${job.key}`,
	})
}

function dispatchWork(ctx: Ctx) {
	const { snap, cfg } = ctx
	const { labels, statuses } = cfg
	const issues = Object.values(snap.issues).sort((a, b) => (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id, undefined, { numeric: true }))
	const free = (i: Issue) => !ctx.busyIssues.has(i.id) && !parked(ctx, i) && !isTerminal(i)
	const activeJobFor = (role: Role, id: string) => Object.values(ctx.ledger.jobs).some((j) => j.role === role && j.issueId === id)

	for (const issue of issues) {
		if (!free(issue)) continue
		const isBuild = has(issue, labels.build)
		const isTest = has(issue, labels.test)
		const isIdea = !issue.parentId && !isBuild && !isTest

		if (isIdea) {
			const planned = has(issue, labels.planned)
			if (issue.status === statuses.intake || (issue.status === statuses.active && has(issue, labels.idea) && !planned)) {
				if (activeJobFor('plan', issue.id) || !capacity(ctx, 'plan')) continue
				dispatch(ctx, 'plan', issue, { state: statuses.active, addLabels: [labels.idea] })
			} else if (planned && issue.status === statuses.active) {
				const builds = (snap.children[issue.id] ?? []).map((id) => snap.issues[id]).filter((c) => has(c, labels.build))
				if (builds.every((b) => isTerminal(b))) {
					const done = builds.filter((b) => b.statusType === 'completed').length
					ctx.steps.push({
						action: { type: 'patch', issueId: issue.id, patch: { state: statuses.done }, comment: `All ${builds.length} build issues are closed (${done} integrated into main). Factory marked this idea Done.` },
						note: `idea done ${issue.id}`,
					})
				}
			}
			continue
		}

		if (isBuild) {
			const unit = issue.id
			if (ctx.exclusiveUnits.has(unit)) continue
			if (issue.status === statuses.ready) {
				const parent = issue.parentId ? snap.issues[issue.parentId] : undefined
				if (parent && !has(parent, labels.planned) && !isTerminal(parent)) continue
				if (!blockersDone(ctx, issue) || !capacity(ctx, 'build')) continue
				dispatch(ctx, 'build', issue, { state: statuses.active, removeLabels: [labels.integrating] }, { cancelJobs: failureJobsToCancel(ctx, unit) })
			} else if (issue.status === statuses.active && !activeJobFor('build', issue.id)) {
				ctx.busyIssues.add(issue.id)
				ctx.steps.push({ action: { type: 'orphan', issueId: issue.id, role: 'build' }, note: `orphan build ${issue.id}` })
			} else if (issue.status === statuses.review) {
				if (has(issue, labels.integrating)) {
					if (!activeJobFor('integrate', issue.id)) {
						ctx.busyIssues.add(issue.id)
						ctx.integrateActive = true
						ctx.steps.push({ action: { type: 'orphan', issueId: issue.id, role: 'integrate' }, note: `orphan integrate ${issue.id}` })
					}
					continue
				}
				const tests = testChildren(ctx, issue.id).map((id) => snap.issues[id])
				const allPassed = tests.every((t) => t.statusType === 'completed' || t.statusType === 'canceled')
				if (!allPassed || ctx.integrateActive || !capacity(ctx, 'integrate') || ctx.sharedUnits.has(unit)) continue
				dispatch(ctx, 'integrate', issue, { addLabels: [labels.integrating] })
			}
			continue
		}

		if (isTest) {
			const build = issue.parentId ? snap.issues[issue.parentId] : undefined
			if (issue.status === statuses.active && !activeJobFor('test', issue.id)) {
				ctx.busyIssues.add(issue.id)
				ctx.steps.push({ action: { type: 'orphan', issueId: issue.id, role: 'test' }, note: `orphan test ${issue.id}` })
				continue
			}
			if (issue.status !== statuses.ready || !build) continue
			if (build.status !== statuses.review || parked(ctx, build) || has(build, labels.integrating)) continue
			if (ctx.exclusiveUnits.has(build.id) || ctx.busyIssues.has(build.id) || !capacity(ctx, 'test')) continue
			dispatch(ctx, 'test', issue, { state: statuses.active })
		}
	}
}
