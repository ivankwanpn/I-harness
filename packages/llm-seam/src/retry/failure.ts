import type { LLMStreamEvent } from '../index.ts'
type WaitingEvent = Extract<LLMStreamEvent, { type: 'retry' }>
const failures = new WeakMap<WaitingEvent, Readonly<{ failure: unknown }>>()
/** Retry-owner-only attachment. Neither serialization nor copied events carry
 * the original error; this is diagnostic identity, never execution authority. */
export function retainRetryFailure(event: WaitingEvent, failure: unknown): WaitingEvent {
  failures.set(event, Object.freeze({ failure }))
  return event
}
/** Consume once. A present record distinguishes thrown undefined from absence. */
export function consumeRetryFailure(event: WaitingEvent): Readonly<{ failure: unknown }> | undefined {
  const record = failures.get(event)
  failures.delete(event)
  return record
}
