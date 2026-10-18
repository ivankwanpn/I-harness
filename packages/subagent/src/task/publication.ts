import type { SessionView } from '@i-harness/core-session'
import type { TaskRecord } from './types.ts'
import { retainedResultWitness } from '../result-publication.ts'

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
