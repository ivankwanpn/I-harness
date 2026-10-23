import { expect, it } from 'vitest'
import { consumeRetryFailure, createRetryingClient, resolveRetryPolicy } from '../src/index.ts'
it.each([new Error('private original'), undefined])('only the original waiting event carries a once-consumed failure (%s)', async failure => {
  const client = createRetryingClient({ async *stream() { throw failure } }, resolveRetryPolicy({ mode: 'always', backoff: { initialDelayMs: 1 } }))
  for await (const event of client.stream({ messages: [], tools: [], systemPrompt: '', retryOutput: 'discard' })) {
    if (event.type !== 'retry') continue
    expect(JSON.stringify(event)).not.toContain('private original')
    expect(Object.keys(event).sort()).toEqual(['retry', 'type'])
    expect(consumeRetryFailure({ ...event })).toBeUndefined()
    const record = consumeRetryFailure(event)
    expect(record).toBeDefined(); expect(record!.failure).toBe(failure)
    expect(consumeRetryFailure(event)).toBeUndefined()
    break
  }
})
