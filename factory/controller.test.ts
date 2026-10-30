// Drives the real controller tick against an in-memory Linear and scripted workers.

import { describe, expect, test } from 'bun:test'
import { tick, type Comment, type Ports } from './controller'
import { config, emptyLedger, type Issue, type Job, type Ledger, type Patch, type ThreadState } from './core'

const S = config.statuses
const L = config.labels
const TYPE: Record<string, string> = { Backlog: 'backlog', Todo: 'unstarted', 'In Progress': 'started', 'In Review': 'started', Done: 'completed', Canceled: 'canceled', Triage: 'triage' }

interface FakeIssue extends Issue {
	comments: Comment[]
}
interface FakeThread {
	id: string
	job: Job
	state: ThreadState
	inbox: string[]
	handled: number
}
type Behavior = (w: World, t: FakeThread, msg: string) => void

class World {
	issues = new Map<string, FakeIssue>()
	threads = new Map<string, FakeThread>()
	ledger: Ledger | null = null
	now = Date.parse('2026-11-01T00:00:00Z')
	seq = 1
	commentSeq = 1
	createdThreads = 0
	behaviors: Partial<Record<Job['role'], Behavior>> = {}
	failCreateOnce = false
	/** When set, the routing port reports this usage row for worker threads. */
	routing: { connections: Array<{ id: string; type: string; active: boolean; priority: number }>; workerRoute: string; children?: Record<string, string[]>; childRoute?: string } | null = null

	add(title: string, status: string, labels: string[] = [], parentId: string | null = null, blockedBy: string[] = []) {
		const id = `LOO-${this.seq++}`
		this.issues.set(id, { id, title, status, statusType: TYPE[status], labels: [...labels], parentId, blockedBy, createdAt: new Date(this.now + this.seq).toISOString(), comments: [] })
		return id
	}
	get(id: string) {
		return this.issues.get(id)!
	}
	set(id: string, patch: Patch) {
		const i = this.get(id)
		if (patch.state) {
			i.status = patch.state
			i.statusType = TYPE[patch.state]
		}
		for (const l of patch.addLabels ?? []) if (!i.labels.includes(l)) i.labels.push(l)
		i.labels = i.labels.filter((l) => !(patch.removeLabels ?? []).includes(l))
	}
	comment(id: string, body: string) {
		this.get(id).comments.push({ id: `c${this.commentSeq++}`, body, createdAt: new Date(this.now + this.commentSeq).toISOString() })
	}
	fail(id: string, stage: string, kind: string, signature: string) {
		this.comment(id, `<!-- lsf-failure ${JSON.stringify({ stage, kind, signature })} -->\nevidence for ${signature}`)
		this.set(id, { addLabels: [L.resolution] })
	}
	children(id: string) {
		return [...this.issues.values()].filter((i) => i.parentId === id)
	}
	strip(i: FakeIssue): Issue {
		const { comments: _c, ...rest } = i
		return { ...rest, labels: [...rest.labels], blockedBy: [...(rest.blockedBy ?? [])] }
	}

