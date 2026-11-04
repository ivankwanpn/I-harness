import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { TaskStatus } from './task/types.ts'

/** D-01 step 1: one durable, append-only job record per subagent task.
 * The record is deliberately independent of the mutable task document; later
 * steps make it (plus the child session) the only source of truth and demote
 * the document to a projection. */
export interface JobRecordV1 {
  version: 1
  jobId: string
  parentSessionId: string
  childSessionId?: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  terminal?: { at: number; reason?: string }
  detail?: string
  /** Projection metadata so a missing task document can be rebuilt faithfully. */
  agentPath?: string
  description?: string
  agent?: string
  delivery?: 'tool' | 'parent'
}

export interface JobLoadResult {
  records: JobRecordV1[]
  warnings: string[]
}

const STATUSES = new Set<TaskStatus>(['accepted', 'running', 'completed', 'error', 'cancelled', 'recovery-required'])
const TERMINAL = new Set<TaskStatus>(['completed', 'error', 'cancelled'])
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function validRecord(value: unknown): value is JobRecordV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (row.version !== 1 || typeof row.jobId !== 'string' || !row.jobId || row.jobId.length > 256) return false
  if (typeof row.parentSessionId !== 'string' || !row.parentSessionId || row.parentSessionId.length > 256) return false
  if (row.childSessionId !== undefined && (typeof row.childSessionId !== 'string' || !row.childSessionId)) return false
  if (!STATUSES.has(row.status as TaskStatus) || !isTime(row.createdAt) || !isTime(row.updatedAt) || row.createdAt > row.updatedAt) return false
  if (row.detail !== undefined && (typeof row.detail !== 'string' || row.detail.length > 64 * 1024)) return false
  for (const key of ['agentPath', 'description', 'agent'] as const) {
    const field = row[key]
    if (field !== undefined && (typeof field !== 'string' || field.length > 64 * 1024)) return false
  }
  if (row.delivery !== undefined && row.delivery !== 'tool' && row.delivery !== 'parent') return false
  if (row.terminal === undefined) return !TERMINAL.has(row.status as TaskStatus)
  if (!TERMINAL.has(row.status as TaskStatus)) return false
  const terminal = row.terminal as Record<string, unknown>
  return typeof terminal === 'object' && terminal !== null && isTime(terminal.at)
    && (terminal.reason === undefined || typeof terminal.reason === 'string')
}

export function createJobRecordStore(filePath: string) {
  return {
    async append(record: JobRecordV1): Promise<void> {
      if (!validRecord(record)) throw new TypeError('Invalid job record')
      await mkdir(dirname(filePath), { recursive: true })
      await appendFile(filePath, JSON.stringify(record) + '\n', 'utf8')
    },
    async load(): Promise<JobLoadResult> {
      const text = await readFile(filePath, 'utf8').catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === 'ENOENT') return ''
        throw cause
      })
      const warnings: string[] = [], records = new Map<string, JobRecordV1>()
      for (const [index, line] of text.split('\n').entries()) {
        if (!line) continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { warnings.push(`line ${index + 1}: invalid JSON`); continue }
        if (!validRecord(parsed)) { warnings.push(`line ${index + 1}: invalid job record`); continue }
        const previous = records.get(parsed.jobId)
        if (previous?.terminal) {
          // A terminal job is final; a later record claiming otherwise is a
          // corruption signal, not a state transition.
          warnings.push(`line ${index + 1}: record after terminal for ${parsed.jobId}`)
          continue
        }
        records.set(parsed.jobId, parsed)
      }
      return { records: [...records.values()].sort((left, right) => left.createdAt - right.createdAt), warnings }
    },
  }
}

export type JobRecordStore = ReturnType<typeof createJobRecordStore>

export async function loadJobRecords(coordinator: Pick<SessionCoordinator, 'storageRoot'>, parentSessionId: string): Promise<JobLoadResult> {
  if (!coordinator.storageRoot) return { records: [], warnings: ['job record storage root unavailable'] }
  return createJobRecordStore(join(coordinator.storageRoot, 'jobs', `${parentSessionId}.jobs.jsonl`)).load()
}

/** D-01 degraded mode: read-only task rows derived from durable job records.
 * Used when the mutable task document is unavailable; never used to admit work
 * (write ownership requires the real document). */
export interface RecoveredTaskRow {
  taskId: string
  parentSessionId: string
  childSessionId?: string
  status: TaskStatus
  outcome?: 'completed' | 'error' | 'cancelled' | 'recovery-required'
  error?: string
  agentPath?: string
  description?: string
  createdAt: number
  updatedAt: number
}

export async function readRecoveredTaskRows(coordinator: Pick<SessionCoordinator, 'storageRoot'>, parentSessionId: string): Promise<RecoveredTaskRow[]> {
  const loaded = await loadJobRecords(coordinator, parentSessionId)
  return loaded.records.map(record => ({
    taskId: record.jobId, parentSessionId: record.parentSessionId,
    ...(record.childSessionId !== undefined ? { childSessionId: record.childSessionId } : {}),
    status: record.status,
    ...(record.terminal !== undefined ? { outcome: (record.status === 'completed' ? 'completed' : record.status === 'cancelled' ? 'cancelled' : record.status === 'error' ? 'error' : 'recovery-required') as RecoveredTaskRow['outcome'] } : {}),
    ...(record.terminal?.reason !== undefined ? { error: record.terminal.reason } : record.detail !== undefined ? { error: record.detail } : {}),
    ...(record.agentPath !== undefined ? { agentPath: record.agentPath } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  }))
}
