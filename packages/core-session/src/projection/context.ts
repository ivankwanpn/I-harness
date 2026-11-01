import type { SessionView as Session } from "../managed/types.ts"
import { validContextEvent, type ContextRecoveryFacts, type RequestBudgetSnapshot } from "../events/context.ts"
import type { RequestBudgetSnapshotV2 } from '../events/admission.ts'

export function deriveContextRecovery(session: Session, ownerSessionId: string, binding?: { providerId?: string; modelId: string; protocol: string }): ContextRecoveryFacts | undefined {
  const recoveries = new Map<string, ContextRecoveryFacts>()
  for (const event of session.events) if (event.type === "context/recovery" && event.ownerSessionId === ownerSessionId && validContextEvent(event)) {
    const previous = recoveries.get(event.recoveryId)
    const folded = previous
      ? { ...previous, ...event, retryConsumed: previous.retryConsumed === true || previous.state === "retry-started" || event.retryConsumed === true || event.state === "retry-started" }
      : event
    // Keep the latest transition order when selecting among applicable lanes.
    recoveries.delete(event.recoveryId)
    recoveries.set(event.recoveryId, folded)
  }
  return selectRecovery(recoveries, binding)
}
export function deriveContextBudget(session: Session, ownerSessionId: string): RequestBudgetSnapshot | RequestBudgetSnapshotV2 | undefined {
  let current: RequestBudgetSnapshot | RequestBudgetSnapshotV2 | undefined
  for (const event of session.events) if (event.type === "context/budget" && event.snapshot.ownerSessionId === ownerSessionId && validContextEvent(event)) current = event.snapshot
  return current
}

function selectRecovery(recoveries: ReadonlyMap<string, ContextRecoveryFacts>, binding?: {providerId?: string;modelId:string;protocol:string}): ContextRecoveryFacts | undefined {
  if (!binding) return [...recoveries.values()].at(-1)
  let current: ContextRecoveryFacts | undefined
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

/** Original incremental recovery/budget observation; no journal or send authority. */
export function createContextStateIndex() {
  const recoveries = new Map<string, Map<string, ContextRecoveryFacts>>()
  const budgets = new Map<string, RequestBudgetSnapshot | RequestBudgetSnapshotV2>()
  let revision = 0
  return {
    stage(events: readonly import('../managed/types.ts').SessionEventView[]) {
      const expected = revision, changed = new Map<string, Map<string, ContextRecoveryFacts>>(), nextBudgets = new Map<string, RequestBudgetSnapshot | RequestBudgetSnapshotV2>()
      for (const event of events) {
        if (event.type === 'context/recovery' && validContextEvent(event)) {
          let lane = changed.get(event.ownerSessionId)
          if (!lane) { lane = new Map(recoveries.get(event.ownerSessionId)); changed.set(event.ownerSessionId, lane) }
          const previous = lane.get(event.recoveryId)
          const folded = previous ? { ...previous, ...event, retryConsumed: previous.retryConsumed === true || previous.state === 'retry-started' || event.retryConsumed === true || event.state === 'retry-started' } : { ...event }
          lane.delete(event.recoveryId); lane.set(event.recoveryId, folded)
        }
        if (event.type === 'context/budget' && validContextEvent(event)) nextBudgets.set(event.snapshot.ownerSessionId, { ...event.snapshot })
      }
      let installed = false
      return { commit() { if (installed) return; if (revision !== expected) throw new Error('Stale context state suffix'); for (const [owner,lane] of changed) recoveries.set(owner,lane); for (const [owner,budget] of nextBudgets) budgets.set(owner,budget); revision++; installed=true } }
    },
    recovery(owner: string, binding?: {providerId?:string;modelId:string;protocol:string}) { return selectRecovery(recoveries.get(owner) ?? new Map(), binding) },
    budget(owner: string) { return budgets.get(owner) },
  }
}
