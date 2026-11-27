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
  if (budget.version === 2) return contextStateFromObservation({ ...budget, freshness: budget.freshness === "current" ? "stale" : budget.freshness, ...flags })
  const reason = recoveryRequired ? "Provider context recovery remains required"
    : budget.admission === "unavailable" && budget.reason ? budget.reason
    : matchingCoordinates ? "Saved prepared budget is historical; current request surface is unverified"
    : "Saved prepared budget is historical; current context/binding is unverified"
  return contextStateFromBudget({ kind: "ready", snapshot: { ...budget, admission: "unavailable", reason, ...flags } })
}

function canObserveReportedInput(state: SessionContextState): boolean {
  const observation = state.observation
  // A separate change can stale the live estimate before the accepted
  // response finishes. Its own measured input is still historical evidence.
  return observation?.purpose === 'main' && observation.freshness !== 'current' && observation.identityCoverage === 'complete' &&
    observation.bindingConfigFingerprint !== undefined && observation.selectedSemanticId !== undefined && observation.selectedPayloadId !== undefined
}

function withReportedInput(state: SessionContextState, { budget, lastReportedInputTokens }: SavedContextFacts, binding?: DisplayBinding): SessionContextState {
  if (budget?.version !== 2 || budget.purpose !== 'main' || budget.freshness !== 'awaiting-projection' ||
    lastReportedInputTokens === undefined || !Number.isSafeInteger(lastReportedInputTokens) || lastReportedInputTokens < 0 || !canObserveReportedInput(state)) return state
  if (binding?.identityCoverage !== 'complete' || binding.bindingConfigFingerprint === undefined ||
    budget.bindingConfigFingerprint !== binding.bindingConfigFingerprint || binding.providerId === undefined ||
    budget.providerId !== binding.providerId || budget.modelId !== binding.modelId || budget.protocol !== binding.protocol) return state
  const current = state.observation
  if (!current || current.ownerSessionId !== budget.ownerSessionId || current.providerId !== budget.providerId || current.modelId !== budget.modelId ||
    current.protocol !== budget.protocol || current.bindingConfigFingerprint !== budget.bindingConfigFingerprint || current.bindingFingerprint !== budget.bindingFingerprint ||
    current.bindingRevision !== budget.bindingRevision || current.projectionRevision !== budget.projectionRevision ||
    current.selectedSemanticId !== budget.selectedSemanticId || current.selectedPayloadId !== budget.selectedPayloadId ||
    current.neutralFingerprint !== budget.neutralFingerprint || current.requestContext.semanticRevision !== budget.requestContext.semanticRevision ||
    current.requestContext.protectionRevision !== budget.requestContext.protectionRevision || current.requestContext.branchId !== budget.requestContext.branchId ||
    current.requestContext.contextEpoch !== budget.requestContext.contextEpoch || current.requestContext.surfaceRevision !== budget.requestContext.surfaceRevision) return state
  return { ...state, lastReportedInputTokens }
}

/** Recheck live owners after each awaited read. A persisted observation can
 * describe prior usage, but only a live assessment can confirm current fit. */
export function createContextStateReader<Meta>(readers: ContextStateReaders<Meta>) {
  return async (sessionId: string): Promise<SessionContextState> => {
    const current = () => { readers.assertOpen(); return readers.live(sessionId) }
    const currentOrThrow = (cause: unknown): SessionContextState => {
      const active = current()
      if (active) return active
      throw cause
    }
    const done = (state: SessionContextState) => !readers.readSavedContext || !canObserveReportedInput(state)
    let live = current()
    if (live && done(live)) return live
    let meta: Meta | undefined
    try { meta = await readers.meta(sessionId) } catch (cause) { return currentOrThrow(cause) }
    live = current()
    if (live && done(live)) return live

    let session: Session | undefined
    if (!readers.readSavedContext) {
      session = await readers.snapshot(sessionId)
      live = current()
      if (live) return live
    }
    let configured: ContextBindingMetadata | undefined
    try { configured = await readers.metadata?.(sessionId, meta) } catch (cause) { return currentOrThrow(cause) }
    live = current()
    if (live && (done(live) || configured?.identityCoverage !== 'complete')) return live
    // Keep recovery selection and legacy coordinate comparison on the same
    // model configuration even if the host changes it during the store read.
    const metadata = configured && captureDisplayBinding(configured)
    if (readers.readSavedContext) {
      let facts: SavedContextFacts
      try { facts = await readers.readSavedContext(sessionId, metadata) }
      catch (cause) { return currentOrThrow(cause) }
      live = current()
      let displayBinding: DisplayBinding | undefined
      if (facts.lastReportedInputTokens !== undefined && readers.metadata && (!live || !done(live))) {
        // A model selector or provider setting may have changed while the
        // persisted prefix was being read. Recheck only for the optional
        // provider count, using the same cheap metadata read as before.
        try {
          const latestMeta = await readers.meta(sessionId)
          live = current()
          if (live && done(live)) return live
          const latest = await readers.metadata(sessionId, latestMeta)
          displayBinding = latest && captureDisplayBinding(latest)
        } catch { /* The optional count is unavailable when its binding cannot be rechecked. */ }
        live = current()
      }
      if (live) return withReportedInput(live, facts, displayBinding)
      if (!needsLegacyCoordinates(facts, metadata)) return withReportedInput(historicalState(facts), facts, displayBinding)
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
