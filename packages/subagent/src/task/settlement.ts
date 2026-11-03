import type { TaskRecord, TaskTerminalizeInput } from './types.ts'
import type { TaskResultOwner } from './result.ts'

/** The existing terminal CAS lowers exactly the fields the real producer
 * supplied. Publishing is separate so a tree cancellation is coherent. */
export function settleTaskRecord(task: TaskRecord | undefined, input: TaskTerminalizeInput, resultOwner?: TaskResultOwner): task is TaskRecord {
  if (!task || task.outcome !== undefined) return false
  const dispatch = input.recoveryReason === 'dispatch-unknown' ? 'unknown' : task.status === 'accepted' ? 'not-dispatched' : 'dispatched'
  task.status = input.outcome
  task.outcome = input.outcome
  const resultText = input.resultText, error = input.error
  const body = { ...(resultText !== undefined ? { resultText } : {}), ...(error !== undefined ? { error } : {}) }
  if (input.recoveryReason !== undefined) task.recoveryReason = input.recoveryReason
  if (resultOwner) resultOwner.capture(task, body, { outcome: input.outcome === 'completed' ? 'succeeded' : input.outcome === 'cancelled' ? 'canceled' : input.outcome === 'error' ? 'failed' : 'unknown', dispatch })
  else Object.assign(task, body)
  task.timeCompleted = Date.now()
  return true
}
