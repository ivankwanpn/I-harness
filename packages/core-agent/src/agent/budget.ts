import { append, deriveContextRecovery, deriveContextUsage, type BudgetRead, type Session } from "@i-harness/core-session"
import { checkBudget, createContextMeter, type PreparedRequestMeasurement } from "@i-harness/token-meter"
import { readContextCoordinates } from "@i-harness/context-engine"
import { sameRequestCandidate, requestContextIdentity, type RequestEvidence } from "./request-snapshot.ts"
import { freezePreparedFacts, type PreparedModelRequest } from "@i-harness/llm-seam"

/** The only owner of prepared admission, pressure, calibration and scalar reads. */
export function createOwnedBudget(session: Session, ownerSessionId: string, freshness: () => RequestEvidence) {
  const calibration = createContextMeter({ ownerSessionId, restored: deriveContextUsage(session, ownerSessionId) })
  let latest: BudgetRead = { kind: "unavailable", reason: "No prepared request budget is available" }
  let bindingRevision = 0
  let captured: RequestEvidence | undefined
  let invalidated: string | undefined
  const historical = (reason: string): BudgetRead => latest.kind === "ready"
    ? { kind: "ready", snapshot: { ...latest.snapshot, admission: "unavailable", reason } } : latest
  return {
    ownerSessionId,
    invalidateCalibration() { calibration.invalidate() },
    invalidate() { calibration.invalidate(); invalidated = "Model context binding changed"; bindingRevision++ },
    read(reason?: string): BudgetRead {
      if (latest.kind !== "ready") return latest
      let unavailable = reason ?? invalidated
      if (!unavailable && captured && latest.snapshot.admission !== "unavailable") {
        try { if (!sameRequestCandidate(captured, freshness())) unavailable = "Model context or request surface/binding changed since the prepared budget" }
        catch { unavailable = "Current context capture is unavailable" }
      }
      // Observing a stale assessment makes it historical. Restoring a previous
      // surface cannot turn a read into a new admission certificate.
      if (unavailable) invalidated = unavailable
      const recovery = deriveContextRecovery(session, ownerSessionId, latest.snapshot)
      const recoveryRequired = recovery !== undefined && recovery.state !== "resolved"
      const read = unavailable ? historical(unavailable) : latest
      if (read.kind === "ready" && recoveryRequired) return { kind: "ready", snapshot: { ...read.snapshot, recoveryRequired: true, fullByProvider: true,
        admission: read.snapshot.admission === "unavailable" ? "unavailable" : "compact", reason: "Provider context recovery remains required" } }
      if (read.kind === "ready" && recovery?.state === "resolved" && read.snapshot.recoveryRequired) return { kind: "ready", snapshot: { ...read.snapshot, recoveryRequired: false, fullByProvider: false } }
      return read
    },
    pressure() {
      const read = this.read()
      return read.kind === "ready" && read.snapshot.admission !== "unavailable" ? read.snapshot.admissionInputTokens + read.snapshot.outputReserve + read.snapshot.safetyMargin : undefined
    },
    assess(prepared: PreparedModelRequest, evidence: RequestEvidence, window: number | undefined, configuredCap?: number, reserveRatio = .9, recoveryAuthorized = false, selectOutputCap = true) {
      let { input, output } = prepared.measurement
      const binding = evidence.metadata
      if (binding && input.coverage !== "neutral-only" && (binding.modelId !== input.modelId || binding.protocol !== input.protocol)) throw new Error("MODEL_BINDING_MISMATCH: prepared input does not match owned model binding")
      let estimate = calibration.estimate(input, binding, evidence.projectionRevision)
      const safetyMargin = window === undefined ? 0 : Math.ceil(window * (1 - reserveRatio))
      let available = window === undefined ? undefined : Math.max(0, window - safetyMargin - estimate.tokens)
      let ceiling = output.effectiveCap ?? output.configuredCap ?? configuredCap
      let candidate = prepared
      // Unknown/unsupported routes reserve honestly; only an explicit supported
      // derivative can claim an effective applied wire cap.
      if (selectOutputCap && (output.capSupport === "supported" || output.capSupport === "unknown" && input.coverage === "neutral-only") && ceiling !== undefined && available !== undefined && available >= output.minimumCap) candidate = prepared.withOutputCap(Math.min(ceiling, available))
      // One derivative selection, followed by the same owner's final estimate.
      // A changed semantic shape can retire a provisional legacy anchor here.
      ;({ input, output } = candidate.measurement)
      if (binding && input.coverage !== "neutral-only" && (binding.modelId !== input.modelId || binding.protocol !== input.protocol)) throw new Error("MODEL_BINDING_MISMATCH: selected input does not match owned model binding")
      estimate = calibration.estimate(input, binding, evidence.projectionRevision)
      available = window === undefined ? undefined : Math.max(0, window - safetyMargin - estimate.tokens)
      ceiling = output.effectiveCap ?? output.configuredCap ?? configuredCap
      const recovery = deriveContextRecovery(session, ownerSessionId, { ...input, providerId: binding?.providerId ?? input.providerId })
      const recoveryRequired = recovery !== undefined && recovery.state !== "resolved"
      const fullByProvider = recoveryRequired
      const cap = candidate.measurement.output.effectiveCap
      const outputReserve = ceiling === undefined ? 0 : output.capSupport === "supported" ? cap ?? ceiling : input.coverage === "neutral-only" ? candidate.measurement.output.configuredCap ?? ceiling : ceiling
      const incomplete = input.coverage === "incomplete"
      const unknownComponents = incomplete || input.uncertainties.some(reason => reason !== "route-output-floor-unverified")
      const unavailable = incomplete || window === undefined
      const fits = !unavailable && (!recoveryRequired || recoveryAuthorized) && checkBudget(session, window!, reserveRatio, 0, estimate.tokens + outputReserve).state === "ok" && (output.capSupport !== "supported" || available! >= output.minimumCap)
      const roleTokens = { user: 0, assistant: 0, tool: 0 }
      for (const unit of input.units) if (unit.role) roleTokens[unit.role] += unit.heuristicTokens
      const snapshot = { version: 1 as const, ownerSessionId, ...(binding?.providerId ?? input.providerId ? { providerId: binding?.providerId ?? input.providerId } : {}), modelId: input.modelId, protocol: input.protocol,
        bindingFingerprint: input.bindingFingerprint, bindingRevision, projectionRevision: evidence.projectionRevision, neutralFingerprint: evidence.neutralFingerprint, requestContext: requestContextIdentity(evidence),
        ...(binding?.bindingConfigFingerprint ? { bindingConfigFingerprint: binding.bindingConfigFingerprint } : {}), identityCoverage: binding?.identityCoverage ?? "partial" as const,
        estimatedInputTokens: estimate.tokens, admissionInputTokens: estimate.tokens, ...(window !== undefined ? { contextWindow: window } : {}),
        estimateSource: estimate.calibrated ? "provider-anchor-plus-projection" as const : input.coverage === "neutral-only" ? "neutral-only" as const : "projected-heuristic" as const,
        coverage: input.coverage, confidence: unknownComponents ? "unknown-components" as const : estimate.calibrated ? "calibrated-mixed" as const : "estimated" as const,
        roleTokens, systemTokens: input.components.system.heuristicTokens, schemaTokens: input.components.toolSchemas.heuristicTokens, reasoningTokens: input.components.replayedReasoning.heuristicTokens,
        outputReserve, ...(output.capSupport === "supported" && cap !== undefined ? { effectiveOutputCap: cap } : {}), capSupport: output.capSupport, safetyMargin,
        ...(available !== undefined ? { remainingInputBudget: Math.max(0, available - outputReserve) } : {}), admission: unavailable ? "unavailable" as const : fits ? "fit" as const : "compact" as const,
        recoveryRequired, fullByProvider, ...(unavailable ? { reason: incomplete ? "Prepared input includes unpriced fixed provider references" : "This model has no configured context window" } : recoveryRequired ? { reason: "Provider context recovery remains required" } : {}) }
      latest = { kind: "ready", snapshot: freezePreparedFacts(snapshot) }
      captured = evidence
      invalidated = undefined
      return { prepared: candidate, snapshot }
    },
    checkpoint() { if (latest.kind === "ready") append(session, { type: "context/budget", version: 1, snapshot: latest.snapshot }) },
    record(measurement: PreparedRequestMeasurement, usage: Parameters<typeof calibration.record>[2], requestRevision: number, accepted: boolean) {
      if (!accepted) { calibration.invalidate(); return }
      const checkpoint = calibration.record(measurement.input, captured?.metadata, usage, requestRevision)
      if (checkpoint) append(session, { type: "context/usage", version: 1, checkpoint })
      // Accepted provider output belongs to this owned attempt. A subsequent
      // local edit becomes unavailable until admission measures it again.
      let postResponseContextRevision: string | undefined
      try { const observation = readContextCoordinates(session, { ownerSessionId }); if (observation.kind === "available") postResponseContextRevision = observation.observationRevision } catch { /* Observation cannot revoke real usage. */ }
      if (latest.kind === "ready") {
        latest = { kind: "ready", snapshot: freezePreparedFacts({ ...latest.snapshot, ...(postResponseContextRevision ? { postResponseContextRevision } : {}), admission: "unavailable", reason: "Accepted output awaits the next protocol projection" }) }
        append(session, { type: "context/budget", version: 1, snapshot: latest.snapshot })
      }
    },
  }
}
