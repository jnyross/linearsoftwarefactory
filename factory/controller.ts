// One controller tick: read Linear, decide, perform steps, persist the ledger.
// I/O goes through ports so tests can drive the same code with fakes.

import {
	FAILURE_KINDS,
	config as defaultConfig,
	decide,
	emptyLedger,
	type Action,
	type Config,
	type Failure,
	type FailureKind,
	type Issue,
	type Job,
	type Ledger,
	type Patch,
	type Snapshot,
	type Stage,
	type ThreadState,
} from './core'
import { nudgePrompt, workerPrompt } from './prompts'
import { auditUsage, checkProviders, type Connection } from './routing'

export interface Comment {
	id: string
	body: string
	createdAt: string
}

export interface LinearPort {
	listByState(state: string): Promise<Issue[]>
	listChildren(parentId: string): Promise<Issue[]>
	getIssue(id: string, withRelations: boolean): Promise<Issue | null>
	listComments(issueId: string): Promise<Comment[]>
	update(issueId: string, patch: Patch): Promise<void>
	comment(issueId: string, body: string): Promise<void>
}

export interface ThreadPort {
	create(job: Job): Promise<string>
	append(threadId: string, text: string): Promise<void>
	state(threadId: string): Promise<ThreadState>
	cancel(threadId: string): Promise<void>
	url(threadId: string): string
}

export interface StorePort {
	load(): Promise<Ledger | null>
	save(ledger: Ledger): Promise<void>
}

export interface RoutingPort {
	providers(): Promise<Connection[]>
	/** Markdown from `amp threads usage <thread> --details`, optionally limited to [start, end). */
	usage(threadId: string, range?: { start: number; end: number }): Promise<string>
	/** Direct child threads (for example subagent panels a worker started). */
	children(threadId: string): Promise<string[]>
}

export interface Ports {
	routing?: RoutingPort
	linear: LinearPort
	threads: ThreadPort
	store: StorePort
	controllerThreadId: string
	now?: () => number
	log?: (line: string) => void
}

const MARKER = /<!--\s*lsf-(failure|dispatch)\s+(\{[\s\S]*?\})\s*-->/

export function parseMarker(body: string): { type: 'failure' | 'dispatch'; data: Record<string, unknown> } | null {
	const m = MARKER.exec(body)
	if (!m) return null
	try {
		return { type: m[1] as 'failure' | 'dispatch', data: JSON.parse(m[2]) }
	} catch {
		return { type: m[1] as 'failure' | 'dispatch', data: {} }
	}
}

const STAGES: Stage[] = ['plan', 'build', 'test', 'integrate', 'resolve']

