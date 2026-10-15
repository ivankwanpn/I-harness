import { readContextCoordinates } from "@i-harness/context-engine"
import { contextStateFromBudget, deriveContextBudget, deriveContextRecovery, type ContextBindingMetadata, type Session, type SessionContextState } from "@i-harness/core-session"

interface ContextStateReaders<Meta> {
  assertOpen(): void
  live(sessionId: string): SessionContextState | undefined
  meta(sessionId: string): Promise<Meta | undefined>
  snapshot(sessionId: string): Promise<Session | undefined>
  metadata?(sessionId: string, meta: Meta | undefined): ContextBindingMetadata | undefined | Promise<ContextBindingMetadata | undefined>
}

/** Read-only observation: no assembly, resolver, authentication or prepare port.
 * Recheck main and child owners after every cold await before using its result.
 */
export function createContextStateReader<Meta>(readers: ContextStateReaders<Meta>) {
  return async (sessionId: string): Promise<SessionContextState> => {
    readers.assertOpen()
    let live = readers.live(sessionId)
    if (live) return live
    const meta = await readers.meta(sessionId)
    readers.assertOpen(); live = readers.live(sessionId)
    if (live) return live
    const session = await readers.snapshot(sessionId)
    readers.assertOpen(); live = readers.live(sessionId)
    if (live) return live
    const metadata = await readers.metadata?.(sessionId, meta)
    readers.assertOpen(); live = readers.live(sessionId)
    if (live) return live
    const saved = session && deriveContextBudget(session, sessionId)
    if (!saved) return { kind: "unavailable", reason: "No saved prepared budget is available" }
    const coordinates = readContextCoordinates(session, { ownerSessionId: sessionId })
    const identity = saved.requestContext
    const sameCoordinates = coordinates.kind === "available" && identity !== undefined
      && identity.semanticRevision === coordinates.coordinates.semanticRevision && identity.protectionRevision === coordinates.coordinates.protectionRevision
      && identity.branchId === coordinates.coordinates.branchId && identity.contextEpoch === coordinates.coordinates.contextEpoch
    const sameBinding = metadata?.identityCoverage === "complete" && saved.identityCoverage === "complete" && metadata.bindingConfigFingerprint !== undefined
      && saved.bindingConfigFingerprint === metadata.bindingConfigFingerprint && saved.modelId === metadata.modelId && saved.protocol === metadata.protocol && saved.contextWindow === metadata.contextWindow
    // Metadata alone cannot prove the current system/schema/surface digest.
    // Preserve the measured input; only a new live assessment can restore fit.
    const reason = saved.admission === "unavailable" && saved.reason ? saved.reason
      : !sameCoordinates || !sameBinding ? "Saved prepared budget is historical; current context/binding is unverified"
      : "Saved prepared budget is historical; current request surface is unverified"
    const recovery = deriveContextRecovery(session, sessionId, metadata ?? saved)
    const recoveryRequired = recovery !== undefined && recovery.state !== "resolved"
    return contextStateFromBudget({ kind: "ready", snapshot: { ...saved, admission: "unavailable", reason: recoveryRequired ? "Provider context recovery remains required" : reason,
      ...(recoveryRequired ? { recoveryRequired: true, fullByProvider: true } : {}) } })
  }
}
