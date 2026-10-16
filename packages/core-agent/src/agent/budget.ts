import { deriveContextRecovery, type BudgetRead, type SessionView as Session, type ExchangeAcceptedEventV2, type CalibrationRetirementReason, type FactPorts, type ProducerFactOutcome, type SettlementFacts, type SessionEvent } from "@i-harness/core-session"
import { agentFacts, committedFactSeqs } from './facts.ts'
import { createAcceptedCalibration, type PreparedRequestMeasurement } from "@i-harness/token-meter"
import { assessLegacyPreparedRequest, readContextCoordinates } from "@i-harness/context-engine"
import { sameRequestCandidate, requestContextIdentity, type RequestEvidence } from "./request-snapshot.ts"
import { freezePreparedFacts, type PreparedModelRequest } from "@i-harness/llm-seam"

/** The only owner of prepared admission, pressure, calibration and scalar reads. */
export function createOwnedBudget(session: Session, ownerSessionId: string, freshness: () => RequestEvidence, observationLifetimeId: string, expectedExecution: (base: import("@i-harness/llm-seam").LiveExecutionIdentity | undefined) => import("./execution.ts").EpochObservation,
  facts: () => FactPorts<ProducerFactOutcome> = () => agentFacts({ session }), settlement: () => SettlementFacts<ProducerFactOutcome> | undefined = () => undefined) {
  const calibration = createAcceptedCalibration(ownerSessionId, observationLifetimeId)
  const compatibility = (evidence: RequestEvidence): Parameters<ReturnType<typeof createAcceptedCalibration>["probe"]>[1] => { const expected = expectedExecution(evidence.executionIdentity); return { ownerSessionId, observationLifetimeId, executionEpochId: expected.kind === "known" ? expected.identity.authEpoch : undefined, branchId: evidence.snapshot.coordinates.branchId, contextEpoch: evidence.snapshot.coordinates.contextEpoch, projectionRevision: evidence.projectionRevision } }
  const retirements: Extract<SessionEvent, { type: 'context/usage'; version: 2; op: 'retire' }>[] = []
  const retire = (reason: CalibrationRetirementReason) => { const event = calibration.retire(reason); if (event) retirements.push(event) }
  const drainRetirements = async () => { while (retirements.length) { committedFactSeqs(await (settlement()?.lifecycle ?? facts().agent).usage(retirements[0]!)); retirements.shift() } }
  let latest: BudgetRead = { kind: "unavailable", reason: "No prepared request budget is available" }
  let bindingRevision = 0
  let captured: RequestEvidence | undefined
  let invalidated: string | undefined
  const historical = (reason: string): BudgetRead => latest.kind === "ready"
    ? { kind: "ready", snapshot: { ...latest.snapshot, admission: "unavailable", reason } } : latest
  return {
    ownerSessionId,
    invalidateCalibration() { retire("context-rewritten") },
    retire,
    invalidate() { retire("binding-changed"); invalidated = "Model context binding changed"; bindingRevision++ },
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
      const expected = compatibility(evidence)
      const result = assessLegacyPreparedRequest(prepared, {
        ownerSessionId, binding: evidence.metadata, bindingRevision, projectionRevision: evidence.projectionRevision,
        neutralFingerprint: evidence.neutralFingerprint, requestContext: requestContextIdentity(evidence),
        contextWindow: window, configuredCap, reserveRatio, recoveryAuthorized, selectOutputCap,
      }, {
        estimate: input => calibration.probe(input, expected),
        recoveryRequired: input => {
          const recovery = deriveContextRecovery(session, ownerSessionId, { ...input, providerId: evidence.metadata?.providerId ?? input.providerId })
          return recovery !== undefined && recovery.state !== "resolved"
        },
      })
      latest = { kind: "ready", snapshot: result.snapshot }
      captured = evidence
      invalidated = undefined
      return result
    },
    async checkpoint() { await drainRetirements(); if (latest.kind === "ready") committedFactSeqs(await facts().metadata.admit({ type: "context/budget", version: 1, snapshot: latest.snapshot })) },
    async record(measurement: PreparedRequestMeasurement, usage: Parameters<typeof calibration.recordAccepted>[3], accepted: ExchangeAcceptedEventV2 | undefined) {
      await drainRetirements()
      if (accepted && session.events[accepted.seq!] === accepted) {
        const sample = calibration.recordAccepted(measurement.input, accepted.request, accepted, usage)
        if (sample.kind === "sample") committedFactSeqs(await (settlement()?.lifecycle ?? facts().agent).usage({ type: "context/usage", version: 2, op: "sample", checkpoint: { ...sample.checkpoint, accepted: { ...sample.checkpoint.accepted, acceptedSeq: { kind: 'prior', seq: sample.checkpoint.accepted.acceptedSeq, expectedType: 'model/exchange-accepted' } } } }))
      }
      // Accepted provider output belongs to this owned attempt. A subsequent
      // local edit becomes unavailable until admission measures it again.
      let postResponseContextRevision: string | undefined
      try { const observation = readContextCoordinates(session, { ownerSessionId }); if (observation.kind === "available") postResponseContextRevision = observation.observationRevision } catch { /* Observation cannot revoke real usage. */ }
      if (latest.kind === "ready") {
        latest = { kind: "ready", snapshot: freezePreparedFacts({ ...latest.snapshot, ...(postResponseContextRevision ? { postResponseContextRevision } : {}), admission: "unavailable", reason: "Accepted output awaits the next protocol projection" }) }
        committedFactSeqs(await facts().metadata.admit({ type: "context/budget", version: 1, snapshot: latest.snapshot }))
      }
    },
  }
}
