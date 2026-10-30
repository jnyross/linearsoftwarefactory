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

export interface Ports {
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

async function collect(ports: Ports, cfg: Config, ledger: Ledger, now: number): Promise<Snapshot> {
	const { linear, threads } = ports
	const S = cfg.statuses
	const L = cfg.labels
	const issues: Record<string, Issue> = {}
	for (const state of [S.intake, S.ready, S.active, S.review]) {
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
	const steps = decide(snap, ledger, cfg)
	const notes: string[] = []
	const errors: string[] = []
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
			for (const t of action.resetTests) await linear.update(t, { state: cfg.statuses.ready })
			ledger.jobs[action.job.key] = { ...action.job }
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
			for (const t of action.resetTests ?? []) await linear.update(t, { state: cfg.statuses.ready })
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
