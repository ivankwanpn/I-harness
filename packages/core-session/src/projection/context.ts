import type { Session } from "../events/types.ts"
import { validContextEvent, type ContextRecoveryFacts, type ContextUsageCheckpoint, type RequestBudgetSnapshot } from "../events/context.ts"

export function deriveContextRecovery(session: Session, ownerSessionId: string, binding?: { providerId?: string; modelId: string; protocol: string }): ContextRecoveryFacts | undefined {
  let current: ContextRecoveryFacts | undefined
  const recoveries = new Map<string, ContextRecoveryFacts>()
  for (const event of session.events) if (event.type === "context/recovery" && event.ownerSessionId === ownerSessionId && validContextEvent(event)) {
    const previous = recoveries.get(event.recoveryId)
    const folded = previous
      ? { ...previous, ...event, retryConsumed: previous.retryConsumed === true || previous.state === "retry-started" || event.retryConsumed === true || event.state === "retry-started" }
      : event
    recoveries.set(event.recoveryId, folded)
    // Legacy facts lacking a model tuple remain conservative. Ambiguous edits
    // to settings of the same tuple cannot clear known provider rejection.
    if (binding && folded.modelId && folded.protocol && (folded.modelId !== binding.modelId || folded.protocol !== binding.protocol || folded.providerId !== binding.providerId)) continue
    current = folded
  }
  return current
}
export function deriveContextBudget(session: Session, ownerSessionId: string): RequestBudgetSnapshot | undefined {
  let current: RequestBudgetSnapshot | undefined
  for (const event of session.events) if (event.type === "context/budget" && event.snapshot.ownerSessionId === ownerSessionId && validContextEvent(event)) current = event.snapshot
  return current
}
export function deriveContextUsage(session: Session, ownerSessionId: string): ContextUsageCheckpoint | undefined {
  let current: ContextUsageCheckpoint | undefined
  for (const event of session.events) if (event.type === "context/usage" && event.checkpoint.ownerSessionId === ownerSessionId && validContextEvent(event)) current = event.checkpoint
  return current
}
