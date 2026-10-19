import type { SessionView } from '@i-harness/core-session'
import type { TaskRecord, TaskOutcome, TaskStatus } from './types.ts'
import { retainedResultWitness, validPublicationDescriptor, validSavedObservation } from '../result-publication.ts'

/** Task rows persist their own status/outcome domain. Reusing the state/job
 * observation schema would reject an owner's own legally saved current-format
 * document on its next cold restore. */
const taskStatuses: readonly TaskStatus[] = ['accepted', 'running', 'completed', 'error', 'cancelled', 'recovery-required']
const taskOutcomes: readonly TaskOutcome[] = ['completed', 'error', 'cancelled', 'recovery-required']

export function validTaskResultPublication(row: object): boolean {
  return validPublicationDescriptor(row, saved => validSavedObservation(saved, taskStatuses, taskOutcomes))
}

/** Derived cold qualification over the saved observation. No new producer,
 * completion fact, notification or execution source is created here. */
export function unqualifyRestoredTask(task: TaskRecord): void {
  if (!task.result || task.outcome === undefined) return
  task.savedObservation ??= { status: task.status, outcome: task.outcome,
    ...(task.result.kind === 'retained' ? { execution: { ...task.result.envelope.execution } } : {}) }
  task.publication = 'unqualified'
  task.status = 'recovery-required'; task.outcome = 'recovery-required'
  if (task.result.kind === 'retained') task.result = { ...task.result, envelope: { ...task.result.envelope, execution: { outcome: 'unknown', dispatch: 'unknown' } } }
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
