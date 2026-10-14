import { append, deriveContextRecovery, deriveContextUsage, deriveMessages, type BudgetRead, type ContextBindingMetadata, type Session } from "@i-harness/core-session"
import { checkBudget, createContextMeter, projectionFingerprint, type PreparedRequestMeasurement } from "@i-harness/token-meter"
import { freezePreparedFacts, type PreparedModelRequest } from "@i-harness/llm-seam"

/** The only owner of prepared admission, pressure, calibration and scalar reads. */
export function createOwnedBudget(session: Session, ownerSessionId: string, metadata: () => ContextBindingMetadata | undefined, revision: () => number,
  freshness: () => { surface: string; model: object; bindingIdentity?: object }) {
  const calibration = createContextMeter({ ownerSessionId, restored: deriveContextUsage(session, ownerSessionId) })
  let latest: BudgetRead = { kind: "unavailable", reason: "No prepared request budget is available" }
  let bindingRevision = 0
  let acceptedFingerprint: string | undefined
  let capturedFreshness: ReturnType<typeof freshness> | undefined
  const neutralFingerprint = () => projectionFingerprint(deriveMessages(session))
  return {
    ownerSessionId,
    invalidateCalibration() { calibration.invalidate() },
    invalidate() { calibration.invalidate(); latest = { kind: "unavailable", reason: "Model context binding changed" }; bindingRevision++ },
    read(): BudgetRead {
      if (latest.kind === "ready" && acceptedFingerprint !== undefined && neutralFingerprint() !== acceptedFingerprint) return { kind: "unavailable", reason: "Model-visible history changed since the prepared budget" }
      if (latest.kind === "ready" && latest.snapshot.projectionRevision !== revision()) return { kind: "unavailable", reason: "Projection revision changed since the prepared budget" }
      if (latest.kind === "ready" && latest.snapshot.bindingConfigFingerprint !== metadata()?.bindingConfigFingerprint) return { kind: "unavailable", reason: "Model configuration identity changed since the prepared budget" }
      if (latest.kind === "ready" && capturedFreshness) {
        const current = freshness()
        if (current.model !== capturedFreshness.model || current.bindingIdentity !== capturedFreshness.bindingIdentity) return { kind: "unavailable", reason: "Concrete model binding changed since the prepared budget" }
        if (current.surface !== capturedFreshness.surface) return { kind: "unavailable", reason: "Model request surface changed since the prepared budget" }
      }
      if (latest.kind === "ready") {
        const recovery = deriveContextRecovery(session, ownerSessionId, latest.snapshot)
        const recoveryRequired = recovery !== undefined && recovery.state !== "resolved"
        if (recoveryRequired) return { kind: "ready", snapshot: { ...latest.snapshot, recoveryRequired, fullByProvider: true, admission: "compact", reason: "Provider context recovery remains required" } }
        if (latest.snapshot.recoveryRequired) return { kind: "ready", snapshot: { ...latest.snapshot, recoveryRequired: false, fullByProvider: false } }
      }
      return latest
    },
    pressure() { return latest.kind === "ready" ? latest.snapshot.admissionInputTokens + latest.snapshot.outputReserve + latest.snapshot.safetyMargin : undefined },
    assess(prepared: PreparedModelRequest, window: number | undefined, configuredCap?: number, reserveRatio = .9, recoveryAuthorized = false) {
      const measurement = prepared.measurement, { input, output } = measurement, binding = metadata()
      if (binding && input.coverage !== "neutral-only" && (binding.modelId !== input.modelId || binding.protocol !== input.protocol)) throw new Error("MODEL_BINDING_MISMATCH: prepared input does not match owned model binding")
      const estimate = calibration.estimate(input, binding, revision())
      const recovery = deriveContextRecovery(session, ownerSessionId, { ...input, providerId: binding?.providerId ?? input.providerId })
      const recoveryRequired = recovery !== undefined && recovery.state !== "resolved"
      const fullByProvider = recoveryRequired
      const safetyMargin = window === undefined ? 0 : Math.ceil(window * (1 - reserveRatio))
      const available = window === undefined ? undefined : Math.max(0, window - safetyMargin - estimate.tokens)
      const ceiling = output.effectiveCap ?? output.configuredCap ?? configuredCap
      let candidate = prepared
      // Unknown/unsupported routes reserve honestly; only an explicit supported
      // derivative can claim an effective applied wire cap.
      if ((output.capSupport === "supported" || output.capSupport === "unknown" && input.coverage === "neutral-only") && ceiling !== undefined && available !== undefined && available >= output.minimumCap) candidate = prepared.withOutputCap(Math.min(ceiling, available))
      const cap = candidate.measurement.output.effectiveCap
      const outputReserve = ceiling === undefined ? 0 : output.capSupport === "supported" ? cap ?? ceiling : input.coverage === "neutral-only" ? candidate.measurement.output.configuredCap ?? ceiling : ceiling
      const incomplete = input.coverage === "incomplete"
      const unknownComponents = incomplete || input.uncertainties.some(reason => reason !== "route-output-floor-unverified")
      const unavailable = incomplete || window === undefined
      const fits = !unavailable && (!recoveryRequired || recoveryAuthorized) && checkBudget(session, window!, reserveRatio, 0, estimate.tokens + outputReserve).state === "ok" && (output.capSupport !== "supported" || available! >= output.minimumCap)
      const roleTokens = { user: 0, assistant: 0, tool: 0 }
      for (const unit of input.units) if (unit.role) roleTokens[unit.role] += unit.heuristicTokens
      const snapshot = { version: 1 as const, ownerSessionId, ...(binding?.providerId ?? input.providerId ? { providerId: binding?.providerId ?? input.providerId } : {}), modelId: input.modelId, protocol: input.protocol,
        bindingFingerprint: input.bindingFingerprint, bindingRevision, projectionRevision: revision(), neutralFingerprint: neutralFingerprint(),
        ...(binding?.bindingConfigFingerprint ? { bindingConfigFingerprint: binding.bindingConfigFingerprint } : {}), identityCoverage: binding?.identityCoverage ?? "partial" as const,
        estimatedInputTokens: estimate.tokens, admissionInputTokens: estimate.tokens, ...(window !== undefined ? { contextWindow: window } : {}),
        estimateSource: estimate.calibrated ? "provider-anchor-plus-projection" as const : input.coverage === "neutral-only" ? "neutral-only" as const : "projected-heuristic" as const,
        coverage: input.coverage, confidence: unknownComponents ? "unknown-components" as const : estimate.calibrated ? "calibrated-mixed" as const : "estimated" as const,
        roleTokens, systemTokens: input.components.system.heuristicTokens, schemaTokens: input.components.toolSchemas.heuristicTokens, reasoningTokens: input.components.replayedReasoning.heuristicTokens,
        outputReserve, ...(output.capSupport === "supported" && cap !== undefined ? { effectiveOutputCap: cap } : {}), capSupport: output.capSupport, safetyMargin,
        ...(available !== undefined ? { remainingInputBudget: Math.max(0, available - outputReserve) } : {}), admission: unavailable ? "unavailable" as const : fits ? "fit" as const : "compact" as const,
        recoveryRequired, fullByProvider, ...(unavailable ? { reason: incomplete ? "Prepared input includes unpriced fixed provider references" : "This model has no configured context window" } : recoveryRequired ? { reason: "Provider context recovery remains required" } : {}) }
      latest = { kind: "ready", snapshot: freezePreparedFacts(snapshot) }
      capturedFreshness = freshness()
      acceptedFingerprint = snapshot.neutralFingerprint
      return { prepared: candidate, snapshot }
    },
    checkpoint() { if (latest.kind === "ready") append(session, { type: "context/budget", version: 1, snapshot: latest.snapshot }) },
    record(measurement: PreparedRequestMeasurement, usage: Parameters<typeof calibration.record>[2], requestRevision: number, accepted: boolean) {
      if (!accepted) { calibration.invalidate(); return }
      const checkpoint = calibration.record(measurement.input, metadata(), usage, requestRevision)
      if (checkpoint) append(session, { type: "context/usage", version: 1, checkpoint })
      // Accepted provider output belongs to this owned attempt. A subsequent
      // local edit becomes unavailable until admission measures it again.
      acceptedFingerprint = neutralFingerprint()
      if (latest.kind === "ready") {
        latest = { kind: "ready", snapshot: freezePreparedFacts({ ...latest.snapshot, neutralFingerprint: acceptedFingerprint, admission: "unavailable", reason: "Accepted output awaits the next protocol projection" }) }
        append(session, { type: "context/budget", version: 1, snapshot: latest.snapshot })
      }
    },
  }
}
