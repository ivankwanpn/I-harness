import { randomUUID } from 'node:crypto'
import type { ExecutionConfirmation, ExecutionReceipt, PreparedModelRequest } from '@i-harness/llm-seam'
export interface SummaryPieceObservation { kind: 'summary-piece-accepted'; purpose: 'summary'; origin: 'piece'; receipt: ExecutionReceipt }
/** Ephemeral piece evidence only. Transaction publication belongs to R3. */
export function summaryPieceCollector(candidate: PreparedModelRequest) {
  const candidateId = randomUUID()
  let active = true, receipt: ExecutionReceipt | undefined
  return {
    confirm(confirmation: ExecutionConfirmation) {
      if (!active) return
      const semantic = candidate.measurement.input.semanticIdentity, payload = candidate.measurement.payloadIdentity
      if (!semantic || !payload || semantic.semanticId !== confirmation.semanticId || payload.id !== confirmation.payloadId || payload.kind !== confirmation.payloadKind) throw new Error('Summary execution confirmation does not match candidate')
      receipt = Object.freeze({ ...confirmation, candidateId })
    },
    close() { active = false },
    accepted(): SummaryPieceObservation | undefined { return receipt ? { kind: 'summary-piece-accepted', purpose: 'summary', origin: 'piece', receipt } : undefined },
  }
}
