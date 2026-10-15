import { randomUUID } from 'node:crypto'
import { sameExecutionIdentity, validExecutionIdentity, type LiveExecutionIdentity, type ExecutionConfirmation, type ExecutionReceipt, type PreparedModelRequest } from '@i-harness/llm-seam'
import type { AcceptedRequestAttributionV1 } from '@i-harness/core-session'
import { requestContextIdentity, type RequestEvidence } from './request-snapshot.ts'
export type EpochObservation = { kind: 'known'; identity: LiveExecutionIdentity } | { kind: 'unclassified' }
export interface EpochReadmissionEvidence { candidateId: string; bindingLifetimeId: string; runtimeId: string; observed: EpochObservation }
export interface CandidateExecutionState { epochRebuilds: number; hasStartedSend: boolean; hasObservedOutput: boolean; handoff?: EpochReadmissionEvidence }
export const executionIdentityChanged = () => Object.assign(new Error('Execution identity changed before transport'), { code: 'EXECUTION_IDENTITY_CHANGED' })
const sameLifetime = (a: LiveExecutionIdentity | undefined, b: LiveExecutionIdentity | undefined) => !!a && !!b && a.runtimeId === b.runtimeId && a.bindingLifetimeId === b.bindingLifetimeId
/** Private per-Agent observation, independent even when the client is shared. */
export function createExecutionOwner() {
  const observationLifetimeId = randomUUID()
  let observed: { base: LiveExecutionIdentity; value: EpochObservation } | undefined
  return {
    observationLifetimeId,
    expected(base: LiveExecutionIdentity | undefined): EpochObservation {
      if (observed && sameLifetime(base, observed.base)) return observed.value
      observed = undefined
      return validExecutionIdentity(base) ? { kind: 'known', identity: base } : { kind: 'unclassified' }
    },
    candidate(prepared: PreparedModelRequest, evidence: RequestEvidence, state: CandidateExecutionState, calibrated: boolean, current: () => boolean, retire: () => void) {
      const candidateId = randomUUID(), base = evidence.executionIdentity
      const handoff = state.handoff
      const pinned = !!handoff && !!base && handoff.runtimeId === base.runtimeId && handoff.bindingLifetimeId === base.bindingLifetimeId
      const expected = pinned ? handoff!.observed : this.expected(base)
      if (handoff && !pinned) state.handoff = undefined
      let active = true, rejected: EpochReadmissionEvidence | undefined
      return {
        candidateId,
        expected,
        close() { active = false },
        handoff() { return rejected },
        confirm(confirmation: ExecutionConfirmation): ExecutionReceipt | undefined {
          if (!active) return
          if (!current()) throw Object.assign(new Error('Candidate changed before execution confirmation'), { code: 'CONTEXT_INPUT_STALE' })
          const semantic = prepared.measurement.input.semanticIdentity, payload = prepared.measurement.payloadIdentity
          if (!semantic || !payload || confirmation.version !== 1 || confirmation.semanticId !== semantic.semanticId || confirmation.payloadId !== payload.id || confirmation.payloadKind !== payload.kind) throw new Error('Execution confirmation does not match selected candidate')
          const identity = validExecutionIdentity(confirmation.identity) ? Object.freeze({ ...confirmation.identity }) : undefined
          const value: EpochObservation = identity ? { kind: 'known', identity } : { kind: 'unclassified' }
          if (base && identity && !sameLifetime(base, identity)) { observed = undefined; retire(); throw executionIdentityChanged() }
          if (base) observed = { base, value }
          const mismatch = expected.kind === 'known' && !sameExecutionIdentity(expected.identity, identity)
          if ((calibrated || pinned && expected.kind === 'known') && mismatch) {
            retire()
            // Only this active collector issues a trusted handoff. Error fields
            // are never interpreted as identity evidence by the turn owner.
            rejected = { candidateId, runtimeId: base?.runtimeId ?? expected.identity.runtimeId, bindingLifetimeId: base?.bindingLifetimeId ?? expected.identity.bindingLifetimeId, observed: value }
            throw executionIdentityChanged()
          }
          return Object.freeze({ ...confirmation, ...(identity ? { identity } : {}), candidateId })
        },
        attribution(receipt: ExecutionReceipt | undefined): AcceptedRequestAttributionV1 | undefined {
          if (!receipt?.identity || receipt.candidateId !== candidateId) return
          const { version: _version, ...snapshot } = requestContextIdentity(evidence)
          return { version: 1, ownerSessionId: evidence.snapshot.coordinates.ownerSessionId, observationLifetimeId, candidateId, sendId: receipt.sendId, semanticId: receipt.semanticId, payloadId: receipt.payloadId, payloadKind: receipt.payloadKind, executionEpochId: receipt.identity.authEpoch, coldCompatible: false, snapshot, projectionRevision: evidence.projectionRevision }
        },
      }
    },
  }
}
