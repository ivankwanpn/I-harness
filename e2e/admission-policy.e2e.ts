import { afterEach, expect, it, vi } from 'vitest'
import { corpusRoutes } from './fixtures/context-corpus.ts'
import { installTransport, makeClient } from './fixtures/context-transports.ts'
import { resolveEffectiveModelContextEvidence } from '../packages/provider/src/index.ts'
import { prepareModelRequest } from '../packages/llm-seam/src/index.ts'
import { assessPreparedCapacity } from '../packages/context-engine/src/index.ts'
vi.mock('../packages/http-transport/src/index.ts', async importOriginal => ({ ...await importOriginal<object>(), systemFetch: vi.fn(() => { throw Error('network denied') }) }))
vi.mock('../packages/http-transport/src/system-fetch.ts', () => ({ systemFetch: vi.fn(() => { throw Error('network denied') }) }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks() })

it.each(corpusRoutes)('uses the same selected decision and actual optional/catalog intent on %s', async route => {
  const transport = installTransport(route), client = makeClient(route, transport)
  for (const stored of [false, true]) {
    const evidence = resolveEffectiveModelContextEvidence({ profile: { name: 'fixture', displayName: 'fixture', protocol: 'gemini', catalog: 'gemini' }, modelId: 'gemini-2.5-pro', ...(stored ? { userModel: { maxTokens: 65536 } } : {}) })!
    expect(evidence.limits.outputTokens?.value).toBe(65536)
    expect(evidence.maxOutputTokens).toBe(stored ? 65536 : undefined)
    const a = await prepareModelRequest(client, { systemPrompt: 'policy', tools: [], messages: [{ role: 'user', content: 'selected local input' }], ...(evidence.maxOutputTokens === undefined ? {} : { maxOutputTokens: evidence.maxOutputTokens }) })
    if (route === 'anthropic' && !stored) expect(a.measurement.output.effectiveCap).toBe(128000)
    const priorCaptures = transport.captures.length, priorAuth = transport.authCalls()
    const selected = assessPreparedCapacity(a, { purpose: 'main', contextWindow: 1000000, outputCeiling: evidence.limits.outputTokens!.value })
    expect(selected.decision.disposition).toBe('compatibility')
    expect(selected.decision.pressure).toMatchObject({ basis: 'legacy-shared-assumption' })
    expect(transport.captures).toHaveLength(priorCaptures); expect(transport.authCalls()).toBe(priorAuth)
    for await (const _event of selected.prepared.stream()) { /* actual terminal through synthetic transport */ }
    const body = transport.captures.at(-1)!.body
    const cap = route === 'responses' || route === 'subscription' ? body.max_output_tokens : route === 'gemini' ? body.generationConfig?.maxOutputTokens : route === 'bedrock' ? body.inferenceConfig?.maxTokens : body.max_tokens ?? body.max_completion_tokens
    expect(cap).toBe(route === 'subscription' ? undefined : stored || route === 'anthropic' ? 65536 : undefined)
  }
})

it.each([1000, 1010])('reprices actual Messages B once after protocol-valid A128000 (final I=%s)', async finalInput => {
  const transport = installTransport('anthropic'), client = makeClient('anthropic', transport, { options: { thinking: { type: 'enabled', budget_tokens: 1024 } } })
  const a = await prepareModelRequest(client, { systemPrompt: 'policy', tools: [], reasoningEffort: 'low', messages: [{ role: 'user', content: 'local source' }] })
  expect(a.measurement.output).toMatchObject({ effectiveCap: 128000, minimumCap: 1025 })
  expect(a.validation?.status).not.toBe('invalid')
  let probes = 0
  const selected = assessPreparedCapacity(a, { purpose: 'main', contextWindow: 10000, outputCeiling: 8192 }, () => ({ tokens: ++probes === 1 ? 1000 : finalInput, calibrated: false }))
  expect(probes).toBe(2); expect(selected.prepared.measurement.output.effectiveCap).toBe(8000)
  expect(selected.decision.pressure).toMatchObject({ inputBudget: 1000, input: finalInput, hardFits: finalInput === 1000 })
  expect(selected.decision.disposition).toBe(finalInput === 1000 ? 'compatibility' : 'reduce')
  expect(transport.captures).toEqual([]); expect(transport.authCalls()).toBe(0)
})
