// Subscription-only routing guard. The factory may dispatch model work only while every
// active model-provider connection is a subscription and the worker model is served by the
// ChatGPT subscription. Thread usage reports are audited so any request served by Amp
// credits or a non-subscription connection stops new dispatch until routing is clean again.

export const SUBSCRIPTION_TYPES = new Set([
	'model_provider_chatgpt',
	'model_provider_openai_chatgpt',
	'model_provider_claude_sub',
	'model_provider_xai_grok',
])
const CHATGPT_TYPES = new Set(['model_provider_chatgpt', 'model_provider_openai_chatgpt'])

export interface Connection {
	id: string
	type: string
	active: boolean
	priority: number
	config?: { modelMapping?: unknown } | Record<string, unknown>
}

export interface ProviderVerdict {
	ok: boolean
	reason?: string
	/** Connection IDs whose usage counts as subscription-served. */
	allowed: Set<string>
}

/** Static check of the routing table: no paid connection is active and ChatGPT serves the worker model. */
export function checkProviders(connections: Connection[]): ProviderVerdict {
	const active = connections.filter((c) => c.active)
	const allowed = new Set(active.filter((c) => SUBSCRIPTION_TYPES.has(c.type)).map((c) => c.id))
	const paid = active.filter((c) => !SUBSCRIPTION_TYPES.has(c.type))
	if (paid.length) return { ok: false, allowed, reason: `active non-subscription connection(s): ${paid.map((c) => `${c.type} ${c.id}`).join(', ')}` }
	const chatgpt = active.filter((c) => CHATGPT_TYPES.has(c.type))
	if (!chatgpt.length) return { ok: false, allowed, reason: 'no active ChatGPT subscription connection; the worker model would be served by Amp credits' }
	const mapped = chatgpt.filter((c) => {
		const m = (c.config as { modelMapping?: unknown } | undefined)?.modelMapping
		return m === undefined || m === null || m === '' || (Array.isArray(m) && m.length === 0) || String(m).includes('openai/')
	})
	if (!mapped.length) return { ok: false, allowed, reason: 'the ChatGPT connection has a custom model mapping that may exclude the worker model' }
	return { ok: true, allowed }
}

export interface UsageRow {
	model: string
	purpose: string
	routing: string
	connectionId: string | null
	requests: number
	cost: number
}

const money = (s: string) => Number(s.replace(/[$,\s]/g, '')) || 0

/** Parse the "## Model Routing" table of `amp threads usage --details`. */
export function parseUsage(markdown: string): { rows: UsageRow[]; modelCost: number } {
	const rows: UsageRow[] = []
	let section = ''
	let modelCost = 0
	for (const line of markdown.split('\n')) {
		if (line.startsWith('## ')) {
			section = line.slice(3).trim()
			continue
		}
		if (!line.startsWith('| ') || line.startsWith('| ---')) continue
		const cells = line.split('|').slice(1, -1).map((c) => c.trim())
		if (section === 'Model Routing' && cells[0] !== 'Model ID' && cells.length >= 5) {
			const id = /#([^)\s]+)\)/.exec(cells[2])?.[1] ?? null
			rows.push({ model: cells[0], purpose: cells[1], routing: cells[2], connectionId: id, requests: Number(cells[3].replace(/,/g, '')) || 0, cost: money(cells[4]) })
		}
		if (section === 'Models' && cells[0] !== 'Model' && cells.length >= 5) modelCost += money(cells[4])
	}
	return { rows, modelCost }
}

/** Violations: any model request not served by an allowed subscription connection, or any model cost in Amp credits. */
export function auditUsage(markdown: string, allowed: Set<string>): string[] {
	const { rows, modelCost } = parseUsage(markdown)
	const bad = rows.filter((r) => !r.connectionId || !allowed.has(r.connectionId) || r.cost > 0).map((r) => `${r.model} (${r.purpose}) routed ${r.routing.replace(/\]\(.*\)/, ']')} cost $${r.cost}`)
	if (modelCost > 0 && !bad.length) bad.push(`model usage cost $${modelCost} in Amp credits`)
	return bad
}
