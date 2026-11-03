import { expect, it } from 'vitest'
import { append, createSession, deriveMessages } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'
import { closedExchange, spyModel, autoConfig, history } from './fixtures/history.ts'
import { checkpointOfLength } from './fixtures/checkpoint.ts'

it('replays selected native bundles in exact order, excludes protected holes and appends a source manifest', async () => {
  const session = createSession(), f = spyModel()
  append(session, { type: 'turn/start' }); append(session, { type: 'user/message', text: 'H' })
  closedExchange(session, 'E1', 3000, true); closedExchange(session, 'E2', 3000, true)
  append(session, { type: 'user/message', text: 'steer' })
  closedExchange(session, 'E3', 3000, true); closedExchange(session, 'tail', 30)
  const before = deriveMessages(session)
  const result = await createCompactionHarness({ model: f.model, config: { ...autoConfig, contextWindow: 100000 }, requestShape: () => ({ systemPrompt: 'actual system', tools: [{ name: 'read', description: 'actual schema', inputSchema: { type: 'object' } }] }) }).compact(session)
  expect(result.compacted).toBe(true); expect(f.requests).toHaveLength(1)
  expect(f.requests[0]?.systemPrompt).toBe('actual system')
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
it('charges actual fixed system before any summary generation instead of inventing an overhead discount', async () => {
  const f = spyModel()
  const result = await createCompactionHarness({ model: f.model, config: autoConfig, requestShape: () => ({ systemPrompt: 'fixed '.repeat(14000), tools: [] }) }).compact(history())
  expect(result).toMatchObject({ compacted: false, outcome: 'blocked', blockedReason: 'fixed-input' }); expect(f.requests).toEqual([])
})
