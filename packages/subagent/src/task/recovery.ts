import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { TaskRecord, TaskRegistry, TaskProtocolDocument } from "./types.ts"
import { loadJobRecords } from "../job-record.ts"
import { readPendingDocumentWrites } from "./document-intent.ts"
import { taskDocKey } from "./persistence.ts"

/** D-01 step 1: read-only projection integrity report. A task document is a
 * projection; the durable child session is the source of truth. This reports
 * rows that contradict it without mutating the document. */
export type TaskProjectionIssueKind = "missing-child-session" | "terminal-without-turn-end"
  | "job-record-missing" | "job-record-terminal-ahead" | "job-record-terminal-missing" | "job-record-child-mismatch"
  | "document-write-pending"
export interface TaskProjectionIssue {
  kind: TaskProjectionIssueKind
  taskId: string
  childSessionId?: string
}

export async function inspectTaskProjection(tasks: TaskRegistry, coordinator: SessionCoordinator): Promise<TaskProjectionIssue[]> {
  const issues: TaskProjectionIssue[] = []
  for (const t of tasks.list()) {
    if (t.childSessionId === undefined) continue
    const evidence = await completedTurnEvidence(coordinator, t.childSessionId)
    if (evidence === undefined) {
      issues.push({ kind: "missing-child-session", taskId: t.id, childSessionId: t.childSessionId })
      continue
    }
    // cancellation/recovery outcomes do not claim a completed child turn.
    if (t.outcome !== undefined && t.outcome !== "cancelled" && t.outcome !== "recovery-required" && evidence.turnEnd === false) {
      issues.push({ kind: "terminal-without-turn-end", taskId: t.id, childSessionId: t.childSessionId })
    }
  }
  return issues
}

/** D-07: an unmatched durable write intent means the task document write may
 * not have settled before a crash. Reported read-only, one issue per intent;
 * taskId carries the intent id so the diagnostic surfaces the unresolved write
 * without pretending it belongs to a specific task row. */
export async function inspectDocumentWriteIntents(coordinator: SessionCoordinator, stateId: string): Promise<TaskProjectionIssue[]> {
  return (await readPendingDocumentWrites(coordinator, stateId)).map(intent => ({ kind: 'document-write-pending', taskId: intent.intentId }))
}

/** D-01 step 3: compare the shadow job records with the task projection. The
 * job file is the intended source of truth; disagreement is reported read-only
 * (it never changes task status). Sessions written before step 2 have no file
 * and are treated as "job records not active" rather than as errors. */
export async function inspectJobRecordProjection(tasks: TaskRegistry, coordinator: SessionCoordinator): Promise<TaskProjectionIssue[]> {
  const rows = tasks.list()
  const parentSessionId = rows[0]?.parentSessionId
  if (parentSessionId === undefined) return []
  const loaded = await loadJobRecords(coordinator, parentSessionId)
  if (loaded.records.length === 0) return []
  const jobs = new Map(loaded.records.map(record => [record.jobId, record]))
  const issues: TaskProjectionIssue[] = []
  for (const task of rows) {
    const job = jobs.get(task.id)
    const childSessionId = task.childSessionId
    const base = { taskId: task.id, ...(childSessionId !== undefined ? { childSessionId } : {}) }
    if (!job) { issues.push({ kind: 'job-record-missing', ...base }); continue }
    if (job.childSessionId !== undefined && childSessionId !== undefined && job.childSessionId !== childSessionId) issues.push({ kind: 'job-record-child-mismatch', ...base })
    if (job.terminal !== undefined && task.outcome === undefined) issues.push({ kind: 'job-record-terminal-ahead', ...base })
    else if (job.terminal === undefined && task.outcome !== undefined && task.outcome !== 'recovery-required') issues.push({ kind: 'job-record-terminal-missing', ...base })
  }
  return issues
}

/** D-01 step 2: write the inspection result into the projection as a warning
 * marker. Status, outcome and result are never changed here; warnings that no
 * longer apply are cleared. Returns the issues that were found. */
export async function reconcileTaskProjection(tasks: TaskRegistry, coordinator: SessionCoordinator): Promise<TaskProjectionIssue[]> {
  const issues = await inspectTaskProjection(tasks, coordinator)
  const current = new Map(issues.flatMap(issue => issue.kind === 'missing-child-session' || issue.kind === 'terminal-without-turn-end' ? [[issue.taskId, issue.kind] as const] : []))
  for (const t of tasks.list()) {
    if (t.childSessionId === undefined) continue
    const kind = current.get(t.id)
    if (kind === undefined) {
      if (t.projectionWarning !== undefined) tasks.annotateProjection(t.id, undefined)
    } else if (t.projectionWarning !== kind) {
      tasks.annotateProjection(t.id, kind)
    }
  }
  return issues
}

/** D-01 step 4 e2e: rebuild the legacy task document shape from job records
 * when the mutable document is missing or unusable. The result restores through
 * the normal v1 path, so ID counter seeding and validation still apply. */
