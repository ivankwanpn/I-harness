import { semanticPrefix } from '../src/accepted-calibration.ts'
import { expect, it } from 'vitest'
import { createAcceptedCalibration, ProjectionCounter } from '../src/index.ts'
import type { AcceptedRequestAttributionV1, ExchangeAcceptedEventV2 } from '@i-harness/core-session'
import { createOpenAIClient } from '../../llm-openai/src/index.ts'
const d = 'a'.repeat(64)
const compatibility = { ownerSessionId: 'owner', observationLifetimeId: 'live', executionEpochId: 'E', branchId: d, contextEpoch: d, projectionRevision: 0 }
function record(source: ReturnType<typeof createAcceptedCalibration>, input: ReturnType<ProjectionCounter['finish']>, usage: Parameters<typeof source.recordAccepted>[3]) {
  const request: AcceptedRequestAttributionV1 = { version: 1, ownerSessionId: 'owner', observationLifetimeId: 'live', candidateId: 'A', sendId: 'send1', semanticId: input.semanticIdentity!.semanticId, payloadId: d, payloadKind: 'http-json-body', executionEpochId: 'E', coldCompatible: false, snapshot: { semanticRevision: d, protectionRevision: d, branchId: d, contextEpoch: d, surfaceRevision: d }, projectionRevision: 0 }
  const accepted: ExchangeAcceptedEventV2 = { type: 'model/exchange-accepted', version: 2, seq: 3, exchangeId: 'exchange', actionId: 'action', attemptId: 'attempt', stepStartSeq: 1, assistantSeq: 2, callSeqs: [], request }
  const result = source.recordAccepted(input, request, accepted, usage)
  if (result.kind !== 'sample') throw Error(result.reason)
  return result.checkpoint
}
function input(tail = false, prefix = 'prefix', shape = 'shape') {
  const c = new ProjectionCounter('projected-pricing-v2'); c.text('system', 'system'); c.unit(prefix, 'user', () => c.text('visibleText', prefix))
  if (tail) c.unit('tail', 'assistant', () => { c.text('replayedReasoning', '思'.repeat(40000)); c.text('visibleText', 'answer') })
  return c.finish({ protocol: 'test', modelId: 'm' }, { prefix, tail }, shape)
}
const suffix = (next: ReturnType<typeof input>, count: number) => next.units.slice(count).reduce((n, u) => n + u.heuristicTokens, 0)

it('binds a Responses scalar input override to its own user message for calibration', async () => {
  const options: Record<string, unknown> = { input: 'short' }
  const client = createOpenAIClient({ apiKey: 'controlled', model: 'm', options })
  const request = { systemPrompt: 'p', tools: [], messages: [{ role: 'user' as const, content: 'ordinary message' }] }
  const prepare = async () => (await client.prepare!(request)).measurement.input
  const source = createAcceptedCalibration('owner', 'live')
  const first = await prepare()
  record(source, first, { inputTokens: 50, inputTokenSemantics: 'includes-cache' })
  expect(source.probe(await prepare(), compatibility)).toEqual({ tokens: 50, calibrated: true })
  options.input = 'longer replacement '.repeat(8000)
  const changed = await prepare()
  const estimate = source.probe(changed, compatibility)
  expect(estimate).toMatchObject({ calibrated: false, disposition: 'prefix-changed' })
  expect(estimate.tokens).toBeGreaterThan(40_000)
  expect(changed.units).toEqual([expect.objectContaining({ role: 'user', heuristicTokens: expect.any(Number) })])
  delete options.input
  const ordinary = await prepare()
  expect(source.probe(ordinary, compatibility)).toMatchObject({ calibrated: false, disposition: 'prefix-changed' })
  const reverse = createAcceptedCalibration('owner', 'live')
  record(reverse, ordinary, { inputTokens: 80, inputTokenSemantics: 'includes-cache' })
  expect(reverse.probe(first, compatibility)).toMatchObject({ calibrated: false, disposition: 'prefix-changed' })
})

