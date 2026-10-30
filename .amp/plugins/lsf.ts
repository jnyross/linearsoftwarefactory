// @amp-agent-mode {"key":"lsf-worker","label":"lsf-worker"}
// Linear Software Factory controller plugin.
// Registers the lsf_tick tool only in the controller thread's orb. Linear is read and
// written through the thread's Linear MCP connection; workers are built-in-mode orb
// threads created through the plugin Agent API.

import type { PluginAPI, PluginThread } from '@ampcode/plugin'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tick, type Comment, type Ports } from '../../factory/controller'
import { config, type Issue, type Job, type Ledger, type ThreadState } from '../../factory/core'

export const description = 'Linear Software Factory controller: the lsf_tick tool reconciles Linear team LOO and dispatches planner, builder, tester, integrator and resolver orb threads.'

const STATE_DIR = process.env.LSF_STATE_DIR ?? join(homedir(), '.local', 'state', 'lsf')
const LEDGER = join(STATE_DIR, 'ledger.json')
const ISSUE_FIELDS = ['id', 'title', 'status', 'statusType', 'labels', 'parentId', 'createdAt']

type ToolCaller = { call(name: string, input: Record<string, unknown>): Promise<unknown> }

function mcpJson(result: unknown): any {
	const r = result as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }
	if (r?.structuredContent) return r.structuredContent
	const text = r?.content?.find((c) => c.type === 'text')?.text
	if (text === undefined) throw new Error('empty MCP result')
	return JSON.parse(text)
}

function toIssue(raw: any): Issue {
	return {
		id: raw.id,
		title: raw.title ?? '',
		status: raw.status,
		statusType: raw.statusType,
		labels: Array.isArray(raw.labels) ? raw.labels.map((l: any) => (typeof l === 'string' ? l : l.name)) : [],
		parentId: raw.parentId ?? null,
		blockedBy: raw.relations?.blockedBy?.map((b: any) => b.id) ?? undefined,
		createdAt: raw.createdAt,
	}
}

function linearPort(tools: ToolCaller) {
	const call = async (fn: string, input: Record<string, unknown>) => mcpJson(await tools.call(`linear.${fn}`, input))
	const listAll = async (input: Record<string, unknown>) => {
		const out: Issue[] = []
		let cursor: string | undefined
		do {
			const page = await call('list_issues', { ...input, team: config.team.id, fields: ISSUE_FIELDS, limit: 100, ...(cursor ? { cursor } : {}) })
			out.push(...(page.issues ?? []).map(toIssue))
			cursor = page.hasNextPage ? page.cursor ?? page.endCursor : undefined
		} while (cursor)
		return out
	}
	return {
		listByState: (state: string) => listAll({ state }),
		listChildren: (parentId: string) => listAll({ parentId }),
		getIssue: async (id: string, withRelations: boolean) => {
			try {
				return toIssue(await call('get_issue', { id, fields: withRelations ? [...ISSUE_FIELDS, 'relations'] : ISSUE_FIELDS }))
			} catch {
				return null
			}
		},
		listComments: async (issueId: string): Promise<Comment[]> => {
			const out: Comment[] = []
			let cursor: string | undefined
			do {
				const page = await call('list_comments', { issueId, limit: 100, ...(cursor ? { cursor } : {}) })
				out.push(...(page.comments ?? []).map((c: any) => ({ id: c.id, body: c.body ?? '', createdAt: c.createdAt })))
				cursor = page.hasNextPage ? page.cursor ?? page.endCursor : undefined
			} while (cursor)
			return out
		},
		update: async (id: string, patch: { state?: string; addLabels?: string[]; removeLabels?: string[] }) => {
			const input: Record<string, unknown> = { id }
			if (patch.state) input.state = patch.state
			if (patch.addLabels?.length) input.addLabels = patch.addLabels
			if (patch.removeLabels?.length) input.removeLabels = patch.removeLabels
			if (Object.keys(input).length > 1) await call('save_issue', input)
		},
		comment: async (issueId: string, body: string) => {
			await call('save_comment', { issueId, body })
		},
	}
}

async function run(args: string[]): Promise<string> {
	const p = Bun.spawn(['amp', ...args], { stdout: 'pipe', stderr: 'pipe' })
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
	if (code !== 0 || /^Error:/m.test(out)) throw new Error(`amp ${args[0]} ${args[1]} failed: ${(err || out).trim().slice(0, 300)}`)
	return out
}

