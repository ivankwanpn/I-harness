import { isStrictFactData, rewindCuts, type RetainedResultRevision, type ResultExecution, type SessionView } from '@i-harness/core-session'

export type AuxiliaryResultStatus = 'running' | 'waiting' | 'completed' | 'killed' | 'error' | 'recovery-required'
export interface ResultPublication {
  publication?: 'unqualified' | 'committed'
  savedObservation?: { status: AuxiliaryResultStatus; execution?: ResultExecution }
}

export function validResultPublication(row: object): boolean {
  const publication = Object.getOwnPropertyDescriptor(row, 'publication'), observation = Object.getOwnPropertyDescriptor(row, 'savedObservation')
  if (publication && (!('value' in publication) || !publication.enumerable) || observation && (!('value' in observation) || !observation.enumerable)) return false
  const kind = publication?.value, saved = observation?.value
  if (kind === undefined && saved === undefined) return true
  if (!['unqualified', 'committed'].includes(kind) || kind === 'unqualified' && saved === undefined) return false
  if (saved === undefined) return true
  if (!isStrictFactData(saved) || !saved || typeof saved !== 'object' || Array.isArray(saved) || !Object.hasOwn(saved, 'status')
    || Object.keys(saved).some(key => !['status', 'execution'].includes(key)) || !['running', 'waiting', 'completed', 'killed', 'error', 'recovery-required'].includes(saved.status)) return false
  if (saved.execution === undefined) return true
  const execution = saved.execution
  return !!execution && typeof execution === 'object' && !Array.isArray(execution) && Object.keys(execution).length === 2
    && Object.keys(execution).every(key => ['outcome', 'dispatch'].includes(key))
    && ['succeeded', 'failed', 'canceled', 'unknown'].includes(execution.outcome) && ['not-dispatched', 'dispatched', 'unknown'].includes(execution.dispatch)
}

function sameResult(saved: RetainedResultRevision, published: RetainedResultRevision | undefined): published is Extract<RetainedResultRevision, { kind: 'retained' }> {
  if (saved.kind !== 'retained' || published?.kind !== 'retained' || published.revision !== saved.revision) return false
  const before = saved.envelope.retention, after = published.envelope.retention
  if (before.kind === 'artifact' && after.kind === 'artifact') return before.ref.id === after.ref.id && before.ref.revision === after.ref.revision
    && before.ref.codec === after.ref.codec && before.ref.encodedBytes === after.ref.encodedBytes && before.ref.contentDigest === after.ref.contentDigest && before.ref.completeness === after.ref.completeness
  if (before.kind === 'unavailable' && after.kind === 'unavailable') return before.reason === after.reason && before.observedEncodedBytes === after.observedEncodedBytes
  // The original bounded inline F1 value replaces the auxiliary copy. It is
  // never hashed or treated as independent proof of execution.
  return before.kind === 'inline' && after.kind === 'inline' && before.encodedBytes === after.encodedBytes
}

/** Inspect only an already authorized parent's committed facts. The latest
 * matching source identity fences old revisions, including running followups. */
export function retainedResultWitness(session: SessionView | undefined, saved: RetainedResultRevision, identity: { jobId?: string; taskId?: string }): { status: 'completed' | 'killed' | 'error'; result: Extract<RetainedResultRevision, { kind: 'retained' }> } | undefined {
  if (!session || saved.kind !== 'retained' || !identity.jobId && !identity.taskId) return
  const cuts = rewindCuts(session)
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]!
    if (cuts.some(cut => event.seq !== undefined && event.seq >= cut.cutFrom && event.seq < cut.markerSeq)) continue
    if (identity.jobId && event.type === 'job/status' && event.job.jobId === identity.jobId) {
      if (event.job.status === 'running' || !sameResult(saved, event.job.result)) return
      return { status: event.job.status, result: event.job.result }
    }
    if (identity.taskId && event.type === 'subagent/end' && event.taskId === identity.taskId) {
      const result: RetainedResultRevision | undefined = event.envelope && event.resultRevision ? { version: 1, kind: 'retained', revision: event.resultRevision, envelope: event.envelope } : undefined
      if (!sameResult(saved, result) || !['completed', 'cancelled', 'error'].includes(event.outcome)) return
      return { status: event.outcome === 'completed' ? 'completed' : event.outcome === 'cancelled' ? 'killed' : 'error', result }
    }
  }
  return undefined
}

export function unknownResult(result: RetainedResultRevision): RetainedResultRevision {
  return result.kind === 'retained' ? { ...result, envelope: { ...result.envelope, execution: { outcome: 'unknown', dispatch: 'unknown' } } } : result
}
