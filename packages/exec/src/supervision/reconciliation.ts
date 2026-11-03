import type { StopReason } from "@i-harness/sandbox"
import type { Entry, ExecutionReconciler, OwnerState } from "./contracts.ts"

interface ReconciliationOwner {
  ownerState(id: string): OwnerState
  entries(): Iterable<Entry>
  isDisposed(): boolean
  markStopped(entry: Entry, reason: StopReason, cause?: unknown): void
  drainAll(affected: readonly Entry[], operation: string): Promise<void>
}

export function createReconciliation({ ownerState, entries, isDisposed, markStopped, drainAll }: ReconciliationOwner) {
  function reconcile(owner: string, validateAuthority: ExecutionReconciler): Promise<void> {
    const state = ownerState(owner)
    const revision = ++state.revision
    state.blocked = true
    state.reconciles++
    const affected: Entry[] = []
    for (const entry of entries()) {
      if (entry.owner !== owner) continue
      entry.validateAuthority = policy => validateAuthority(policy, { phase: entry.preparing ? "preparing" : "active" })
      try { entry.validateAuthority(entry.policy) }
      catch (cause) { markStopped(entry, "authority-revoked", cause) }
      if (entry.stopReason || state.closed || isDisposed()) {
        markStopped(entry, entry.stopReason ?? "shutdown")
        affected.push(entry)
      }
    }
    const attempt = drainAll(affected, "Execution reconciliation").then(() => {
      if (state.revision === revision && !state.closed && !isDisposed()) state.blocked = false
    }).finally(() => { state.reconciles-- })
    void attempt.catch(() => {})
    return attempt
  }

  function closeOwner(owner: string): Promise<void> {
    const state = ownerState(owner)
    state.closed = true
    state.blocked = true
    state.revision++
    if (state.closeAttempt) return state.closeAttempt
    const affected = [...entries()].filter(entry => entry.owner === owner)
    affected.forEach(entry => markStopped(entry, "shutdown"))
    const attempt = drainAll(affected, "Execution owner close")
    state.closeAttempt = attempt
    void attempt.then(() => { state.closeAttempt = undefined }, () => { state.closeAttempt = undefined })
    return attempt
  }

  return { reconcile, closeOwner }
}
