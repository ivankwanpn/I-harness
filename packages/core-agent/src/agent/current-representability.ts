import type { PreparedModelRequest } from '@i-harness/llm-seam'
import type { RequestEvidence } from './request-snapshot.ts'

/** The preparer owns normalized override attestation. Neutral current facts,
 * including an explicit clear, cannot prove delivery through replaced messages. */
export function assertCurrentRepresentable(evidence: Pick<RequestEvidence, 'snapshot'>, prepared: Pick<PreparedModelRequest, 'measurement'>): void {
  if (evidence.snapshot.conversation.current && prepared.measurement.input.overriddenInputFields.includes('messages')) {
    throw Object.assign(new Error('The prepared request cannot represent the captured current context because its messages are overridden'), { code: 'CONTEXT_CURRENT_UNREPRESENTABLE' })
  }
}