export function latestFailure(issueId: string, comments: Comment[]): Failure | null {
	const sorted = [...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
	for (const c of sorted) {
		const m = parseMarker(c.body)
		if (m?.type !== 'failure') continue
		const stage = STAGES.includes(m.data.stage as Stage) ? (m.data.stage as Stage) : 'resolve'
		const kind = (FAILURE_KINDS as readonly string[]).includes(m.data.kind as string) ? (m.data.kind as FailureKind) : 'unknown'
		const signature = typeof m.data.signature === 'string' && m.data.signature.trim() ? m.data.signature : `${kind} (no signature)`
		const summary = c.body.replace(MARKER, '').trim()
		return { commentId: c.id, issueId, stage, kind, signature, summary }
	}
	return null
}

export function failureComment(f: { stage: Stage; kind: FailureKind; signature: string; summary: string }) {
	return `<!-- lsf-failure ${JSON.stringify({ stage: f.stage, kind: f.kind, signature: f.signature })} -->\n**Factory controller detected a ${f.stage} failure** (\`${f.kind}\`).\n\n${f.summary}`
}

interface Guard {
	ok: boolean
	reason?: string
	offending: string[]
}

/**
 * Subscription-only enforcement, run before any step each tick. Fails closed: if the routing
 * table or usage cannot be read, no new model work starts. Unblocks automatically once clean.
 */
async function routingGuard(ports: Ports, ledger: Ledger, now: number): Promise<Guard> {
	if (!ports.routing) return { ok: true, offending: [] }
	const routing = ports.routing
	const problems: string[] = []
	const offending: string[] = []
	let allowed = new Set<string>()
	try {
		const v = checkProviders(await routing.providers())
		allowed = v.allowed
		if (!v.ok) problems.push(v.reason!)
	} catch (e) {
		problems.push(`cannot read model routing (${(e as Error).message})`)
	}
	if (!problems.length) {
		const audits: Array<{ label: string; job?: string; run: () => Promise<string> }> = []
		const start = Math.max(ledger.routing?.lastAuditAt ?? 0, now - 15 * 60_000)
		audits.push({ label: `controller ${ports.controllerThreadId}`, run: () => routing.usage(ports.controllerThreadId, { start, end: now }) })
		for (const j of Object.values(ledger.jobs)) if (j.threadId && j.phase === 'started') audits.push({ label: `${j.key} ${j.threadId}`, job: j.key, run: () => routing.usage(j.threadId!) })
		const audited = (ledger.audited ??= {})
		const finished = ledger.history.filter((h) => h.threadId && !audited[h.threadId] && now - h.at >= 120_000)
		for (const h of finished) audits.push({ label: `${h.key} ${h.threadId}`, run: () => routing.usage(h.threadId!) })
		// Workers cannot be denied code_exec, so also audit any threads they started.
		const workerTargets = audits.slice(1)
		const kids = await Promise.allSettled(workerTargets.map(async (a) => {
			const id = a.label.split(' ').at(-1)!
			const direct = await routing.children(id)
			const nested = (await Promise.all(direct.map((c) => routing.children(c)))).flat()
			return [...direct, ...nested].map((c) => ({ label: `${a.label} child ${c}`, job: a.job, run: () => routing.usage(c) }))
		}))
		kids.forEach((k, i) => {
			if (k.status === 'fulfilled') audits.push(...k.value)
			else problems.push(`cannot list child threads of ${workerTargets[i].label} (${(k.reason as Error)?.message ?? k.reason})`)
		})
		const results = await Promise.allSettled(audits.map((a) => a.run()))
		results.forEach((r, i) => {
			const a = audits[i]
			if (r.status === 'rejected') return problems.push(`cannot audit ${a.label} (${(r.reason as Error)?.message ?? r.reason})`)
			const bad = auditUsage(r.value, allowed)
			if (bad.length) {
				problems.push(`${a.label}: ${bad.join('; ')}`)
				if (a.job) offending.push(a.job)
			}
		})
		if (!problems.length) for (const h of finished) audited[h.threadId!] = now
	}
	const ok = problems.length === 0
	ledger.routing = ok ? { lastAuditAt: now } : { ...ledger.routing, blockedSince: ledger.routing?.blockedSince ?? now, reason: problems.join(' | ') }
	await ports.store.save(ledger)
	return ok ? { ok, offending } : { ok, reason: problems.join(' | '), offending }
}

async function collect(ports: Ports, cfg: Config, ledger: Ledger, now: number): Promise<Snapshot> {
	const { linear, threads } = ports
	const S = cfg.statuses
	const L = cfg.labels
	const issues: Record<string, Issue> = {}
	for (const state of [S.intake, S.ready, S.active]) {
		for (const i of await linear.listByState(state)) issues[i.id] = i
	}
	const children: Record<string, string[]> = {}
	const parents = Object.values(issues).filter((i) => i.labels.includes(L.idea) || i.labels.includes(L.build))
	for (const p of parents) {
		const kids = await linear.listChildren(p.id)
		children[p.id] = kids.map((k) => k.id)
		for (const k of kids) issues[k.id] ??= k
	}
	// Parents of active tests and builds, so planned/review checks see them even when terminal.
	for (const i of Object.values(issues)) {
		if (i.parentId && !issues[i.parentId]) {
			const p = await linear.getIssue(i.parentId, false)
			if (p) issues[p.id] = p
		}
	}
	for (const i of Object.values(issues)) {
		if (i.labels.includes(L.build) && i.status === S.ready) {
			const full = await linear.getIssue(i.id, true)
			i.blockedBy = full?.blockedBy ?? []
			for (const b of i.blockedBy) {
				if (!issues[b]) {
					const bi = await linear.getIssue(b, false)
					if (bi) issues[b] = bi
				}
			}
		}
	}
	const failures: Record<string, Failure | null> = {}
	for (const i of Object.values(issues)) {
		if (i.labels.includes(L.resolution)) failures[i.id] = latestFailure(i.id, await linear.listComments(i.id))
	}
	const threadStates: Record<string, ThreadState> = {}
	for (const j of Object.values(ledger.jobs)) {
		if (j.threadId) threadStates[j.threadId] = await threads.state(j.threadId)
	}
	return { now, issues, children, failures, threads: threadStates }
}

export interface TickResult {
	summary: string
	notes: string[]
	errors: string[]
}

export async function tick(ports: Ports, cfg: Config = defaultConfig): Promise<TickResult> {
	const now = (ports.now ?? Date.now)()
	const log = ports.log ?? (() => {})
	const ledger = (await ports.store.load()) ?? emptyLedger()
	const snap = await collect(ports, cfg, ledger, now)
	const notes: string[] = []
	const errors: string[] = []
	const guard = await routingGuard(ports, ledger, now)
	let steps = decide(snap, ledger, cfg)
	if (!guard.ok) {
		// Never start or prompt model work while routing is unverified or not subscription-only.
		const held = steps.filter((s) => s.action.type === 'dispatch' || s.action.type === 'resume-dispatch' || s.action.type === 'nudge')
		steps = steps.filter((s) => !held.includes(s))
		for (const key of guard.offending) {
			const job = ledger.jobs[key]
			if (job?.threadId) await ports.threads.cancel(job.threadId).catch(() => {})
		}
		errors.push(`routing guard: ${guard.reason}; held ${held.length} dispatch/nudge steps${guard.offending.length ? `, stopped ${guard.offending.join(', ')}` : ''}`)
		log(`lsf routing guard blocked: ${guard.reason}`)
	}
	for (const step of steps) {
		try {
			await perform(ports, cfg, ledger, snap, step.action)
			step.commit?.(ledger)
			await ports.store.save(ledger)
			if (step.action.type !== 'ledger') notes.push(step.note)
		} catch (e) {
			// One failed step never blocks the others; it is retried next tick.
			const msg = `${step.note}: ${(e as Error).message ?? e}`
			errors.push(msg)
			log(`lsf step failed: ${msg}`)
		}
	}
	const active = Object.values(ledger.jobs)
	const summary = `lsf tick: ${notes.length} actions, ${errors.length} errors, ${active.length} active jobs${active.length ? ` (${active.map((j) => j.key).join(', ')})` : ''}`
	return { summary, notes, errors }
}

async function perform(ports: Ports, cfg: Config, ledger: Ledger, snap: Snapshot, action: Action) {
	const { linear, threads } = ports
	switch (action.type) {
		case 'ledger':
			return
		case 'dispatch': {
			for (const key of action.cancelJobs) await supersede(ports, ledger, key)
			for (const t of action.resetTests) await linear.update(t, { state: cfg.statuses.ready, removeLabels: [cfg.labels.passed] })
			// Claim before any I/O: the attempt number and consumed directive persist even if
			// the rest of the dispatch fails and is finished later by resume-dispatch.
			const { role, issueId, attempt } = action.job
			ledger.jobs[action.job.key] = { ...action.job }
			ledger.attempts[`${role}:${issueId}`] = Math.max(ledger.attempts[`${role}:${issueId}`] ?? 0, attempt)
			delete ledger.directives[`${role}:${issueId}`]
			await ports.store.save(ledger)
			await linear.update(action.job.issueId, action.patch)
			await advanceDispatch(ports, cfg, ledger, snap, action.job.key)
			return
		}
		case 'resume-dispatch':
			return advanceDispatch(ports, cfg, ledger, snap, action.jobKey)
		case 'nudge': {
			const job = ledger.jobs[action.jobKey]
			if (job?.threadId) await threads.append(job.threadId, nudgePrompt(job, action.reason, cfg, ports.controllerThreadId))
			return
		}
		case 'cancel':
			return supersede(ports, ledger, action.jobKey)
		case 'patch': {
			for (const key of action.cancelJobs ?? []) await supersede(ports, ledger, key)
			for (const t of action.resetTests ?? []) await linear.update(t, { state: cfg.statuses.ready, removeLabels: [cfg.labels.passed] })
			await linear.update(action.issueId, action.patch)
			if (action.comment) await linear.comment(action.issueId, action.comment)
			return
		}
		case 'report-failure': {
			const job = action.jobKey ? ledger.jobs[action.jobKey] : undefined
			if (job?.threadId) await threads.cancel(job.threadId).catch(() => {})
			await linear.comment(action.issueId, failureComment(action))
			await linear.update(action.issueId, action.patch)
			return
		}
		case 'orphan':
			return adoptOrphan(ports, cfg, ledger, action.issueId, action.role)
	}
}

async function supersede(ports: Ports, ledger: Ledger, key: string) {
	const job = ledger.jobs[key]
	if (!job) return
	if (job.threadId) await ports.threads.cancel(job.threadId).catch(() => {})
	delete ledger.jobs[key]
	ledger.history.push({ key, role: job.role, issueId: job.issueId, threadId: job.threadId, outcome: 'superseded', at: Date.now() })
	await ports.store.save(ledger)
}

async function advanceDispatch(ports: Ports, cfg: Config, ledger: Ledger, snap: Snapshot, key: string) {
	const { linear, threads } = ports
	const job = ledger.jobs[key]
	if (!job) return
	const issue = snap.issues[job.issueId] ?? (await linear.getIssue(job.issueId, false))
	if (!issue) throw new Error(`issue ${job.issueId} not found`)
	let reused = false
	if (job.phase === 'claimed') {
		const resume = job.directive?.resumeThreadId
		if (resume && (await threads.state(resume)) === 'idle') {
			job.threadId = resume
			reused = true
		} else {
			job.threadId = await threads.create(job)
		}
		job.phase = 'created'
		await ports.store.save(ledger)
	}
	if (job.phase === 'created') {
		if (!job.commented) {
			const marker = JSON.stringify({ role: job.role, attempt: job.attempt, thread: job.threadId, job: job.key })
			await linear.comment(
				job.issueId,
				`<!-- lsf-dispatch ${marker} -->\nFactory dispatched **${job.role}** attempt ${job.attempt}${reused ? ' (resuming the previous owner thread)' : ''}${job.directive ? ` with directive \`${job.directive.route}\`` : ''}: [worker thread](${threads.url(job.threadId!)}).`,
			)
			job.commented = true
			await ports.store.save(ledger)
		}
		await threads.append(job.threadId!, workerPrompt(cfg, ports.controllerThreadId, job, issue))
		job.phase = 'started'
		job.startedAt = (ports.now ?? Date.now)()
		await ports.store.save(ledger)
	}
}

async function adoptOrphan(ports: Ports, cfg: Config, ledger: Ledger, issueId: string, role: Job['role']) {
	const { linear, threads } = ports
	const comments = await linear.listComments(issueId)
	const dispatches = comments
		.map((c) => ({ c, m: parseMarker(c.body) }))
		.filter((x) => x.m?.type === 'dispatch' && x.m.data.role === role)
		.sort((a, b) => b.c.createdAt.localeCompare(a.c.createdAt))
	const last = dispatches[0]?.m?.data
	const threadId = typeof last?.thread === 'string' ? last.thread : undefined
	const state = threadId ? await threads.state(threadId) : 'missing'
	if (threadId && (state === 'running' || state === 'awaiting-approval' || state === 'unknown')) {
		const attempt = typeof last?.attempt === 'number' ? last.attempt : 1
		const key = `${role}:${issueId}:${attempt}`
		const now = (ports.now ?? Date.now)()
		ledger.jobs[key] = { key, role, issueId, attempt, phase: 'started', threadId, createdAt: now, startedAt: now, commented: true }
		ledger.attempts[`${role}:${issueId}`] = Math.max(ledger.attempts[`${role}:${issueId}`] ?? 0, attempt)
		await ports.store.save(ledger)
		return
	}
	const patch: Patch =
		role === 'integrate' ? { removeLabels: [cfg.labels.integrating], addLabels: [cfg.labels.resolution] } : { state: cfg.statuses.ready, addLabels: [cfg.labels.resolution] }
	await linear.comment(issueId, failureComment({ stage: role, kind: 'stale', signature: `stale ${role} orphaned`, summary: `Linear shows this ${role} stage in progress but no live worker owns it (last worker: ${threadId ?? 'none'}, state ${state}).` }))
	await linear.update(issueId, patch)
}
