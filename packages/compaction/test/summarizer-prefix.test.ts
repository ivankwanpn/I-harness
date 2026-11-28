import { expect, it } from 'vitest'
import { append, createSession, deriveMessages } from '@i-harness/core-session'
import { assessPreparedCapacity } from '@i-harness/context-engine'
import { prepareModelRequest } from '@i-harness/llm-seam'
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createCompactionHarness } from './fixtures/engine.ts'
import { closedExchange, spyModel, autoConfig, history } from './fixtures/history.ts'
import { checkpointOfLength, completeCheckpoint } from './fixtures/checkpoint.ts'

it('replays selected native bundles in exact order, excludes protected holes and appends a source manifest', async () => {
  const session = createSession(), f = spyModel()
  append(session, { type: 'turn/start' }); append(session, { type: 'user/message', text: 'H' })
  closedExchange(session, 'E1', 3000, true); closedExchange(session, 'E2', 3000, true)
  append(session, { type: 'user/message', text: 'steer' })
  closedExchange(session, 'E3', 3000, true); closedExchange(session, 'tail', 30)
  const before = deriveMessages(session)
  const result = await createCompactionHarness({ model: f.model, config: { ...autoConfig, contextWindow: 100000 }, requestShape: () => ({ systemPrompt: 'actual system', tools: [{ name: 'read', description: 'actual schema', inputSchema: { type: 'object' } }] }) }).compact(session)
  expect(result.compacted).toBe(true); expect(f.requests).toHaveLength(1)
  // A-04: dedicated summary request — no main system prompt, no main schemas.
  expect(f.requests[0]?.systemPrompt).toBe('')
  expect(f.requests[0]?.tools).toEqual([])
  expect(f.requests[0]?.messages.slice(1, -1)).toEqual(before.slice(1, 5))
  const directive = String(f.requests[0]!.messages.at(-1)!.content)
  expect(directive).toContain('<recorded-source-manifest>'); expect(directive).toContain('"authority":"observation"')
  expect(f.requests[0]!.messages[0]!.content).toContain('source-record framing')
  expect(JSON.stringify(f.requests[0]!.messages)).not.toContain('steer')
  expect(deriveMessages(session).map(message => message.content)).toContain(checkpointOfLength(600))
})
it.each([undefined, 5000] as const)('uses preferred 4096 summary output, bounded by inherited model ceiling %s', async maxOutputTokens => {
  const f = spyModel()
  expect((await createCompactionHarness({ model: f.model, maxOutputTokens, config: autoConfig }).compact(history())).compacted).toBe(true)
  expect(f.requests[0]?.maxOutputTokens).toBe(4096)
})
it('alternate summary client receives its own output/effort/window, with no main system or schemas', async () => {
  const main = spyModel(), summary = spyModel()
  expect((await createCompactionHarness({ model: main.model, maxOutputTokens: 100, reasoningEffort: 'high', config: { ...autoConfig, summarizationModel: summary.model, summaryLimits: { contextWindow: 100000, maxOutputTokens: 7000 }, summaryReasoningEffort: 'low' },
    requestShape: () => ({ systemPrompt: 'main-only system', tools: [{ name: 'main-only', description: '', inputSchema: {} }] }) }).compact(history())).compacted).toBe(true)
  expect(main.requests).toEqual([])
  expect(summary.requests[0]).toMatchObject({ systemPrompt: '', tools: [], maxOutputTokens: 4096, reasoningEffort: 'low' })
  expect(JSON.stringify(summary.requests[0])).not.toContain('main-only system')
})
it('reports reduced-over-target after reducing history under an oversized fixed system', async () => {
  const f = spyModel()
  const result = await createCompactionHarness({ model: f.model, config: autoConfig, requestShape: () => ({ systemPrompt: 'fixed '.repeat(14000), tools: [] }) }).compact(history())
  expect(result).toMatchObject({ compacted: true, outcome: 'reduced-over-target' })
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({ systemPrompt: '', tools: [] })
})

it('blocks a fixed system larger than the input window without calling a summarizer', async () => {
  const f = spyModel()
  const result = await createCompactionHarness({ model: f.model, config: autoConfig, requestShape: () => ({ systemPrompt: 'fixed '.repeat(14000), tools: [] }) }).compact(history(2, 10))
  expect(result).toMatchObject({ compacted: false, outcome: 'blocked', blockedReason: 'fixed-input' })
  expect(f.requests).toEqual([])
})

it('recovers a real overfull Messages request when fewer than 512 tokens of history can change', async () => {
  const model = createAnthropicClient({ model: 'fixture', apiKey: 'fixture', baseUrl: 'http://localhost.invalid' })
  const summary = spyModel(completeCheckpoint())
  const session = createSession(), systemPrompt = 'S'.repeat(7250), contextWindow = 3000, maxOutputTokens = 100
  append(session, { type: 'turn/start' })
  append(session, { type: 'user/message', text: 'Preserve this instruction.' })
  closedExchange(session, 'A', 350); closedExchange(session, 'B', 420); closedExchange(session, 'tail', 0)
  const measure = async () => {
    const prepared = await prepareModelRequest(model, { systemPrompt, messages: deriveMessages(session), maxOutputTokens, tools: [] })
    const { decision, estimate } = assessPreparedCapacity(prepared, { purpose: 'main', contextWindow })
    const fixed = prepared.measurement.input.components.system.heuristicTokens + prepared.measurement.input.components.toolSchemas.heuristicTokens
    expect(estimate.kind).toBe('estimated')
    return { decision, variable: estimate.kind === 'estimated' ? estimate.value - fixed : undefined }
  }
  const before = await measure()
  expect(before.decision.pressure).toMatchObject({ hardFits: false, inputBudget: 2600 })
  expect(before.variable).toBeLessThan(512)
  const result = await createCompactionHarness({ model, maxOutputTokens, requestShape: () => ({ systemPrompt, tools: [] }),
    config: { contextWindow, retainTokens: 0, prune: false, summarizationModel: summary.model, minSummaryChars: 64,
      summaryLimits: { contextWindow: 16000, maxOutputTokens: 4096 } } }).compact(session)
  expect(result).toMatchObject({ compacted: true, outcome: 'reduced-over-target' })
  expect(summary.requests).toHaveLength(1)
  expect((await measure()).decision.pressure).toMatchObject({ hardFits: true, targetReady: false })
  expect(deriveMessages(session).map(message => message.content)).toEqual(['Preserve this instruction.', completeCheckpoint(), 'tail '])
})