export async function rebuildTaskDocumentFromJobRecords(coordinator: SessionCoordinator, parentSessionId: string): Promise<TaskProtocolDocument | undefined> {
  const loaded = await loadJobRecords(coordinator, parentSessionId)
  if (loaded.records.length === 0) return undefined
  const tasks = loaded.records.map(record => {
    const outcome = record.terminal === undefined ? undefined
      : record.status === 'completed' ? 'completed' as const
        : record.status === 'cancelled' ? 'cancelled' as const
          : record.status === 'error' ? 'error' as const : undefined
    return {
      id: record.jobId, parentSessionId: record.parentSessionId,
      ...(record.childSessionId !== undefined ? { childSessionId: record.childSessionId } : {}),
      agentPath: record.agentPath ?? record.jobId, description: record.description ?? '', prompt: '',
      agent: record.agent ?? 'unknown', delivery: record.delivery ?? 'tool', status: record.status,
      ...(outcome !== undefined ? { outcome } : {}),
      ...(record.terminal?.reason !== undefined ? { error: record.terminal.reason } : {}),
      timeCreated: record.createdAt,
    } as TaskRecord
  })
  return { formatVersion: 1, tasks, notifications: [] }
}

/** D-01 step 4 production seam: restore the task document, or rebuild it from
 * job records when the mutable document is missing or unreadable. Returns which
 * source was used so hosts can surface a rebuilt projection. */
export async function restoreTaskDocument(tasks: TaskRegistry, coordinator: SessionCoordinator, stateId: string): Promise<'document' | 'rebuilt' | 'empty'> {
  let doc: unknown
  try { doc = await coordinator.getDocument(taskDocKey(stateId)) } catch { doc = undefined }
  if (doc !== undefined) { tasks.restore(doc as TaskProtocolDocument); return 'document' }
  const rebuilt = await rebuildTaskDocumentFromJobRecords(coordinator, stateId)
  if (rebuilt === undefined) return 'empty'
  tasks.restore(rebuilt)
  return 'rebuilt'
}

export async function classifyRestoredTasks(tasks: TaskRegistry, coordinator: SessionCoordinator): Promise<number> {
  let classified = 0
  const rows = tasks.list()
  const jobs = rows[0] === undefined ? new Map<string, import('../job-record.ts').JobRecordV1>() : new Map((await loadJobRecords(coordinator, rows[0].parentSessionId)).records.map(record => [record.jobId, record]))
  for (const t of rows) {
    if (t.outcome !== undefined || t.publication === 'unqualified') continue
    // D-01 step 4: a durable terminal job record settles the task even when the
    // (mutable) task document no longer knows it; the child session supplies the
    // result text when it still has one.
    const job = jobs.get(t.id)
    if (job?.terminal !== undefined) {
      const evidence = t.childSessionId === undefined ? undefined : await completedTurnEvidence(coordinator, t.childSessionId)
      const outcome = job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'cancelled' : 'error'
      tasks.terminalize({
        taskId: t.id, outcome,
        ...(outcome === 'completed' && evidence?.lastAssistantText !== undefined ? { resultText: evidence.lastAssistantText } : {}),
        ...(outcome !== 'completed' ? { error: job.terminal.reason ?? job.detail ?? 'terminal state recovered from the job record' } : {}),
      })
      classified += 1
      continue
    }
    const evidence = t.childSessionId === undefined
      ? undefined
      : await completedTurnEvidence(coordinator, t.childSessionId)
    if (evidence === undefined || evidence.turnEnd === false) {
      tasks.terminalize({
        taskId: t.id,
        outcome: "recovery-required",
        recoveryReason: evidence === undefined ? "dispatch-unknown" : "response-interrupted",
        error: "process restarted before the attempt settled",
      })
    } else {
      tasks.terminalize({ taskId: t.id, outcome: "completed", resultText: evidence.lastAssistantText })
    }
    classified += 1
  }
  return classified
}

// R-D3: parent 是否落在已取消的 delegation chain 上（task 以 childSessionId
// 連結祖先；1 hop 每層）。用於 outbox suppression。
export function isSessionCancelledChain(tasks: TaskRegistry, sessionId: string): boolean {
  let cur = sessionId
  for (let i = 0; i < 64; i++) {
    const t = tasks.getByChildSession(cur)
    if (!t) return false
    if (t.outcome === "cancelled") return true
    if (t.parentSessionId === "") return false
    cur = t.parentSessionId
  }
  return false
}

async function completedTurnEvidence(
  coordinator: SessionCoordinator,
  sessionId: string,
): Promise<{ turnEnd: boolean; lastAssistantText?: string } | undefined> {
  try {
    const { session } = await coordinator.load(sessionId)
    const seedLength = session.header?.seedLength ?? 0
    const after = session.events.slice(seedLength)
    const turnEnd = after.some((e) => e.type === "turn/end")
    const lastAssistant = after.filter((e) => e.type === "assistant/message").at(-1)
    return {
      turnEnd,
      ...(turnEnd && lastAssistant ? { lastAssistantText: lastAssistant.text } : {}),
    }
  } catch {
    return undefined // log 缺/損 → dispatch-unknown（呼叫端 reclassify）
  }
}
