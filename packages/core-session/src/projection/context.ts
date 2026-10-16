import type { SessionView as Session } from "../managed/types.ts"
import { validContextEvent, type ContextRecoveryFacts, type RequestBudgetSnapshot } from "../events/context.ts"

export function deriveContextRecovery(session: Session, ownerSessionId: string, binding?: { providerId?: string; modelId: string; protocol: string }): ContextRecoveryFacts | undefined {
  let current: ContextRecoveryFacts | undefined
  const recoveries = new Map<string, ContextRecoveryFacts>()
  for (const event of session.events) if (event.type === "context/recovery" && event.ownerSessionId === ownerSessionId && validContextEvent(event)) {
    const previous = recoveries.get(event.recoveryId)
    const folded = previous
      ? { ...previous, ...event, retryConsumed: previous.retryConsumed === true || previous.state === "retry-started" || event.retryConsumed === true || event.state === "retry-started" }
      : event
    // Keep the latest transition order when selecting among applicable lanes.
    recoveries.delete(event.recoveryId)
    recoveries.set(event.recoveryId, folded)
    current = folded
  }
  if (!binding) return current
  current = undefined
  const restriction = (facts: ContextRecoveryFacts) => facts.state === "resolved" ? 0 : facts.retryConsumed || facts.state === "retry-started" ? 2 : 1
  for (const folded of recoveries.values()) {
    // Legacy facts lacking a model tuple remain conservative. Ambiguous edits
    // to settings of the same tuple cannot clear known provider rejection.
    if (folded.modelId && folded.protocol) {
      // Losing or discovering provider metadata is ambiguous for the same
      // model/protocol. Only two known unequal providers establish a change.
      const providerChanged = !!folded.providerId && !!binding.providerId && folded.providerId !== binding.providerId
      if (folded.modelId !== binding.modelId || folded.protocol !== binding.protocol || providerChanged) continue
    }
    // Unknown provider identity can make several concrete lanes applicable.
    // Preserve the strongest applicable restriction: consumed unresolved,
    // unconsumed unresolved, then resolved. Recency only breaks equal ranks.
    if (current && restriction(current) > restriction(folded)) continue
    current = folded
  }
  return current
}
export function deriveContextBudget(session: Session, ownerSessionId: string): RequestBudgetSnapshot | undefined {
  let current: RequestBudgetSnapshot | undefined
  for (const event of session.events) if (event.type === "context/budget" && event.snapshot.ownerSessionId === ownerSessionId && validContextEvent(event)) current = event.snapshot
  return current
}
