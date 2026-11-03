import { expect, it } from 'vitest'
import { createPreparedPayload, type LLMStreamEvent } from '@i-harness/llm-seam'
import { ProjectionCounter } from '@i-harness/token-meter'
import { readSummaryStream } from '../src/summary/stream.ts'
function candidate(events: (LLMStreamEvent | Error)[]) {
  return createPreparedPayload({ request: { systemPrompt: '', messages: [], tools: [] }, body: {}, textOutput: () => ({ status: 'allowed', reason: 'ordinary-text' }),
    describe(body) { const c = new ProjectionCounter('projected-pricing-v2'); c.structured('otherInput', body); return { input: c.finish({ protocol: 'fixture', modelId: 'm' }, body, {}), packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } },
    output: () => ({ capSupport: 'supported', minimumCap: 1, source: 'request' }), cap: b => b,
    async *execute(_b, _s, _c, execution) { execution.confirm(); for (const e of events) { if (e instanceof Error) throw e; yield e } },
  })
}
const chunk = (text: string): LLMStreamEvent => ({ type: 'text/chunk', text })
it('counts exact trimmed code units without retaining surrounding unbounded whitespace', async () => {
  const r = await readSummaryStream(candidate([chunk(' '.repeat(1000000)), chunk('x\ud83d'), chunk('\ude00 \n'), chunk(' y'), chunk('\t'.repeat(1000000)), { type: 'end' }]), { maxRetainedChars: 7 })
  expect(r).toMatchObject({ text: 'x😀 \n y', chars: 7, overflow: false })
  expect(r.observation?.kind).toBe('summary-piece-accepted')
})
it('bounds oversized chunks and still observes terminal usage', async () => {
  const usage: unknown[] = []
  const r = await readSummaryStream(candidate([chunk('x'.repeat(1000000)), { type: 'usage', usage: { outputTokens: 42 } }, { type: 'end' }]), { maxRetainedChars: 16, onUsage: u => usage.push(u) })
  expect(r.text.length).toBeLessThanOrEqual(17)
  expect(r).toMatchObject({ chars: 1000000, overflow: true })
  expect(usage).toEqual([{ outputTokens: 42 }])
})
it.each([
  [{ type: 'tool_call', call: { id: 'c', name: 'read', args: {} } }, chunk('valid'), { type: 'usage', usage: { inputTokens: 2 } }, { type: 'end' }],
  [chunk('valid'), { type: 'end', refused: true }], [chunk('valid'), { type: 'end', truncated: true }], [chunk('valid')],
  [chunk('valid'), { type: 'end' }, { type: 'end', refused: true }], [chunk('valid'), { type: 'end' }, chunk('later')],
] as LLMStreamEvent[][])('rejects unsafe terminal/tool sequences and flushes usage', async (...events) => {
  const usage: unknown[] = []
  await expect(readSummaryStream(candidate([{ type: 'usage', usage: { outputTokens: 3 } }, ...events]), { maxRetainedChars: 100, onUsage: u => usage.push(u) })).rejects.toThrow()
  expect(usage).toHaveLength(1)
})
it('flushes already observed usage after cancellation', async () => {
  const controller = new AbortController(), reason = Error('cancelled'), usage: unknown[] = []
  const p = candidate([])
  const stream = { ...p, async *stream() { yield { type: 'usage' as const, usage: { outputTokens: 7 } }; controller.abort(reason); throw reason } }
  await expect(readSummaryStream(stream, { signal: controller.signal, maxRetainedChars: 10, onUsage: u => usage.push(u) })).rejects.toBe(reason)
  expect(usage).toEqual([{ outputTokens: 7 }])
})
it('accepts duplicate identical completion records', async () => {
  expect(await readSummaryStream(candidate([chunk('valid'), { type: 'end' }, { type: 'end' }]), { maxRetainedChars: 5 })).toMatchObject({ text: 'valid', chars: 5, overflow: false })
})
it('flushes usage after provider errors and preserves both callback and provider failure', async () => {
  const provider = Error('provider failed'), callback = Error('observation failed'), usage: unknown[] = []
  await expect(readSummaryStream(candidate([{ type: 'usage', usage: { inputTokens: 9 } }, provider]), { maxRetainedChars: 5, onUsage: u => usage.push(u) })).rejects.toBe(provider)
  expect(usage).toEqual([{ inputTokens: 9 }])
  try { await readSummaryStream(candidate([{ type: 'usage', usage: { inputTokens: 9 } }, provider]), { maxRetainedChars: 5, onUsage: () => { throw callback } }) } catch (e) {
    expect(e).toBeInstanceOf(AggregateError)
    expect((e as AggregateError).errors).toEqual([provider, callback])
    return
  }
  throw Error('expected both failures')
})
it('awaits a rejected observation delivery before accepting any checkpoint', async () => {
  const callback = Error('asynchronous observation failed'), rejected = Promise.reject(callback)
  void rejected.catch(() => {})
  await expect(readSummaryStream(candidate([{ type: 'usage', usage: { outputTokens: 7 } }, chunk('valid'), { type: 'end' }]), { maxRetainedChars: 5, onUsage: () => rejected })).rejects.toMatchObject({ errors: [callback], cause: callback })
})
