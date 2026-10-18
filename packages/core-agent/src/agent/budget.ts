import { deriveContextRecovery, type BudgetRead, type SessionView as Session, type ExchangeAcceptedEventV2, type CalibrationRetirementReason, type FactPorts, type ProducerFactOutcome, type SettlementFacts, type SessionEvent } from "@i-harness/core-session"
import { agentFacts, committedFactSeqs } from './facts.ts'
import { createAcceptedCalibration, type PreparedRequestMeasurement } from "@i-harness/token-meter"
import { assessLegacyPreparedRequest, admissionObservation, readContextCoordinates } from "@i-harness/context-engine"
import { sameRequestCandidate, requestContextIdentity, type RequestEvidence } from "./request-snapshot.ts"
import { freezePreparedFacts, type PreparedModelRequest } from "@i-harness/llm-seam"

/** The only owner of prepared admission, pressure, calibration and scalar reads. */
export function createOwnedBudget(session: Session, ownerSessionId: string, freshness: () => RequestEvidence, observationLifetimeId: string, expectedExecution: (base: import("@i-harness/llm-seam").LiveExecutionIdentity | undefined) => import("./execution.ts").EpochObservation,
  facts: () => FactPorts<ProducerFactOutcome> = () => agentFacts({ session }), settlement: () => SettlementFacts<ProducerFactOutcome> | undefined = () => undefined) {
  const calibration = createAcceptedCalibration(ownerSessionId, observationLifetimeId)
  const compatibility = (evidence: RequestEvidence): Parameters<ReturnType<typeof createAcceptedCalibration>["probe"]>[1] => { const expected = expectedExecution(evidence.executionIdentity); return { ownerSessionId, observationLifetimeId, executionEpochId: expected.kind === "known" ? expected.identity.authEpoch : undefined, branchId: evidence.snapshot.coordinates.branchId, contextEpoch: evidence.snapshot.coordinates.contextEpoch, projectionRevision: evidence.projectionRevision } }
  const retirements: Extract<SessionEvent, { type: 'context/usage'; version: 2; op: 'retire' }>[] = []
  const retire = (reason: CalibrationRetirementReason) => { const event = calibration.retire(reason); if (event) { calibrationRevision++; retirements.push(event) } }
  const drainRetirements = async () => { while (retirements.length) { committedFactSeqs(await (settlement()?.lifecycle ?? facts().agent).usage(retirements[0]!)); retirements.shift() } }
  let latest: BudgetRead = { kind: "unavailable", reason: "No prepared request budget is available" }
  let latestDecision: import('@i-harness/context-engine').CapacityAssessment | undefined
  let bindingRevision = 0
  let captured: RequestEvidence | undefined
  let invalidated: string | undefined
  let calibrationRevision = 0
  const historical = (reason: string): BudgetRead => latest.kind === "ready"
    ? { ...latest, snapshot: { ...latest.snapshot, admission: "unavailable", reason }, ...(latest.observation ? { observation: { ...latest.observation, freshness: 'stale' as const } } : {}) } : latest
  return {
    ownerSessionId,
    decision() { return latestDecision },
    assessmentRevision() {
      let history = ''
      for (const event of session.events) if (event.type === 'context/usage' || event.type === 'context/recovery') history = `${history}:${event.seq}`
      return `${bindingRevision}:${calibrationRevision}:${history}`
    },
    probe(prepared: PreparedModelRequest, evidence: RequestEvidence, prospectiveRewrite: boolean, reserveRatio = .9, pressurePolicy?: import('@i-harness/context-engine').ReductionPolicy) {
      return assessLegacyPreparedRequest(prepared, {
        ownerSessionId, binding: evidence.metadata, bindingRevision, projectionRevision: evidence.projectionRevision,
        neutralFingerprint: evidence.neutralFingerprint, requestContext: requestContextIdentity(evidence),
        contextWindow: evidence.snapshot.surface.contextWindow, configuredCap: evidence.snapshot.surface.maxOutputTokens, reserveRatio,
        budgetBinding: evidence.snapshot.surface.budgetBinding,
        triggerRatio: pressurePolicy?.thresholdRatio, targetRatio: pressurePolicy?.targetRatio,
      }, {
        estimate: input => calibration.probe(input, { ...compatibility(evidence), ...(prospectiveRewrite ? { prospectiveRewrite: true as const } : {}) }),
        recoveryRequired: input => { const recovery = deriveContextRecovery(session, ownerSessionId, { ...input, providerId: evidence.metadata?.providerId ?? input.providerId }); return !!recovery && recovery.state !== 'resolved' },
      })
    },
    invalidateCalibration() { retire("context-rewritten") },
    retire,
    invalidate(retireSample = true) { if (retireSample) retire("binding-changed"); invalidated = "Model context binding changed"; bindingRevision++ },
    read(reason?: string): BudgetRead {
      if (latest.kind !== "ready") return latest
      let unavailable = reason ?? invalidated
      if (!unavailable && captured && (latest.observation?.freshness === 'current' || latest.snapshot.admission !== "unavailable")) {
        try { if (!sameRequestCandidate(captured, freshness())) unavailable = "Model context or request surface/binding changed since the prepared budget" }
        catch { unavailable = "Current context capture is unavailable" }
      }
      // Observing a stale assessment makes it historical. Restoring a previous
      // surface cannot turn a read into a new admission certificate.
      if (unavailable) invalidated = unavailable
      const recovery = deriveContextRecovery(session, ownerSessionId, latest.snapshot)
      const recoveryRequired = recovery !== undefined && recovery.state !== "resolved"
      const read = unavailable ? historical(unavailable) : latest
      if (read.kind === "ready" && recoveryRequired) return { ...read, ...(read.observation ? { observation: { ...read.observation, recoveryRequired: true, fullByProvider: true } } : {}), snapshot: { ...read.snapshot, recoveryRequired: true, fullByProvider: true,
        admission: read.snapshot.admission === "unavailable" ? "unavailable" : "compact", reason: "Provider context recovery remains required" } }
      if (read.kind === "ready" && recovery?.state === "resolved" && read.snapshot.recoveryRequired) return { ...read, ...(read.observation ? { observation: { ...read.observation, recoveryRequired: false, fullByProvider: false } } : {}), snapshot: { ...read.snapshot, recoveryRequired: false, fullByProvider: false } }
      return read
    },
    pressure() {
      return latestDecision?.pressure
    },
    assess(prepared: PreparedModelRequest, evidence: RequestEvidence, window: number | undefined, configuredCap?: number, reserveRatio = .9, recoveryAuthorized = false, selectOutputCap = true, pressurePolicy?: import('@i-harness/context-engine').ReductionPolicy, purpose: import('@i-harness/context-engine').AdmissionPurpose = recoveryAuthorized ? 'recovery' : 'main') {
      const expected = compatibility(evidence)
      const result = assessLegacyPreparedRequest(prepared, {
        ownerSessionId, binding: evidence.metadata, bindingRevision, projectionRevision: evidence.projectionRevision,
        neutralFingerprint: evidence.neutralFingerprint, requestContext: requestContextIdentity(evidence),
        contextWindow: window, configuredCap, reserveRatio, recoveryAuthorized, selectOutputCap,
        budgetBinding: evidence.snapshot.surface.budgetBinding,
        purpose,
        triggerRatio: pressurePolicy?.thresholdRatio, targetRatio: pressurePolicy?.targetRatio,
      }, {
        estimate: input => calibration.probe(input, expected),
        recoveryRequired: input => {
          const recovery = deriveContextRecovery(session, ownerSessionId, { ...input, providerId: evidence.metadata?.providerId ?? input.providerId })
          return recovery !== undefined && recovery.state !== "resolved"
        },
      })
      latest = { kind: "ready", snapshot: result.snapshot, observation: freezePreparedFacts(admissionObservation(result, purpose)) }
      latestDecision = result.decision
      captured = evidence
      invalidated = undefined
      return result
    },
    async checkpoint() { await drainRetirements(); if (latest.kind === "ready" && latest.observation) committedFactSeqs(await facts().metadata.admit({ type: "context/budget", version: 2, snapshot: latest.observation })) },
    async record(measurement: PreparedRequestMeasurement, usage: Parameters<typeof calibration.recordAccepted>[3], accepted: ExchangeAcceptedEventV2 | undefined) {
      await drainRetirements()
      if (accepted && session.events[accepted.seq!] === accepted) {
        const sample = calibration.recordAccepted(measurement.input, accepted.request, accepted, usage)
        if (sample.kind === "sample") { calibrationRevision++; committedFactSeqs(await (settlement()?.lifecycle ?? facts().agent).usage({ type: "context/usage", version: 2, op: "sample", checkpoint: { ...sample.checkpoint, accepted: { ...sample.checkpoint.accepted, acceptedSeq: { kind: 'prior', seq: sample.checkpoint.accepted.acceptedSeq, expectedType: 'model/exchange-accepted' } } } })) }
      }
      // Accepted provider output belongs to this owned attempt. A subsequent
      // local edit becomes unavailable until admission measures it again.
      let postResponseContextRevision: string | undefined
      try { const observation = readContextCoordinates(session, { ownerSessionId }); if (observation.kind === "available") postResponseContextRevision = observation.observationRevision } catch { /* Observation cannot revoke real usage. */ }
      if (latest.kind === "ready") {
        latest = { ...latest, snapshot: freezePreparedFacts({ ...latest.snapshot, ...(postResponseContextRevision ? { postResponseContextRevision } : {}), admission: "unavailable", reason: "Accepted output awaits the next protocol projection" }),
          ...(latest.observation ? { observation: freezePreparedFacts({ ...latest.observation, freshness: 'awaiting-projection' as const, ...(postResponseContextRevision ? { postResponseContextRevision } : {}) }) } : {}) }
        if (latest.observation) committedFactSeqs(await facts().metadata.admit({ type: "context/budget", version: 2, snapshot: latest.observation }))
      }
    },
  }
}
