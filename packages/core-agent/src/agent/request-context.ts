import type { ProducerFactOutcome } from '@i-harness/core-session'
import type { ExecutionReceipt } from '@i-harness/llm-seam'
import type { RequestEvidence } from './request-snapshot.ts'

export interface InstructionRequestEvidence { readonly kind: 'instruction-request'; readonly version: 1 }
export interface RequestContextPin { release(): Promise<void> }
export type AcceptedExchange = { acceptedSeq: number; outcome: Extract<ProducerFactOutcome, { kind: 'committed' | 'memory-committed' }> }
export interface SuccessfulInstructionHandoff extends AcceptedExchange {
  candidate: RequestEvidence
  evidence: InstructionRequestEvidence
  physicalExecutionReceipt: ExecutionReceipt
}
export interface SessionRequestContext {
  reconcile(signal?: AbortSignal): Promise<void>
  capture(): InstructionRequestEvidence | undefined
  current(evidence: InstructionRequestEvidence | undefined): boolean
  retain(evidence: InstructionRequestEvidence): RequestContextPin
  succeeded(handoff: SuccessfulInstructionHandoff): void
  promotedHumanRequest(): void
  close(): Promise<void>
}
