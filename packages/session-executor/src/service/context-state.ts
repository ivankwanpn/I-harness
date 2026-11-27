import { readContextCoordinates } from "@i-harness/context-engine"
import { contextStateFromBudget, contextStateFromObservation, deriveContextBudget, deriveContextRecovery, type ContextBindingMetadata, type RequestBudgetSnapshot, type SessionView as Session, type SessionContextState } from "@i-harness/core-session"
import type { SavedContextFacts, SessionCoordinator } from "@i-harness/session-persistence"

interface ContextStateReaders<Meta> {
  assertOpen(): void
  live(sessionId: string): SessionContextState | undefined
  meta(sessionId: string): Promise<Meta | undefined>
  snapshot(sessionId: string): Promise<Session | undefined>
  readSavedContext?: SessionCoordinator["readSavedContext"]
  metadata?(sessionId: string, meta: Meta | undefined): ContextBindingMetadata | undefined | Promise<ContextBindingMetadata | undefined>
}

type DisplayBinding = Pick<ContextBindingMetadata, "providerId" | "modelId" | "protocol" | "identityCoverage" | "bindingConfigFingerprint" | "contextWindow">

function captureDisplayBinding(metadata: ContextBindingMetadata): DisplayBinding {
  const { providerId, modelId, protocol, identityCoverage, bindingConfigFingerprint, contextWindow } = metadata
  return { providerId, modelId, protocol, identityCoverage, bindingConfigFingerprint, contextWindow }
}

// V1 recorded the semantic coordinates separately. Only a matching binding
// with no more specific reason needs a full snapshot to explain its staleness.
function needsLegacyCoordinates({ budget, recovery }: SavedContextFacts, metadata?: DisplayBinding): boolean {
  return budget?.version === 1 && budget.requestContext !== undefined
    && !(budget.admission === "unavailable" && budget.reason) && (!recovery || recovery.state === "resolved")
    && metadata?.identityCoverage === "complete" && budget.identityCoverage === "complete" && metadata.bindingConfigFingerprint !== undefined
    && budget.bindingConfigFingerprint === metadata.bindingConfigFingerprint && budget.modelId === metadata.modelId
    && budget.protocol === metadata.protocol && budget.contextWindow === metadata.contextWindow
}

function matchesCoordinates(session: Session, sessionId: string, saved: RequestBudgetSnapshot): boolean {
  const coordinates = readContextCoordinates(session, { ownerSessionId: sessionId })
  const id = saved.requestContext
  return id !== undefined && coordinates.kind === "available"
    && id.semanticRevision === coordinates.coordinates.semanticRevision && id.protectionRevision === coordinates.coordinates.protectionRevision
    && id.branchId === coordinates.coordinates.branchId && id.contextEpoch === coordinates.coordinates.contextEpoch
}

function historicalState({ budget, recovery }: SavedContextFacts, matchingCoordinates = false): SessionContextState {
  if (!budget) return { kind: "unavailable", reason: "No saved prepared budget is available" }
  const recoveryRequired = recovery !== undefined && recovery.state !== "resolved"
  const flags = recoveryRequired ? { recoveryRequired: true, fullByProvider: true } : {}
  if (budget.version === 2) return contextStateFromObservation({
    ...budget, freshness: budget.freshness === "current" ? "stale" : budget.freshness, ...flags,
  })
  const reason = recoveryRequired ? "Provider context recovery remains required"
    : budget.admission === "unavailable" && budget.reason ? budget.reason
    : matchingCoordinates ? "Saved prepared budget is historical; current request surface is unverified"
    : "Saved prepared budget is historical; current context/binding is unverified"
  return contextStateFromBudget({ kind: "ready", snapshot: { ...budget, admission: "unavailable", reason, ...flags } })
}

/** Recheck live owners after each awaited read. A persisted observation can
 * describe prior usage, but only a live assessment can confirm current fit. */
export function createContextStateReader<Meta>(readers: ContextStateReaders<Meta>) {
  return async (sessionId: string): Promise<SessionContextState> => {
    const current = () => { readers.assertOpen(); return readers.live(sessionId) }
    let live = current()
    if (live) return live
    const meta = await readers.meta(sessionId)
    live = current()
    if (live) return live

    let session: Session | undefined
    if (!readers.readSavedContext) {
      session = await readers.snapshot(sessionId)
      live = current()
      if (live) return live
    }
    const configured = await readers.metadata?.(sessionId, meta)
    live = current()
    if (live) return live
    // Keep recovery selection and legacy coordinate comparison on the same
    // model configuration even if the host changes it during the store read.
    const metadata = configured && captureDisplayBinding(configured)
    if (readers.readSavedContext) {
      const facts = await readers.readSavedContext(sessionId, metadata)
      live = current()
      if (live) return live
      if (!needsLegacyCoordinates(facts, metadata)) return historicalState(facts)
      session = await readers.snapshot(sessionId)
      live = current()
      if (live) return live
    }

    const budget = session && deriveContextBudget(session, sessionId)
    const recovery = session && budget && deriveContextRecovery(session, sessionId, metadata ?? budget)
    const facts = { budget, recovery }
    return historicalState(facts, !!session && budget?.version === 1 && needsLegacyCoordinates(facts, metadata) && matchesCoordinates(session, sessionId, budget))
  }
}
