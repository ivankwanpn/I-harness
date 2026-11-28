import { readContextCoordinates } from "@i-harness/context-engine"
import { contextStateFromBudget, contextStateFromObservation, deriveContextBudget, deriveContextRecovery, isConversationBudget, validProviderReportedUsage, wasContextBudgetRewritten, type ContextBindingMetadata, type RequestBudgetSnapshot, type SessionView as Session, type SessionContextState } from "@i-harness/core-session"
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

function matchesDisplayBinding(state: SessionContextState, binding?: DisplayBinding): SessionContextState {
  const budget = state.observation
  if (!budget || !binding) return state
  // Hosts without a physical projection record "custom"/"unknown" even
  // when their configuration can identify a model. Those placeholders cannot
  // establish that the selected model changed.
  const identifiesModel = !(budget.protocol === 'custom' && budget.modelId === 'unknown')
  if (identifiesModel && (binding.modelId !== budget.modelId || binding.protocol !== budget.protocol) ||
    binding.providerId !== undefined && budget.providerId !== undefined && binding.providerId !== budget.providerId ||
    binding.identityCoverage === 'complete' && budget.identityCoverage === 'complete' &&
      binding.bindingConfigFingerprint !== undefined && budget.bindingConfigFingerprint !== undefined &&
      binding.bindingConfigFingerprint !== budget.bindingConfigFingerprint) {
    return { kind: 'unavailable', reason: 'Model context binding changed since the last prepared budget' }
  }
  return state
}

function historicalState({ budget, recovery, budgetSupersededByRewrite }: SavedContextFacts, matchingCoordinates = false): SessionContextState {
  if (!budget) return { kind: "unavailable", reason: "No saved prepared budget is available" }
  if (budgetSupersededByRewrite) return { kind: 'unavailable', reason: 'Conversation history changed since the last prepared budget' }
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

function withReportedInput(state: SessionContextState, { budget, lastReportedInputTokens, lastReportedUsage }: SavedContextFacts, binding?: DisplayBinding): SessionContextState {
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
  return { ...state, lastReportedInputTokens, ...(validProviderReportedUsage(lastReportedUsage, lastReportedInputTokens) ? { lastReportedUsage: { ...lastReportedUsage } } : {}) }
}

/** Recheck live owners after each awaited read. A persisted observation can
 * describe prior usage, but only a live assessment can confirm current fit. */
export function createContextStateReader<Meta>(readers: ContextStateReaders<Meta>) {
  return async (sessionId: string): Promise<SessionContextState> => {
    const current = () => {
      readers.assertOpen()
      const live = readers.live(sessionId)
      return live?.observation && !isConversationBudget(live.observation) ? undefined : live
    }
    const currentOrThrow = (cause: unknown): SessionContextState => {
      const active = current()
      if (active) return active
      throw cause
    }
    const done = (state: SessionContextState) => !state.observation || state.observation.freshness === 'current' ||
      !readers.metadata && (!readers.readSavedContext || !canObserveReportedInput(state))
    let live = current()
    if (live && done(live)) return live
    let meta: Meta | undefined
    try { meta = await readers.meta(sessionId) } catch (cause) { return currentOrThrow(cause) }
    live = current()
    if (live && done(live)) return live

    let session: Session | undefined
    if (!readers.readSavedContext && !live) {
      session = await readers.snapshot(sessionId)
      live = current()
      if (live && done(live)) return live
    }
    let configured: ContextBindingMetadata | undefined
    try { configured = await readers.metadata?.(sessionId, meta) } catch (cause) { return currentOrThrow(cause) }
    live = current()
    if (live && (done(live) || !readers.readSavedContext || configured?.identityCoverage !== 'complete' || !canObserveReportedInput(live))) return matchesDisplayBinding(live, configured)
    // Keep recovery selection and legacy coordinate comparison on the same
    // model configuration even if the host changes it during the store read.
    const metadata = configured && captureDisplayBinding(configured)
    if (readers.readSavedContext) {
      let facts: SavedContextFacts
      try { facts = await readers.readSavedContext(sessionId, metadata) }
      catch (cause) { return currentOrThrow(cause) }
      live = current()
      let displayBinding = metadata
      if ((facts.budget?.version === 2 || live?.observation) && readers.metadata && (!live || !done(live))) {
        // A model selector or provider setting may have changed while the
        // persisted prefix was being read. Recheck without resolving a client.
        try {
          const latestMeta = await readers.meta(sessionId)
          live = current()
          if (live && done(live)) return live
          const latest = await readers.metadata(sessionId, latestMeta)
          displayBinding = latest && captureDisplayBinding(latest)
        } catch { displayBinding = undefined }
        live = current()
      }
      if (live) return matchesDisplayBinding(withReportedInput(live, facts, displayBinding), displayBinding ?? metadata)
      if (!needsLegacyCoordinates(facts, metadata)) return matchesDisplayBinding(withReportedInput(historicalState(facts), facts, displayBinding), displayBinding ?? metadata)
      session = await readers.snapshot(sessionId)
      live = current()
      if (live) return live
    }

    const budget = session && deriveContextBudget(session, sessionId, 'conversation')
    const recovery = session && budget && deriveContextRecovery(session, sessionId, metadata ?? budget)
    const facts = { budget, recovery, ...(session && budget?.version === 2 && wasContextBudgetRewritten(session.events, budget) ? { budgetSupersededByRewrite: true as const } : {}) }
    return matchesDisplayBinding(historicalState(facts, !!session && budget?.version === 1 && needsLegacyCoordinates(facts, metadata) && matchesCoordinates(session, sessionId, budget)), metadata)
  }
}