it.each(['image', 'opaque'] as const)('tracks whether the accepted prefix covers every unpriced %s block', kind => {
  function project(tail: 'none' | 'text' | 'unpriced', options: { external?: boolean; fixed?: boolean; replacement?: string } = {}) {
    const counter = new ProjectionCounter('projected-pricing-v2')
    const unpriced = () => kind === 'image' ? counter.image('YQ==') : counter.opaque('opaque')
    if (options.fixed) unpriced()
    const prefix = options.replacement ?? 'original'
    counter.unit(prefix, 'user', unpriced)
    if (tail === 'text') counter.unit('later', 'user', () => counter.text('visibleText', 'later'))
    if (tail === 'unpriced') counter.unit('new attachment', 'user', unpriced)
    if (options.external) counter.uncertainties.add('external-image-token-cost')
    return counter.finish({ modelId: 'm', protocol: 'test' }, [prefix, tail], 'shape', [], options.external ? 'incomplete' : 'complete')
  }
  const first = project('none'), source = createAcceptedCalibration('owner', 'live')
  record(source, first, { inputTokens: 4321, cacheReadTokens: 3000, inputTokenSemantics: 'includes-cache', outputTokens: 50 })
  expect(source.probe(first, compatibility)).toMatchObject({ tokens: 4321, coversUnpricedUnits: true })
  const textTail = project('text')
  expect(source.probe(textTail, compatibility)).toMatchObject({ tokens: 4321 + suffix(textTail, 1), coversUnpricedUnits: true })
  expect(source.probe(project('unpriced'), compatibility)).not.toHaveProperty('coversUnpricedUnits')
  expect(source.probe(project('text', { replacement: 'different' }), compatibility)).not.toHaveProperty('coversUnpricedUnits')
  expect(source.probe(project('text', { external: true }), compatibility)).not.toHaveProperty('coversUnpricedUnits')
  expect(source.probe(project('text', { fixed: true }), compatibility)).not.toHaveProperty('coversUnpricedUnits')
  expect(source.probe(textTail, { ...compatibility, branchId: 'c'.repeat(64) })).not.toHaveProperty('coversUnpricedUnits')
  expect(createAcceptedCalibration('owner','new-lifetime').probe(textTail, compatibility)).not.toHaveProperty('coversUnpricedUnits')
})
it('keeps incident arithmetic as a synthetic live observation without cold continuity', () => {
  const first = input(), next = input(true), source = createAcceptedCalibration('owner', 'live')
  const checkpoint = record(source, first, { inputTokens: 162, cacheReadTokens: 760448, cacheCreationTokens: 0, inputTokenSemantics: 'excludes-cache', outputTokens: 587 })
  expect(checkpoint.reportedInputTokens).toBe(760610); expect(checkpoint.reportedOutputTokens).toBe(587)
  expect(source.probe(next, compatibility)).toEqual({ tokens: 760610 + suffix(next, first.units.length), calibrated: true })
  expect(JSON.parse(JSON.stringify(checkpoint)).request.coldCompatible).toBe(false)
  expect(createAcceptedCalibration('owner', 'cold').probe(next, { ...compatibility, observationLifetimeId: 'cold' }).calibrated).toBe(false)
})
it.each(['includes-cache','excludes-cache'] as const)('normalizes %s and persists scalar prefix facts', semantics => {
  const source = createAcceptedCalibration('owner', 'live'), first = input(), next = input(true)
  const checkpoint = record(source, first, { inputTokens: semantics === 'includes-cache' ? 1000 : 20, cacheReadTokens: 900, cacheCreationTokens: 80, inputTokenSemantics: semantics, outputTokens: 10 })
  expect(checkpoint.reportedInputTokens).toBe(1000); expect(checkpoint.prefixId).toBe(semanticPrefix(first))
  expect(JSON.stringify(checkpoint)).not.toMatch(/prefix"|units|思/)
  expect(source.probe(next, compatibility)).toEqual({ tokens: 1000 + suffix(next, first.units.length), calibrated: true })
})
it('rejects owner, lifetime, execution, branch, context, shape and prefix incompatibilities without probe mutation', () => {
  const source = createAcceptedCalibration('owner', 'live'), first = input()
  record(source, first, { inputTokens: 1000, inputTokenSemantics: 'includes-cache' })
  for (const key of ['ownerSessionId','observationLifetimeId','executionEpochId','branchId','contextEpoch'] as const) expect(source.probe(first, { ...compatibility, [key]: 'changed' }).calibrated).toBe(false)
  for (const next of [input(true,'changed'), input(true,'prefix','changed')]) expect(source.probe(next, compatibility).calibrated).toBe(false)
  expect(source.probe(first, { ...compatibility, projectionRevision: 1 }).calibrated).toBe(false)
  expect(source.probe(first, compatibility).calibrated).toBe(true)
})
it.each([true,false])('prices actual Responses replay and omits hidden output9000 (native=%s)', async replay => {
  const client = createOpenAIClient({ apiKey: 'controlled', model: 'm' })
  const request = { systemPrompt: 'p', tools: [], messages: [{ role: 'user' as const, content: 'first' }] }
  const first = (await client.prepare!(request)).measurement.input
  const next = (await client.prepare!({ ...request, messages: [...request.messages, { role: 'assistant', content: 'answer', toolCalls: [{ id: 'c', name: 'probe', args: { x: 1 } }], providerContinuation: { kind: 'openai-responses', model: replay ? 'm' : 'foreign', reasoningItems: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan' }], encrypted_content: 'cipher' }], outputOrder: [{ kind: 'reasoning', index: 0 }, { kind: 'tool', index: 0 }, { kind: 'text', text: 'answer' }] } }, { role: 'tool', toolCallId: 'c', content: 'result' }, { role: 'user', content: 'local tail' }] })).measurement.input
  expect(next.units.filter(u => u.role === 'assistant')).toHaveLength(replay ? 3 : 2)
  expect(next.components.opaqueContinuation.binaryBytes).toBe(replay ? 6 : 0)
  const source = createAcceptedCalibration('owner', 'live'), checkpoint = record(source, first, { inputTokens: 100, inputTokenSemantics: 'includes-cache', outputTokens: 9000 })
  expect(checkpoint.reportedOutputTokens).toBe(9000)
  expect(source.probe(next, compatibility)).toEqual({ tokens: 100 + suffix(next, first.units.length), calibrated: true })
})
