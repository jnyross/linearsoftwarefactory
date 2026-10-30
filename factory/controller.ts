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

// Amp allows 60 usage reports per hour per user; stay well inside it.
const AUDIT = { perTick: 6, perHour: 30, recheckMs: 15 * 60_000, settleMs: 2 * 60_000, staleMs: 45 * 60_000 }

/**
 * Subscription-only enforcement, run before any step each tick.
 * - Hard gate every tick: the routing table must be subscription-only with ChatGPT serving the worker model.
 * - Usage audit within the API budget: the controller and running workers every 15 minutes, each finished
 *   worker once (with any threads it started). A request served by Amp credits or a non-subscription
 *   connection blocks dispatch and stops that worker until the routing table changes.
 * - Fails closed: unreadable routing, or audits that stay behind for 45 minutes, block dispatch.
 */
async function routingGuard(ports: Ports, ledger: Ledger, now: number): Promise<Guard> {
	if (!ports.routing) return { ok: true, offending: [] }
	const routing = ports.routing
	const state = (ledger.routing ??= { since: now, calls: [] })
	state.since ??= now
	state.calls = (state.calls ?? []).filter((t) => now - t < 3_600_000)
	const audited = (ledger.audited ??= {})
	const problems: string[] = []
	const offending: string[] = []
	let verdict
	try {
		verdict = checkProviders(await routing.providers())
	} catch (e) {
		problems.push(`cannot read model routing (${(e as Error).message})`)
	}
	if (verdict && !verdict.ok) problems.push(verdict.reason!)
	const fingerprint = verdict ? [...verdict.allowed].sort().join(',') : ''
	if (state.violation && state.violation.fingerprint !== fingerprint) delete state.violation
	if (verdict?.ok) {
		type Target = { label: string; thread: string; job?: string; range?: { start: number; end: number } }
		const targets: Target[] = []
		const controllerAt = state.controllerAuditAt ?? 0
		if (now - controllerAt >= AUDIT.recheckMs) targets.push({ label: 'controller', thread: ports.controllerThreadId, range: { start: Math.max(controllerAt, now - 3_600_000), end: now } })
		const running = Object.values(ledger.jobs).filter((j) => j.threadId && j.phase === 'started')
		for (const j of running) if (now - (audited[j.threadId!] ?? 0) >= AUDIT.recheckMs) targets.push({ label: j.key, thread: j.threadId!, job: j.key })
		const runningThreads = new Set(running.map((j) => j.threadId))
		const finished = new Map<string, { key: string; at: number }>()
		for (const h of ledger.history) if (h.threadId && !runningThreads.has(h.threadId)) finished.set(h.threadId, { key: h.key, at: h.at })
		const due = [...finished].filter(([t, h]) => now - h.at >= AUDIT.settleMs && (audited[t] ?? 0) < h.at + AUDIT.settleMs).sort((a, b) => b[1].at - a[1].at)
		for (const [t, h] of due) targets.push({ label: h.key, thread: t })
		let budget = Math.min(AUDIT.perTick, AUDIT.perHour - state.calls.length)
		for (const target of targets) {
			if (budget <= 0) break
			let threads: string[]
			try {
				threads = [target.thread, ...(target.label === 'controller' ? [] : await routing.children(target.thread))]
			} catch {
				continue // retried next tick; staleness check below fails closed if this persists
			}
			if (threads.length > budget) break
			const bad: string[] = []
			let complete = true
			for (const t of threads) {
				budget--
				state.calls.push(now)
				try {
					const v = auditUsage(await routing.usage(t, t === target.thread ? target.range : undefined), verdict.allowed)
					if (v.length) bad.push(`${t === target.thread ? '' : `child ${t}: `}${v.join('; ')}`)
				} catch {
					complete = false
				}
			}
			if (bad.length) {
				state.violation = { fingerprint, reason: `${target.label} ${target.thread}: ${bad.join(' | ')}`, at: now }
				if (target.job) offending.push(target.job)
			}
			if (complete) {
				if (target.label === 'controller') state.controllerAuditAt = now
				else audited[target.thread] = now
			}
		}
		const behind = due.filter(([t, h]) => h.at >= state.since! && (audited[t] ?? 0) < h.at && now - h.at > AUDIT.staleMs)
		if (now - (state.controllerAuditAt ?? state.since!) > AUDIT.staleMs) behind.push([ports.controllerThreadId, { key: 'controller', at: 0 }])
		if (behind.length) problems.push(`usage audit is more than 45 minutes behind for ${behind.map(([t, h]) => `${h.key} ${t}`).join(', ')}`)
	}
	if (state.violation) problems.push(`paid or non-subscription model routing seen (${state.violation.reason}); dispatch stays blocked until model routing changes`)
	const ok = problems.length === 0
	if (ok) delete state.blockedSince
	else state.blockedSince ??= now
	state.reason = ok ? undefined : problems.join(' | ')
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
