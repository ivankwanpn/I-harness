import type { SessionView, RetainedResultRevision } from '@i-harness/core-session'
import { retainedResultWitness } from '@i-harness/subagent'
import type { DesktopSubagentStatus } from './types.ts'

/** Catalog and restore use the same child-domain immutable fact identity.
 * The supplied view comes from the actual authorized parent coordinator. */
export function committedChildResultStatus(session: SessionView | undefined, retained: RetainedResultRevision, jobId?: string, taskId?: string): { status: DesktopSubagentStatus; result: RetainedResultRevision } | undefined {
  const proof = retainedResultWitness(session, retained, { jobId, taskId })
  return proof ? { status: proof.status === 'killed' ? 'cancelled' : proof.status === 'error' ? 'failed' : 'completed', result: proof.result } : undefined
}
