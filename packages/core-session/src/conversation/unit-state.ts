import type { ConversationCall, ConversationUnitState } from './types.ts'

export interface UnitLifecycle {
  readonly ended: boolean
  readonly failed: boolean
  readonly suppressed: boolean
}

/** Lifecycle and recorded outcomes only; no execution or dispatch inference. */
export function physicalUnitState(step: UnitLifecycle, calls: readonly ConversationCall[]): ConversationUnitState {
  if (step.failed || step.suppressed && step.ended) return 'unresolved'
  if (!step.ended) return 'open'
  return calls.some(call => !call.result || call.outcome === 'pending' || call.outcome === 'unknown') ? 'unresolved' : 'closed'
}

/** A looked-up result reference is evidence, not proof this bundle consumed it. */
export function awaitingItemResults(item: {
  readonly calls: readonly ConversationCall[]
  readonly receivedResults: ReadonlySet<string>
}): boolean {
  return item.calls.some(call => call.result !== undefined && !item.receivedResults.has(call.result.id))
}

export function exchangeCompletion(item: {
  readonly step?: UnitLifecycle
  readonly calls: readonly ConversationCall[]
  readonly receivedResults: ReadonlySet<string>
}): ConversationUnitState {
  const state = physicalUnitState(item.step ?? { ended: true, failed: false, suppressed: false }, item.calls)
  return state === 'closed' && awaitingItemResults(item) ? 'unresolved' : state
}