function routingPort(tools: ToolCaller) {
	const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString()
	return {
		providers: async () => JSON.parse(await run(['config', 'model-providers', 'list', '--json'])),
		usage: (threadId: string, range?: { start: number; end: number }) =>
			run(['threads', 'usage', threadId, '--details', ...(range ? ['--start', iso(range.start), '--end', iso(range.end)] : [])]),
		children: async (threadId: string) => {
			const r = mcpJson(await tools.call('amp.find_thread', { query: `parent:${threadId}`, limit: 100 }))
			return ((r.threads ?? []) as Array<{ id: string }>).map((t) => t.id)
		},
	}
}

async function loadLedger(): Promise<Ledger | null> {
	try {
		return JSON.parse(await readFile(LEDGER, 'utf8'))
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw e
	}
}

async function saveLedger(ledger: Ledger) {
	await mkdir(STATE_DIR, { recursive: true, mode: 0o700 })
	const tmp = `${LEDGER}.${process.pid}.tmp`
	await writeFile(tmp, JSON.stringify(ledger, null, 1), { mode: 0o600 })
	await rename(tmp, LEDGER)
}

const WORKER_INSTRUCTIONS =
	'You are a Linear Software Factory worker. Follow the job message exactly: it names your role, the Linear transitions you own, your standing authority, and the failure protocol. Never ask questions or wait for a human. Do not create threads, open pull requests, or change Amp, billing, or model settings.'

export default function (amp: PluginAPI) {
	// Plugin agents spawned from a tool must be registered custom modes to run in orbs.
	// The model is pinned to an OpenAI model served by John's ChatGPT subscription, with no
	// premium serving features, because custom modes do not follow the Tune Modes preset.
	const worker = amp.createAgent({
		extends: 'medium',
		model: config.worker.model as `${string}/${string}`,
		reasoningEffort: config.worker.reasoningEffort as 'high',
		instructions: WORKER_INSTRUCTIONS,
		// Painter is an Amp-credit image model; create_thread would start unaudited model work.
		tools: { exclude: ['painter', 'create_thread'] },
		features: [],
		display: { label: 'lsf-worker', color: '#26B5CE' },
	})
	amp.registerAgentMode({
		key: 'lsf-worker',
		label: 'lsf-worker',
		description: 'Linear Software Factory worker (planner, builder, tester, integrator, resolver). Dispatched by the factory controller; not for manual use.',
		agent: worker.definition,
	})

	const controllerThreadId = config.controllerThreadId
	if (!controllerThreadId || process.env.AMP_THREAD_ID !== controllerThreadId) return
	const handles = new Map<string, PluginThread>()
	const handle = (id: string) => handles.get(id) ?? amp.threads.get(id as `T-${string}`)
	let running: Promise<string> | null = null

	const threads = {
		create: async (job: Job) => {
			const t = await worker.createThread({
				executor: 'orb',
				project: config.ampProject,
				parentThreadID: controllerThreadId as `T-${string}`,
				features: [],
			})
			handles.set(t.id, t)
			try {
				await t.setLabels(['lsf', `lsf-${job.role}`, job.issueId.toLowerCase()])
			} catch {}
			return t.id
		},
		append: async (id: string, text: string) => {
			await handle(id).append([{ type: 'user-message', content: text }])
		},
		state: async (id: string): Promise<ThreadState> => {
			try {
				return (await handle(id).state.get()) as ThreadState
			} catch (e) {
				const msg = String((e as Error).message ?? e)
				return /not found|404|does not exist/i.test(msg) ? 'missing' : 'unknown'
			}
		},
		cancel: async (id: string) => {
			await handle(id).cancel()
		},
		url: (id: string) => new URL(`/threads/${id}`, amp.system.ampURL).toString(),
	}

	amp.registerTool({
		name: 'lsf_tick',
		title: 'Factory tick',
		transcriptGroup: { active: 'Reconciling the factory', complete: 'Reconciled the factory' },
		description:
			'Run one Linear Software Factory controller tick: read Linear team LOO, route failures, dispatch or recover worker threads, and update Linear. Idempotent and safe to call repeatedly; concurrent calls share one run. Returns a one-line summary plus actions taken.',
		inputSchema: { type: 'object', properties: {} },
		async execute(_input, ctx) {
			if (ctx.thread.id !== controllerThreadId) throw new Error('lsf_tick runs only in the factory controller thread')
			if (running) return `A tick is already running; its result: ${await running}`
			const ports: Ports = {
				linear: linearPort(ctx.tools),
				routing: routingPort(ctx.tools),
				threads,
				store: { load: loadLedger, save: saveLedger },
				controllerThreadId,
				log: (line) => amp.logger.log(line),
			}
			running = tick(ports).then((r) => [r.summary, ...r.notes.map((n) => `- ${n}`), ...r.errors.map((e) => `! ${e}`)].join('\n'))
			try {
				return await running
			} finally {
				running = null
			}
		},
	})
}
