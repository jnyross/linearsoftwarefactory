import { describe, expect, test } from 'bun:test'
import { auditUsage, checkProviders, parseUsage } from './routing'

const CHATGPT = '92f1b1ff-eec6-473a-8ce2-31f84e032965'
const CLAUDE = '957584ec-38c7-47eb-aec4-5ff7b1eedac0'
const GROK = 'f61cc549-85bf-453e-bf82-48c419dfa525'
const live = [
	{ id: GROK, type: 'model_provider_xai_grok', active: true, priority: 0, config: {} },
	{ id: CLAUDE, type: 'model_provider_claude_sub', active: true, priority: 1, config: {} },
	{ id: CHATGPT, type: 'model_provider_chatgpt', active: true, priority: 2, config: {} },
]

// Captured from `amp threads usage T-01a18e79-3e6e-7375-9a9a-ab70b21da7cd --details` (a real integrator worker).
const workerReport = `## Credits

| Type | Cost |
| --- | ---: |
| Amp paid tier (covered) | $0.02 |

## Models

| Model | Requests | Input | Output | Amp cost | Est. list price |
| --- | ---: | ---: | ---: | ---: | ---: |
| GPT-6.1 Sol | 14 | 676,981 | 3,603 | $0 | $0.24 |

## Model Routing

| Model ID | Purpose | Routing | Requests | Cost |
| --- | --- | --- | ---: | ---: |
| openai/gpt-6.1-sol | Thread Title | Via [ChatGPT](https://ampcode.com/settings/model-routing#${CHATGPT}) | 2 | $0 |
| openai/gpt-6.1-sol | Agent | Via [ChatGPT](https://ampcode.com/settings/model-routing#${CHATGPT}) | 12 | $0 |

## Tools

| Tool | Requests | Cost |
| --- | ---: | ---: |
| Orb | 1 | $0.02 |
`

describe('routing guard', () => {
	test('the live connection set is subscription-only and serves the worker model', () => {
		const v = checkProviders(live)
		expect(v.ok).toBe(true)
		expect([...v.allowed].sort()).toEqual([CHATGPT, CLAUDE, GROK].sort())
	})

	test('an active API key or router blocks dispatch, even below the subscriptions', () => {
		const v = checkProviders([...live, { id: 'k1', type: 'model_provider_openai', active: true, priority: 3 }])
		expect(v.ok).toBe(false)
		expect(v.reason).toContain('model_provider_openai')
		expect(checkProviders([...live, { id: 'k1', type: 'model_provider_openai', active: false, priority: 3 }]).ok).toBe(true)
	})

	test('no active ChatGPT subscription blocks dispatch because Amp would serve the model', () => {
		expect(checkProviders(live.map((c) => (c.id === CHATGPT ? { ...c, active: false } : c))).ok).toBe(false)
	})

	test('a real worker report passes; orb cost is not model cost', () => {
		const { rows } = parseUsage(workerReport)
		expect(rows.map((r) => [r.purpose, r.connectionId, r.requests])).toEqual([
			['Thread Title', CHATGPT, 2],
			['Agent', CHATGPT, 12],
		])
		expect(auditUsage(workerReport, checkProviders(live).allowed)).toEqual([])
	})

	test('a request served by Amp credits or an unknown connection is a violation', () => {
		const amp = workerReport.replace(
			'| openai/gpt-6.1-sol | Agent | Via [ChatGPT]',
			'| openai/gpt-6.1-sol | Agent | Amp | 3 | $0.41 |\n| openai/gpt-6.1-sol | Agent | Via [ChatGPT]',
		).replace('| GPT-6.1 Sol | 14 | 676,981 | 3,603 | $0 |', '| GPT-6.1 Sol | 17 | 700,000 | 3,900 | $0.41 |')
		const bad = auditUsage(amp, checkProviders(live).allowed)
		expect(bad.length).toBe(1)
		expect(bad[0]).toContain('Amp')
		const other = workerReport.replaceAll(CHATGPT, '00000000-0000-0000-0000-000000000000')
		expect(auditUsage(other, checkProviders(live).allowed).length).toBe(2)
	})
})
