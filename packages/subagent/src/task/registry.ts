import { validateTaskDocument } from "./validation.ts"
import { unqualifyRestoredTask, qualifyTaskPublication } from './publication.ts'
import { settleTaskRecord } from "./settlement.ts"
import { waitForObservation } from "@i-harness/core-tools"
import { TaskResultOwner } from "./result.ts"
import { TaskNotifications } from "./notifications.ts"
import { TaskPersistence } from "./persistence.ts"
import { TaskConcurrencyLimitError, TaskIdentityConflictError, type TaskIdentity, type TaskRecord, type TaskRegistryOptions, type TaskRegistry, type TaskSubmissionInput, type TaskProtocolDocument, type TaskTerminalizeInput } from "./types.ts"
export function createTaskRegistry(opts: TaskRegistryOptions = {}): TaskRegistry {
  let documentVersion: 1 | 2 = opts.results ? 2 : 1
  const records = new Map<string, TaskRecord>()
  const resultOwner = opts.results ? new TaskResultOwner(opts.results) : undefined
  const listeners = new Map<string, Set<(record: Readonly<TaskRecord>) => void>>()
  function subscribe(taskId: string, listener: (record: Readonly<TaskRecord>) => void): () => void {
    if (!records.has(taskId)) throw new Error(`unknown task: ${taskId}`)
    let set = listeners.get(taskId)
    if (!set) { set = new Set(); listeners.set(taskId, set) }
    set.add(listener)
    return () => { set.delete(listener); if (!set.size && listeners.get(taskId) === set) listeners.delete(taskId) }
  }
  function publish(record: TaskRecord): void {
    const snapshot = { ...record }
    for (const listener of [...(listeners.get(record.id) ?? [])]) {
      try { listener({ ...snapshot }) } catch { /* Observers never interrupt producers. */ }
    }
  }
  const byIdentity = new Map<string, TaskRecord>()
  const byChild = new Map<string, TaskRecord>()
  const notifications = new TaskNotifications()
  const maxConcurrency = opts.maxConcurrency ?? Infinity
  // Ruling M24a-T1a 同款：restore 時以已知最大編號 seed counter（M26-D1）
  let taskCounter = 0
  let anonCounter = 0
  const persistence = new TaskPersistence(opts.coordinator, opts.stateId, Boolean(opts.reportPolicy), snapshot)
  const save = () => persistence.save()

  function identityKey(identity: TaskIdentity): string {
    if (identity.callEventSeq !== undefined) return `${identity.parentSessionId}:${identity.callEventSeq}`
    if (identity.toolCallId !== undefined) return `${identity.parentSessionId}:call:${identity.toolCallId}`
    anonCounter += 1
    return `anon:${anonCounter}` // 每次全新 → 永不 adopt；identity-less 提交的逃逸規則
  }

  function matches(existing: TaskRecord, input: TaskSubmissionInput): boolean {
    return (
      existing.prompt === input.prompt &&
      existing.agent === input.agent &&
      existing.agentPath === input.agentPath &&
      existing.delivery === input.delivery
    )
  }

  function snapshot(): TaskProtocolDocument {
    return {
      formatVersion: documentVersion,
      tasks: [...records.values()].map(({ modelLabel, ...task }) => ({
        ...task,
        ...(modelLabel !== undefined ? { modelLabel } : {}),
      })),
      notifications: notifications.snapshot(),
    }
  }

  /** Restored retrieval is advertised only for a composition that declares a
   * real reader. An adapter object, or a store without that capability, is an
   * unsupported owner rather than a disk promise. */
  function restoredRetention(task: TaskRecord, owned: boolean): void {
    if (task.bodyKind === "legacy-text" && !task.result) { task.retention = "durable"; delete task.retentionError; return }
    if (task.result?.kind === "pending") { task.retention = "pending"; delete task.retentionError; return }
    if (task.result?.kind === "retained" && task.result.envelope.retention.kind === "artifact" && owned) { task.retention = "durable"; delete task.retentionError; return }
    task.retention = "failed"
    task.retentionError = task.result?.kind === "retained" ? "Retained task body reader unavailable" : "Retained task body incomplete"
  }

  async function retainResult(taskId: string): Promise<void> {
    const task = records.get(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    if (resultOwner) await resultOwner.settle(task)
    if (!opts.reportPolicy) return
    // The in-memory authoritative outcome is already complete. Persistence
    // failure changes delivery evidence only; it never reopens execution.
    if (!opts.coordinator || !opts.stateId) { task.retention = "memory"; return }
    if (task.retention === "pending") {
      await persistence.flush()
      const settledRetention = records.get(taskId)?.retention
      if (settledRetention === "durable") return
      if (settledRetention === "failed") throw new Error(task.retentionError)
    }
    if (task.retention === "durable") return
    task.retention = "pending"
    try {
      await save()
      if (task.result?.kind === 'retained' && task.result.envelope.retention.kind === 'unavailable') {
        task.retention = 'failed'
        task.retentionError = task.result.envelope.retention.reason
      } else {
        task.retention = "durable"
        delete task.retentionError
      }
    } catch (error) {
      task.retention = "failed"
      task.retentionError = error instanceof Error ? error.message : String(error)
      publish(task)
      throw error
    }
    publish(task)
  }

  function announceTerminal(t: TaskRecord, notify = true): void {
    notifications.enqueue(t)
    if (opts.reportPolicy) {
      void retainResult(t.id).then(() => { if (notify) opts.onTerminalized?.(t) }, () => { if (notify) opts.onTerminalized?.(t) })
    } else {
      void save().catch(() => {})
    }
    publish(t)
    if (!opts.reportPolicy && notify) opts.onTerminalized?.(t)
  }

  function terminalize(input: TaskTerminalizeInput): boolean {
    const task = records.get(input.taskId)
    if (!settleTaskRecord(task, input, resultOwner)) return false
    announceTerminal(task)
    return true
  }

  return {
    async prepareResult(taskId, context, current) {
      const task = records.get(taskId)
      if (!task) throw new Error(`unknown task: ${taskId}`)
      return resultOwner?.prepare(task, context, current)
    },
    async qualifyRestoredResults() {
      if (!opts.coordinator?.snapshot) return
      const sessions = new Map<string, Awaited<ReturnType<NonNullable<typeof opts.coordinator.snapshot>>>>()
      for (const task of records.values()) {
        if (task.publication !== 'unqualified') continue
        let snapshot = sessions.get(task.parentSessionId)
        if (!snapshot) { snapshot = await opts.coordinator.snapshot(task.parentSessionId); sessions.set(task.parentSessionId, snapshot) }
        if (qualifyTaskPublication(task, snapshot.session)) publish(task)
      }
    },
    async readResult(taskId, args) {
      const task = records.get(taskId)
      if (!task) throw new Error(`unknown task: ${taskId}`)
      if (!resultOwner) throw new Error("Retained task body reader unavailable")
      return resultOwner.read(task, args)
    },
    retainResult,
    subscribe,
    submit(input) {
      // R-D3 配額：running(非終態) 計數 >= max → fail-closed
      if (runningCountUnsafe() >= maxConcurrency) throw new TaskConcurrencyLimitError(maxConcurrency)
      const key = identityKey(input.identity)
      const existing = byIdentity.get(key)
      if (existing) {
        if (matches(existing, input)) return existing // exact retry → adopt
        throw new TaskIdentityConflictError(input.identity)
      }
      taskCounter += 1
      const record: TaskRecord = {
        id: `task-${taskCounter}`,
        parentSessionId: input.identity.parentSessionId,
        ...(input.identity.toolCallId !== undefined ? { toolCallId: input.identity.toolCallId } : {}),
        ...(input.identity.callEventSeq !== undefined ? { callEventSeq: input.identity.callEventSeq } : {}),
        ...(input.childSessionId !== undefined ? { childSessionId: input.childSessionId } : {}),
        agentPath: input.agentPath,
        description: input.description,
        prompt: input.prompt,
        agent: input.agent,
        delivery: input.delivery,
        status: "accepted",
        timeCreated: Date.now(),
      }
      records.set(record.id, record)
      byIdentity.set(key, record)
      if (record.childSessionId) byChild.set(record.childSessionId, record)
      void save().catch(() => {})
      publish(record)
      return record
    },
    get: (taskId) => records.get(taskId),
    getByIdentity(identity) { return byIdentity.get(identityKey(identity)) },
    getByChildSession: (childSessionId) => byChild.get(childSessionId),
    list: () => [...records.values()],
    notifications: () => notifications.list(),
    updateNotification(id, patch) {
      if (!notifications.update(id, patch)) return false
      void save().catch(() => {})
      return true
    },
    claim(taskId, childSessionId, modelLabel, jobId) {
      const t = records.get(taskId)
      if (!t || t.status !== "accepted") return false
      t.status = "running"
      t.timeStarted = Date.now()
      if (modelLabel !== undefined) t.modelLabel = modelLabel
      if (jobId !== undefined) t.jobId = jobId
      if (childSessionId !== undefined && t.childSessionId === undefined) {
        t.childSessionId = childSessionId
        byChild.set(childSessionId, t)
      }
      void save().catch(() => {})
      publish(t)
      return true
    },
    terminalize,
    cancelTree(taskId, error = "task cancelled by owner") {
      const root = records.get(taskId)
      if (!root) return { taskIds: [], cancelled: 0 }
      const tree = [root, ...[...records.values()].filter((r) => r.agentPath.startsWith(`${root.agentPath}/`))]
      const taskIds: string[] = []
      let cancelled = 0
      for (const t of tree) {
        if (t.outcome !== undefined) continue
        settleTaskRecord(t, { taskId: t.id, outcome: 'cancelled', error }, resultOwner)
        taskIds.push(t.id)
        cancelled += 1
      }
      for (const id of taskIds) announceTerminal(records.get(id)!, false)
      return { taskIds, cancelled }
    },
    runningCount: runningCountUnsafe,
    async wait(taskId, timeoutMs) {
      const current = records.get(taskId)
      if (!current || current.outcome !== undefined) return current
      let terminal = false
      await waitForObservation({
        ready: () => terminal || records.get(taskId)!.outcome !== undefined,
        changes: { subscribe: listener => subscribe(taskId, record => { terminal ||= record.outcome !== undefined; listener() }) },
        // Legacy non-finite positive/NaN deadlines never expired; negatives expired immediately.
        timeoutMs: timeoutMs === -Infinity ? 0 : Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : undefined,
      })
      return records.get(taskId)
    },
    restore(doc) {
      validateTaskDocument(doc)
      if (doc.formatVersion === 2) documentVersion = 2
      // Counter seeding（Ruling M24a-T1a 同款）：還原的 id 是權威——task-<n> /
      // notif-<n> 從已知最大編號續增，避免 post-restore spawn 撞 id。
      for (const t of doc.tasks) {
        const m = /^task-(\d+)$/.exec(t.id)
        if (m) taskCounter = Math.max(taskCounter, Number(m[1]))
      }
      notifications.restore(doc.notifications)
      // anonymous 還原記錄用獨立命名空間（restored-anon:N），永不與新
      // anonymous submit 的 anon:<n> 相撞——anonymous 任務永不 adopt（Task 3 規約）。
      let restoredAnon = 0
      for (const t of doc.tasks) {
        if (records.has(t.id)) throw new Error(`duplicate task id on restore: ${t.id}`)
        if (doc.formatVersion === 1) t.bodyKind = "legacy-text"
        else unqualifyRestoredTask(t)
        records.set(t.id, t)
        if (opts.reportPolicy && t.outcome !== undefined) restoredRetention(t, resultOwner?.available?.() === true)
        const anon = t.callEventSeq === undefined && t.toolCallId === undefined
        if (anon) restoredAnon += 1
        byIdentity.set(
          t.callEventSeq !== undefined
            ? `${t.parentSessionId}:${t.callEventSeq}`
            : t.toolCallId !== undefined
              ? `${t.parentSessionId}:call:${t.toolCallId}`
              : `restored-anon:${restoredAnon}`,
          t,
        )
        if (t.childSessionId) byChild.set(t.childSessionId, t)
      }
      for (const t of doc.tasks) publish(t)
    },
    save,
    flushPersistence: () => persistence.flush(),
  }

  function runningCountUnsafe(): number {
    let n = 0
    for (const t of records.values()) if (t.status === "accepted" || t.status === "running") n += 1
    return n
  }
}

