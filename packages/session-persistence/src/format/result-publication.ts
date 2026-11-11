import { isStrictFactData, rewindCuts, type RetainedResultRevision, type ResultExecution, type SessionView } from '@i-harness/core-session'

export type AuxiliaryResultStatus = 'running' | 'waiting' | 'completed' | 'killed' | 'error' | 'recovery-required'
export interface ResultPublication {
  publication?: 'unqualified' | 'committed'
  savedObservation?: { status: AuxiliaryResultStatus; execution?: ResultExecution }
}

const publicationKinds = ['unqualified', 'committed'] as const
const resultOutcomes = ['succeeded', 'failed', 'canceled', 'unknown'] as const
const resultDispatches = ['not-dispatched', 'dispatched', 'unknown'] as const
const auxiliaryStatuses: readonly AuxiliaryResultStatus[] = ['running', 'waiting', 'completed', 'killed', 'error', 'recovery-required']

/** The one exact execution descriptor shared by every result owner. */
export function validResultExecution(value: unknown): value is ResultExecution {
  const execution = value
  return !!execution && typeof execution === 'object' && !Array.isArray(execution) && Object.keys(execution).length === 2
    && Object.keys(execution).every(key => ['outcome', 'dispatch'].includes(key))
    && resultOutcomes.includes((execution as ResultExecution).outcome) && resultDispatches.includes((execution as ResultExecution).dispatch)
}

/** Closed saved-observation descriptor. Each domain supplies its own status
 * and outcome vocabularies; nothing else is shared. */
export function validSavedObservation(value: unknown, statuses: readonly string[], outcomes?: readonly string[]): boolean {
  const saved = value
  if (!isStrictFactData(saved) || !saved || typeof saved !== 'object' || Array.isArray(saved) || !Object.hasOwn(saved, 'status')) return false
  const allowed = outcomes ? ['status', 'outcome', 'execution'] : ['status', 'execution']
  if (Object.keys(saved).some(key => !allowed.includes(key))) return false
  const row = saved as { status: unknown; outcome?: unknown; execution?: unknown }
  if (typeof row.status !== 'string' || !statuses.includes(row.status)) return false
  if (outcomes && (typeof row.outcome !== 'string' || !outcomes.includes(row.outcome))) return false
  return row.execution === undefined || validResultExecution(row.execution)
}

/** Shared publication wrapper: the owning domain validates only its observation. */
export function validPublicationDescriptor(row: object, observation: (saved: unknown) => boolean): boolean {
  const publication = Object.getOwnPropertyDescriptor(row, 'publication'), saved = Object.getOwnPropertyDescriptor(row, 'savedObservation')
  if (publication && (!('value' in publication) || !publication.enumerable) || saved && (!('value' in saved) || !saved.enumerable)) return false
  const kind = publication?.value, observationValue = saved?.value
  if (kind === undefined && observationValue === undefined) return true
  if (!publicationKinds.includes(kind as 'unqualified' | 'committed') || kind === 'unqualified' && observationValue === undefined) return false
  if (observationValue === undefined) return true
  return observation(observationValue)
}

/** State/job mirrors: their own status vocabulary, no outcome field. */
export function validResultPublication(row: object): boolean {
  return validPublicationDescriptor(row, saved => validSavedObservation(saved, auxiliaryStatuses))
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
export function retainedTaskResultWitness(event:import('@i-harness/core-session').SessionEventView|undefined,saved:RetainedResultRevision,taskId:string){
 if(!event||event.type!=='subagent/end'||event.taskId!==taskId)return
 const result:RetainedResultRevision|undefined=event.envelope&&event.resultRevision?{version:1,kind:'retained',revision:event.resultRevision,envelope:event.envelope}:undefined
 if(!sameResult(saved,result)||!['completed','cancelled','error'].includes(event.outcome))return
 return {status:event.outcome==='completed'?'completed' as const:event.outcome==='cancelled'?'killed' as const:'error' as const,result}
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
      return retainedTaskResultWitness(event,saved,identity.taskId)
    }
  }
  return undefined
}

export function unknownResult(result: RetainedResultRevision): RetainedResultRevision {
  return result.kind === 'retained' ? { ...result, envelope: { ...result.envelope, execution: { outcome: 'unknown', dispatch: 'unknown' } } } : result
}
