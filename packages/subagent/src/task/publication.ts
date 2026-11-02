import type { SessionView } from '@i-harness/core-session'
import type { TaskRecord, TaskOutcome, TaskStatus, TaskSavedObservation } from './types.ts'
import { retainedResultWitness,retainedTaskResultWitness, validPublicationDescriptor, validSavedObservation } from '../result-publication.ts'
import {readManagedTaskResult,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'

/** Task rows persist their own status/outcome domain. Reusing the state/job
 * observation schema would reject an owner's own legally saved current-format
 * document on its next cold restore. */
const taskStatuses: readonly TaskStatus[] = ['accepted', 'running', 'completed', 'error', 'cancelled', 'recovery-required']
const taskOutcomes: readonly TaskOutcome[] = ['completed', 'error', 'cancelled', 'recovery-required']

export function validTaskObservation(saved: unknown): saved is TaskSavedObservation {
  if (saved && typeof saved === 'object' && Object.hasOwn(saved, 'outcome')) return validSavedObservation(saved, taskStatuses, taskOutcomes)
  return validSavedObservation(saved, ['accepted', 'running'])
}

export function validTaskResultPublication(row: object): boolean {
  return validPublicationDescriptor(row, validTaskObservation)
}

/** Derived cold qualification over the saved observation. No new producer,
 * completion fact, notification or execution source is created here. */
export function unqualifyRestoredTask(task: TaskRecord): void {
  if (task.legacyFormatVersion === 1) return
  if (!task.savedObservation) {
    const saved = { status: task.status, ...(task.outcome !== undefined ? { outcome: task.outcome } : {}),
      ...(task.result?.kind === 'retained' ? { execution: { ...task.result.envelope.execution } } : {}) }
    if (!validTaskObservation(saved)) throw new Error('Invalid current task observation')
    task.savedObservation = saved
  }
  task.publication = 'unqualified'
  task.status = 'recovery-required'; task.outcome = 'recovery-required'
  if (task.result?.kind === 'retained') task.result = { ...task.result, envelope: { ...task.result.envelope, execution: { outcome: 'unknown', dispatch: 'unknown' } } }
}

export function qualifyTaskPublication(task: TaskRecord, session: SessionView): boolean {
  if (task.publication !== 'unqualified' || !task.result || !task.savedObservation) return false
  const proof = retainedResultWitness(session, task.result, { taskId: task.id })
  const outcome = proof?.status === 'completed' ? 'completed' : proof?.status === 'killed' ? 'cancelled' : proof?.status === 'error' ? 'error' : undefined
  if (!proof || outcome !== task.savedObservation.outcome) return false
  task.publication = 'committed'; task.status = task.savedObservation.status; task.outcome = outcome
  task.result = proof.result
  return true
}
export async function qualifyManagedTaskPublication(task:TaskRecord,domain:ManagedExecutionDomain):Promise<boolean>{
 if(task.publication!=='unqualified'||!task.result||!task.savedObservation||task.parentSessionId!==domain.sessionId)return false
 const savedResult=task.result,savedObservation=task.savedObservation,event=await readManagedTaskResult(domain,task.id)
 if(task.publication!=='unqualified'||task.result!==savedResult||task.savedObservation!==savedObservation)throw Error('Original Task result changed during qualification')
 const proof=retainedTaskResultWitness(event,savedResult,task.id),outcome=proof?.status==='completed'?'completed':proof?.status==='killed'?'cancelled':proof?.status==='error'?'error':undefined
 domain.assertCurrent();if(!proof||outcome!==savedObservation.outcome)return false
 task.publication='committed';task.status=savedObservation.status;task.outcome=outcome;task.result=proof.result;return true
}
