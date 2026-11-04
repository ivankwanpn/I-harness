import { expect, it } from 'vitest'
import type { RecoveredTaskRow } from '@i-harness/subagent'
import { projectRecoveredTaskRows } from '../src/task-fallback.ts'

const row = (overrides: Partial<RecoveredTaskRow>): RecoveredTaskRow => ({
  taskId: 'task-1', parentSessionId: 'parent', status: 'running', createdAt: 1, updatedAt: 2, ...overrides,
})

it('maps recovered job rows to read-only task views (D-01 degraded mode)', () => {
  const views = projectRecoveredTaskRows([
    row({ status: 'accepted', description: 'queued work' }),
    row({ taskId: 'b', status: 'running', agentPath: 'helper' }),
    row({ taskId: 'c', status: 'completed', outcome: 'completed' }),
    row({ taskId: 'd', status: 'error', outcome: 'error', error: 'crashed' }),
    row({ taskId: 'e', status: 'cancelled' }),
    row({ taskId: 'f', status: 'recovery-required' }),
  ])
  expect(views.map(view => [view.id, view.status])).toEqual([
    ['task-1', 'queued'], ['b', 'running'], ['c', 'completed'], ['d', 'failed'], ['e', 'cancelled'], ['f', 'failed'],
  ])
  expect(views[0]).toMatchObject({ label: 'queued work', canCancel: false })
  expect(views[1]).toMatchObject({ label: 'helper' })
  expect(views.every(view => view.canCancel === false)).toBe(true)
})
