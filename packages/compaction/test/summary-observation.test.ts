import { expect, it } from 'vitest'
import { createPreparedPayload, type ModelClient } from '@i-harness/llm-seam'
import { ProjectionCounter } from '@i-harness/token-meter'
import { summarizeWithModel } from '../src/summarizer.ts'
import { createCompactionEngine } from '../src/index.ts'
import { append, createSession } from '@i-harness/core-session'
function model(corrupt: boolean | 'conflicting-end' = false): ModelClient {
  return { async *stream() { throw Error('unprepared') }, async prepare(request) {
    return createPreparedPayload({ request, body: { messages: request.messages }, describe(body) { const c = new ProjectionCounter('projected-pricing-v2'); c.structured('otherInput', body); return { input: c.finish({ protocol: 'fixture', modelId: 'm' }, body, {}), packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } }, output: () => ({ capSupport: 'supported', effectiveCap: 64, minimumCap: 1, source: 'request' }), cap: b => b,
      async *execute(_b, _s, _c, execution) { execution.confirm(); yield { type: 'text/chunk', text: 'complete summary' }; yield { type: 'end', ...(corrupt === 'conflicting-end' ? { refused: true } : {}) }; if (corrupt === 'conflicting-end') yield { type: 'end' }; else if (corrupt) yield { type: 'text/chunk', text: 'corrupt after completion' } },
    })
  } }
}
it('records only an ephemeral piece observation after complete quality checks', async () => {
  const observations: any[] = []
  const result = await summarizeWithModel(model(), 'recorded input', 64, undefined, undefined, 1, undefined, undefined, { maxOutputTokens: 64, onPieceAccepted: (o: any) => observations.push(o) } as any)
  expect(result.text).toBe('complete summary')
  expect(observations).toHaveLength(1)
  expect(observations[0]).toMatchObject({ kind: 'summary-piece-accepted', purpose: 'summary', origin: 'piece', receipt: { candidateId: expect.any(String), sendId: expect.any(String) } })
  expect(JSON.stringify(observations)).not.toMatch(/exchange-accepted|acceptedSeq|anchorId/)
})
it('keeps a successful piece observation when actual final transaction flush fails', async () => {
  const session = createSession(), observations: unknown[] = []
  append(session, { type: 'user/message', text: 'recorded completed work '.repeat(40) })
  const engine = createCompactionEngine({ model: model(), config: { contextWindow: 100000, minSummaryChars: 1, retainTokens: 0, prune: false, summaryMaxOutputTokens: 64 }, telemetry: { emit(e) { if (e.type === 'provider/context' && e.data.operation === 'summary-piece-accepted') observations.push(e.data) }, close() {} }, flush: async () => { if (session.events.some(e => e.type === 'compaction/summary')) throw Error('transaction publication failed') } })
  await expect(engine.compact(session)).rejects.toThrow('transaction publication failed')
  expect(observations).toHaveLength(1)
  expect(session.events.some(e => e.type === 'model/exchange-accepted' || e.type === 'context/usage')).toBe(false)
})
it('does not accept post-end corruption as a complete piece', async () => {
  const accepted: unknown[] = []
  await expect(summarizeWithModel(model(true), 'input', 64, undefined, undefined, 1, undefined, undefined, { maxOutputTokens: 64, onPieceAccepted: (o: unknown) => accepted.push(o) } as any)).rejects.toThrow(/completion/)
  expect(accepted).toEqual([])
})
it('cannot clear an earlier refused completion with a contradictory clean end', async () => {
  const accepted: unknown[] = []
  await expect(summarizeWithModel(model('conflicting-end'), 'input', 64, undefined, undefined, 1, undefined, undefined, { maxOutputTokens: 64, onPieceAccepted: o => accepted.push(o) })).rejects.toThrow(/completion/)
  expect(accepted).toEqual([])
})
