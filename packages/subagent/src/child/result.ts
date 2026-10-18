import { randomUUID } from 'node:crypto'
import { TaskResultOwner, type TaskResultStore, type TaskResultBody, type TaskResultTarget, type TaskResultProjection } from '../task/result.ts'
import type { TaskOutcome } from '../task/types.ts'
import type { ChildAgentEntry } from '../agent-table.ts'
import type { AgentTable } from '../agent-table.ts'
import type { JobRegistry } from '../jobs.ts'

export interface ChildResultSettlement {
  projection(): TaskResultProjection
  settle(): Promise<TaskResultProjection>
}

/** Each actual resident completion owns one original capture. No task submit,
 * wake or synthetic TaskRecord is created for a followup revision. */
export function captureChildResult(store: TaskResultStore, entry: ChildAgentEntry, body: TaskResultBody, outcome: TaskOutcome, dispatch: 'dispatched' | 'not-dispatched' = 'dispatched'): ChildResultSettlement {
  const target: TaskResultTarget = { id: entry.jobId ?? randomUUID(), parentSessionId: entry.session.header?.parentSession ?? '', outcome }
  const owner = new TaskResultOwner(store)
  owner.capture(target, body, { outcome: outcome === 'completed' ? 'succeeded' : outcome === 'cancelled' ? 'canceled' : outcome === 'error' ? 'failed' : 'unknown', dispatch }, () => entry.resultCapture === handle && entry.resultLifetime?.() !== false)
  const projection = (): TaskResultProjection => ({ ...(target.resultText !== undefined ? { resultText: target.resultText } : {}), ...(target.error !== undefined ? { error: target.error } : {}), result: target.result })
  const handle: ChildResultSettlement = { projection, async settle() { await owner.settle(target); return projection() } }
  entry.resultCapture = handle
  return handle
}

export function publishChildResult(owners: { table: AgentTable; jobs: JobRegistry }, entry: ChildAgentEntry, value: TaskResultProjection, outcome: TaskOutcome, taskId?: string): void {
  owners.table.update(entry.path, entry, { status: 'waiting', publication: undefined, savedObservation: undefined, finalText: value.resultText, error: value.error, ...(taskId ? { taskId } : {}), ...(value.result ? { result: value.result } : {}) })
  if (entry.jobId) owners.jobs.updateJob(entry.jobId, { status: outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'killed' : 'error', output: outcome === 'completed' ? value.resultText ?? '' : value.error ?? value.resultText ?? '', ...(taskId ? { taskId } : {}), ...(value.result ? { result: value.result } : {}) })
}

export async function retainChildResult(owners: { table: AgentTable; jobs: JobRegistry; results?: TaskResultStore }, entry: ChildAgentEntry, body: TaskResultBody, outcome: TaskOutcome, existing?: TaskResultProjection | void): Promise<void> {
  const capture = !existing?.result && owners.results ? captureChildResult(owners.results, entry, body, outcome) : undefined
  publishChildResult(owners, entry, capture?.projection() ?? existing ?? body, outcome)
  if (capture) publishChildResult(owners, entry, await capture.settle(), outcome)
}