	ports(): Ports {
		const routing = this.routing
		return {
			routing: routing
				? {
						providers: async () => routing.connections,
						children: async (id) => routing.children?.[id] ?? [],
						usage: async (id) =>
							`## Model Routing\n\n| Model ID | Purpose | Routing | Requests | Cost |\n| --- | --- | --- | ---: | ---: |\n| openai/gpt-6.1-sol | Agent | ${id === 'T-controller' ? `Via [ChatGPT](https://ampcode.com/settings/model-routing#${routing.connections[0].id})` : id.startsWith('T-child') ? routing.childRoute : routing.workerRoute} | 3 | $0 |\n`,
					}
				: undefined,
			controllerThreadId: 'T-controller',
			now: () => this.now,
			store: { load: async () => (this.ledger ? structuredClone(this.ledger) : null), save: async (l) => void (this.ledger = structuredClone(l)) },
			linear: {
				listByState: async (state) => [...this.issues.values()].filter((i) => i.status === state).map((i) => this.strip(i)),
				listChildren: async (p) => this.children(p).map((i) => this.strip(i)),
				getIssue: async (id) => (this.issues.has(id) ? this.strip(this.get(id)) : null),
				listComments: async (id) => [...this.get(id).comments],
				update: async (id, patch) => this.set(id, patch),
				comment: async (id, body) => this.comment(id, body),
			},
			threads: {
				create: async (job) => {
					if (this.failCreateOnce) {
						this.failCreateOnce = false
						throw new Error('transient create failure')
					}
					const id = `T-${++this.createdThreads}`
					this.threads.set(id, { id, job: { ...job }, state: 'idle', inbox: [], handled: 0 })
					return id
				},
				append: async (id, text) => {
					const t = this.threads.get(id)!
					t.inbox.push(text)
					t.state = 'running'
					const key = /Factory job key: `([^`]+)`/.exec(text)?.[1]
					if (key) {
						const [role, issueId, attempt] = key.split(':')
						t.job = { ...t.job, key, role: role as Job['role'], issueId, attempt: Number(attempt) }
					}
				},
				state: async (id) => this.threads.get(id)?.state ?? 'missing',
				cancel: async (id) => {
					const t = this.threads.get(id)
					if (t) t.state = 'idle'
				},
				url: (id) => `https://ampcode.com/threads/${id}`,
			},
		}
	}

	/** Let every running worker take one turn. */
	runWorkers() {
		for (const t of this.threads.values()) {
			if (t.state !== 'running') continue
			while (t.handled < t.inbox.length) {
				const msg = t.inbox[t.handled++]
				this.behaviors[t.job.role]?.(this, t, msg)
			}
			t.state = 'idle'
		}
	}

	async cycle(n = 1, advanceMs = 60_000) {
		const out = []
		for (let k = 0; k < n; k++) {
			out.push(await tick(this.ports()))
			this.runWorkers()
			this.now += advanceMs
		}
		return out
	}
}

const happyPlanner: Behavior = (w, t) => {
	const idea = t.job.issueId
	if (w.children(idea).length === 0) {
		const b1 = w.add('build one', S.ready, [L.build], idea)
		w.add('test one', S.ready, [L.test], b1)
		const b2 = w.add('build two', S.ready, [L.build], idea, [b1])
		w.add('test two', S.ready, [L.test], b2)
		w.add('test two b', S.ready, [L.test], b2)
	}
	w.set(idea, { addLabels: [L.planned] })
}
const happyBuilder: Behavior = (w, t) => w.set(t.job.issueId, { addLabels: [L.built], removeLabels: [L.repair] })
const happyTester: Behavior = (w, t) => w.set(t.job.issueId, { state: S.done, addLabels: [L.passed] })
const happyIntegrator: Behavior = (w, t) => w.set(t.job.issueId, { state: S.done, addLabels: [L.integrated], removeLabels: [L.integrating, L.repair] })

function happy(w: World) {
	w.behaviors = { plan: happyPlanner, build: happyBuilder, test: happyTester, integrate: happyIntegrator }
}

function jobsNow(w: World) {
	return Object.values(w.ledger?.jobs ?? {}).map((j) => j.key)
}

