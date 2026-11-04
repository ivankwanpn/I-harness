import type { AgentTaskView } from '@i-harness/subagent'
import type { RecoveredTaskRow } from '@i-harness/subagent'

/** D-01 degraded projection: map durable job-record rows to the UI task shape.
 * Read-only rows never claim cancellability. */
export function projectRecoveredTaskRows(rows: RecoveredTaskRow[]): AgentTaskView[] {
  return rows.map(row => ({
    id: row.taskId, group: 'subagent' as const,
    label: row.description || row.agentPath || row.taskId,
    status: row.status === 'accepted' ? 'queued' as const : row.status === 'running' ? 'running' as const
      : row.status === 'completed' ? 'completed' as const : row.status === 'cancelled' ? 'cancelled' as const : 'failed' as const,
    summary: 'Recovered read-only from the durable job record',
    startedAt: row.createdAt, updatedAt: row.updatedAt, canCancel: false,
  }))
}