describe('controller tick', () => {
	test('happy path: idea is planned, builds respect dependencies, tests run per task, integration is serialized', async () => {
		const w = new World()
		happy(w)
		const idea = w.add('an idea', S.intake)
		let maxIntegrators = 0
		let sawParallelTesters = false
		for (let i = 0; i < 20; i++) {
			await tick(w.ports())
			const keys = jobsNow(w)
			maxIntegrators = Math.max(maxIntegrators, keys.filter((k) => k.startsWith('integrate:')).length)
			if (keys.filter((k) => k.startsWith('test:')).length >= 2) sawParallelTesters = true
			// build two must never start before build one is Done
			const b1 = [...w.issues.values()].find((x) => x.title === 'build one')
			if (b1 && b1.status !== S.done) expect(keys.some((k) => k.startsWith('build:') && w.get(k.split(':')[1]).title === 'build two')).toBe(false)
			w.runWorkers()
			w.now += 60_000
		}
		expect(w.get(idea).status).toBe(S.done)
		expect(w.get(idea).labels).toContain(L.idea)
		for (const i of w.issues.values()) expect(i.status).toBe(S.done)
		expect(maxIntegrators).toBe(1)
		expect(sawParallelTesters).toBe(true)
		// one worker thread per issue task: planner + 2 builders + 3 testers + 2 integrators
		expect(w.createdThreads).toBe(8)
	})

	test('independent builds run in parallel, one agent per issue', async () => {
		const w = new World()
		w.behaviors = {} // workers stay busy
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const a = w.add('a', S.ready, [L.build], idea)
		const b = w.add('b', S.ready, [L.build], idea)
		const c = w.add('c', S.ready, [L.build], idea, [a])
		await tick(w.ports())
		for (const t of w.threads.values()) t.state = 'running'
		await tick(w.ports())
		const keys = jobsNow(w)
		expect(keys.sort()).toEqual([`build:${a}:1`, `build:${b}:1`])
		expect(w.get(c).status).toBe(S.ready)
		expect(w.createdThreads).toBe(2)
	})

	test('test failure routes back to the builder, resets tests, retests, then integrates', async () => {
		const w = new World()
		happy(w)
		let failures = 0
		w.behaviors.test = (w2, t) => {
			const testIssue = w2.get(t.job.issueId)
			if (testIssue.title === 'test one' && failures === 0) {
				failures++
				w2.fail(testIssue.parentId!, 'test', 'test-failure', 'test-failure test/one.test.ts > rejects empty input')
				w2.set(testIssue.parentId!, { state: S.ready, removeLabels: [L.built] })
				w2.set(testIssue.id, { state: S.ready })
				return
			}
			happyTester(w2, t, '')
		}
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const b = w.add('build', S.ready, [L.build], idea)
		const t1 = w.add('test one', S.ready, [L.test], b)
		const t2 = w.add('test two', S.ready, [L.test], b)
		await w.cycle(14)
		expect(failures).toBe(1)
		expect(w.get(b).status).toBe(S.done)
		expect(w.get(t1).status).toBe(S.done)
		expect(w.get(t2).status).toBe(S.done)
		const bodies = w.get(b).comments.map((c) => c.body).join('\n')
		expect(bodies).toContain('routed this build to **repair**')
		expect(bodies).toContain('(resuming the previous owner thread)')
		expect(w.ledger!.attempts[`build:${b}`]).toBe(2)
		// test one ran twice (fail, retest); test two was reset and reran too
		expect(w.ledger!.attempts[`test:${t1}`]).toBe(2)
		expect(w.ledger!.attempts[`test:${t2}`]).toBeGreaterThanOrEqual(1)
		expect(w.get(idea).status).toBe(S.done)
	})

	test('integration conflict retries integration, then routes to the builder, then succeeds', async () => {
		const w = new World()
		happy(w)
		let integrations = 0
		w.behaviors.integrate = (w2, t) => {
			integrations++
			if (integrations <= 2) {
				w2.fail(t.job.issueId, 'integrate', 'conflict', 'conflict src/greet.ts')
				w2.set(t.job.issueId, { removeLabels: [L.integrating] })
				return
			}
			happyIntegrator(w2, t, '')
		}
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const b = w.add('build', S.active, [L.build, L.built], idea)
		w.add('t', S.done, [L.test], b)
		await w.cycle(16)
		expect(w.get(b).status).toBe(S.done)
		const bodies = w.get(b).comments.map((c) => c.body).join('\n')
		expect(bodies).toContain('**integration retry**')
		expect(bodies).toContain('routed this build to **repair**')
		expect(integrations).toBe(3)
	})

	test('a failure that keeps repeating escalates to a resolver and then cools down, while unrelated work finishes', async () => {
		const w = new World()
		happy(w)
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const bad = w.add('bad build', S.ready, [L.build], idea)
		const good = w.add('good build', S.ready, [L.build], idea)
		w.add('good test', S.ready, [L.test], good)
		const routes: string[] = []
		w.behaviors.build = (w2, t) => {
			if (t.job.issueId === bad) {
				w2.fail(bad, 'build', 'build-failure', 'build-failure tsc TS2322 in src/x.ts')
				w2.set(bad, { state: S.ready })
				return
			}
			happyBuilder(w2, t, '')
		}
		w.behaviors.resolve = (w2, t) => {
			routes.push(t.inbox.at(-1)!.match(/Controller directive \(([a-z-]+)\)/)?.[1] ?? '?')
			w2.fail(bad, 'resolve', 'unknown', 'resolver could not fix tsc TS2322')
		}
		await w.cycle(30)
		expect(w.get(good).status).toBe(S.done)
		expect(w.get(bad).status).not.toBe(S.done)
		expect(w.get(bad).labels).toContain(L.waiting)
		expect(routes).toContain('resolve')
		expect(routes).toContain('resolve-replan')
		const resolutions = Object.values(w.ledger!.resolutions).filter((r) => r.issueId === bad)
		expect(resolutions.find((r) => r.stage === 'build')!.count).toBe(3)
		expect(resolutions.find((r) => r.stage === 'resolve')!.count).toBe(3)
		// bounded: never more than one resolver at a time and a finite number overall
		expect(w.ledger!.attempts[`resolve:${bad}`]).toBeLessThanOrEqual(4)
		expect(w.get(idea).status).toBe(S.active)
		// after the cooldown the issue gets a fresh resolver diagnosis automatically
		w.now += config.timing.cooldownMs
		const before = w.ledger!.attempts[`resolve:${bad}`]
		await w.cycle(2)
		expect(w.ledger!.attempts[`resolve:${bad}`]).toBe(before + 1)
	})

	test('external dependency failure waits with backoff and resumes automatically', async () => {
		const w = new World()
		happy(w)
		let calls = 0
		w.behaviors.build = (w2, t) => {
			calls++
			if (calls === 1) {
				w2.fail(t.job.issueId, 'build', 'dependency', 'dependency npm registry 503')
				w2.set(t.job.issueId, { state: S.ready })
				return
			}
			happyBuilder(w2, t, '')
		}
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const b = w.add('build', S.ready, [L.build], idea)
		w.add('t', S.ready, [L.test], b)
		await w.cycle(3)
		expect(w.get(b).labels).toContain(L.waiting)
		await w.cycle(2)
		expect(calls).toBe(1) // still backing off (5 minutes)
		w.now += config.timing.dependencyBackoffBaseMs
		await w.cycle(8)
		expect(calls).toBe(2)
		expect(w.get(b).status).toBe(S.done)
	})

	test('stale worker is nudged once, then its stage is retried by a new worker', async () => {
		const w = new World()
		let builderTurns = 0
		w.behaviors = {
			build: (w2, t) => {
				builderTurns++
				if (t.job.attempt >= 2) happyBuilder(w2, t, '')
			},
		}
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const b = w.add('build', S.ready, [L.build], idea)
		await w.cycle(1)
		expect(w.get(b).status).toBe(S.active)
		await w.cycle(6) // idle for > staleAfterIdleMs -> nudge
		expect(builderTurns).toBe(2)
		await w.cycle(20) // nudge grace elapses -> stale failure -> retry -> attempt 2 succeeds
		expect(w.get(b).status).toBe(S.active)
		expect(w.get(b).labels).toContain(L.built)
		expect(w.ledger!.attempts[`build:${b}`]).toBe(2)
		expect(w.get(b).comments.some((c) => c.body.includes('"kind":"stale"'))).toBe(true)
	})

	test('dispatch is idempotent across repeated ticks and a crash between claim and thread creation', async () => {
		const w = new World()
		w.behaviors = {}
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const b = w.add('build', S.ready, [L.build], idea)
		w.failCreateOnce = true
		const r1 = await tick(w.ports())
		expect(r1.errors.length).toBe(1)
		expect(w.ledger!.jobs[`build:${b}:1`].phase).toBe('claimed')
		await tick(w.ports())
		await tick(w.ports())
		await tick(w.ports())
		expect(w.createdThreads).toBe(1)
		expect(jobsNow(w)).toEqual([`build:${b}:1`])
		expect(w.get(b).comments.filter((c) => c.body.includes('lsf-dispatch')).length).toBe(1)
		// the attempt recorded at claim time survives the failed first try
		expect(w.ledger!.attempts[`build:${b}`]).toBe(1)
	})

	test('a lost ledger adopts a live worker instead of starting a duplicate', async () => {
		const w = new World()
		w.behaviors = {}
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const b = w.add('build', S.ready, [L.build], idea)
		await tick(w.ports())
		w.ledger = emptyLedger()
		await tick(w.ports())
		await tick(w.ports())
		expect(w.createdThreads).toBe(1)
		expect(jobsNow(w)).toEqual([`build:${b}:1`])
	})

	test('a build bounced to Backlog by another automation is picked up again', async () => {
		const w = new World()
		happy(w)
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const b = w.add('build', S.ready, [L.build], idea)
		w.add('t', S.ready, [L.test], b)
		await w.cycle(1)
		w.set(b, { state: S.intake, removeLabels: [L.built] }) // external actor moves it
		await w.cycle(10)
		expect(w.get(b).status).toBe(S.done)
		expect(w.get(idea).status).toBe(S.done)
	})

	test('finished work moved out of Done by another automation is not redone', async () => {
		const w = new World()
		happy(w)
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const b = w.add('build', S.ready, [L.build], idea)
		const t = w.add('t', S.ready, [L.test], b)
		const other = w.add('other build', S.ready, [L.build], idea)
		w.add('other test', S.ready, [L.test], other)
		w.behaviors.integrate = (w2, th) => {
			happyIntegrator(w2, th, '')
			if (th.job.issueId === b) {
				// the external automation bounces finished issues to Backlog
				w2.set(b, { state: S.intake })
				w2.set(t, { state: S.intake })
			}
		}
		await w.cycle(16)
		expect(w.ledger!.attempts[`build:${b}`]).toBe(1)
		expect(w.ledger!.attempts[`test:${t}`]).toBe(1)
		expect(w.ledger!.attempts[`integrate:${b}`]).toBe(1)
		expect(w.get(other).status).toBe(S.done)
		expect(w.get(idea).status).toBe(S.done)
		expect(w.get(idea).labels).toContain(L.delivered)
		w.set(idea, { state: S.intake })
		await w.cycle(3)
		expect(w.ledger!.attempts[`plan:${idea}`]).toBeUndefined()
	})

	test('a worker still running on work that another worker already finished is cancelled', async () => {
		const w = new World()
		w.behaviors = {}
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const b = w.add('build', S.ready, [L.build], idea)
		await w.cycle(1)
		const thread = [...w.threads.values()][0]
		thread.state = 'running'
		w.set(b, { state: S.done, addLabels: [L.integrated] })
		await tick(w.ports())
		expect(jobsNow(w)).toEqual([])
		expect(thread.state).toBe('idle')
		expect(w.ledger!.history.at(-1)!.outcome).toBe('superseded')
	})

	test('routing guard holds dispatch on a paid route, stops the offending worker, and resumes when clean', async () => {
		const w = new World()
		happy(w)
		const sub = 'Via [ChatGPT](https://ampcode.com/settings/model-routing#c-chatgpt)'
		w.routing = { connections: [{ id: 'c-chatgpt', type: 'model_provider_chatgpt', active: true, priority: 0 }], workerRoute: sub }
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		const a = w.add('a', S.ready, [L.build], idea)
		const b = w.add('b', S.ready, [L.build], idea)
		w.behaviors.build = () => {} // builders stay busy
		const r0 = await tick(w.ports())
		expect(r0.errors).toEqual([])
		expect(w.createdThreads).toBe(2)
		for (const t of w.threads.values()) t.state = 'running'
		// A worker's usage shows an Amp-served request, and an API key appears in routing.
		w.routing.workerRoute = 'Amp'
		w.routing.connections.push({ id: 'k', type: 'model_provider_openai', active: true, priority: 1 })
		const c = w.add('c', S.ready, [L.build], idea)
		const r = await tick(w.ports())
		expect(r.errors.some((e) => e.startsWith('routing guard:'))).toBe(true)
		expect(w.createdThreads).toBe(2) // c not dispatched
		w.routing.connections.pop()
		const r2 = await tick(w.ports())
		expect(r2.errors.join()).toContain('Amp')
		expect([...w.threads.values()].every((t) => t.state === 'idle')).toBe(true) // offending workers stopped
		expect(w.get(c).status).toBe(S.ready)
		// The violation keeps blocking while routing is unchanged, even if later reports look clean.
		w.routing.workerRoute = sub
		const still = await tick(w.ports())
		expect(still.errors.join()).toContain('until model routing changes')
		expect(w.createdThreads).toBe(2)
		// Model routing changes (the paid path is gone): dispatch resumes automatically.
		w.routing.connections = [{ id: 'c-chatgpt2', type: 'model_provider_chatgpt', active: true, priority: 0 }]
		w.routing.workerRoute = 'Via [ChatGPT](https://ampcode.com/settings/model-routing#c-chatgpt2)'
		const r3 = await tick(w.ports())
		expect(r3.errors).toEqual([])
		expect(w.createdThreads).toBe(3)
		expect(w.get(c).status).toBe(S.active)
		expect([a, b].every((id) => w.get(id).status === S.active)).toBe(true)
		// A thread a worker started (for example a subagent panel) is audited too.
		const worker = Object.values(w.ledger!.jobs).find((j) => j.issueId === c)!
		w.routing.children = { [worker.threadId!]: ['T-child-1'] }
		w.routing.childRoute = 'Amp'
		w.add('d', S.ready, [L.build], idea)
		const r4 = await tick(w.ports())
		expect(r4.errors.join()).toContain('child T-child-1')
		expect(r4.errors.join()).toContain(`stopped ${worker.key}`)
		expect(w.createdThreads).toBe(3)
	})

	test('routing audits stay inside the usage API budget and defer rather than fail on rate limits', async () => {
		const w = new World()
		w.behaviors = {}
		w.routing = { connections: [{ id: 'c-chatgpt', type: 'model_provider_chatgpt', active: true, priority: 0 }], workerRoute: 'Via [ChatGPT](https://ampcode.com/settings/model-routing#c-chatgpt)' }
		const ports = w.ports()
		let calls = 0
		let limited = false
		const usage = ports.routing!.usage
		ports.routing!.usage = async (id, range) => {
			calls++
			if (limited) throw new Error('Usage information is limited to 60 requests per hour.')
			return usage(id, range)
		}
		// History from before the guard existed audits lazily and never blocks work.
		w.ledger = emptyLedger()
		for (let i = 0; i < 25; i++) w.ledger.history.push({ key: `test:LOO-9${i}:1`, role: 'test', issueId: `LOO-9${i}`, threadId: `T-old-${i}`, outcome: 'reported', at: w.now - 3_600_000 })
		const idea = w.add('idea', S.active, [L.idea, L.planned])
		w.add('b', S.ready, [L.build], idea)
		for (let i = 0; i < 10; i++) {
			const r = await tick(ports)
			expect(r.errors).toEqual([])
			w.now += 60_000
		}
		expect(calls).toBeLessThanOrEqual(30)
		expect(w.createdThreads).toBe(1)
		// A rate-limited audit is deferred, not a violation; a gap that persists fails closed.
		limited = true
		w.now += 20 * 60_000
		expect((await tick(ports)).errors).toEqual([])
		w.now += 30 * 60_000
		expect((await tick(ports)).errors.join()).toContain('more than 45 minutes behind')
	})

	test('a hold label keeps the factory away from an issue', async () => {
		const w = new World()
		happy(w)
		const idea = w.add('parked idea', S.intake, [L.hold])
		await w.cycle(3)
		expect(w.get(idea).status).toBe(S.intake)
		expect(w.createdThreads).toBe(0)
	})
})
