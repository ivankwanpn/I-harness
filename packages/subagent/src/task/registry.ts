import { validateTaskDocument } from "./validation.ts"
import { unqualifyRestoredTask, qualifyTaskPublication } from './publication.ts'
import { settleTaskRecord } from "./settlement.ts"
import { waitForObservation } from "@i-harness/core-tools"
import { TaskResultOwner } from "./result.ts"
import { TaskNotifications } from "./notifications.ts"
import { TaskPersistence } from "./persistence.ts"
import { associateTaskSaveOwner } from './save-owner.ts'
import { TaskRecords } from "./records.ts"
import { type TaskRecord, type TaskRegistryOptions, type TaskRegistry, type TaskProtocolDocument, type TaskTerminalizeInput } from "./types.ts"
export function createTaskRegistry(opts: TaskRegistryOptions = {}): TaskRegistry {
  let documentVersion: 1 | 2 = opts.results ? 2 : 1
  const records = new TaskRecords()
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
  const notifications = new TaskNotifications()
  const maxConcurrency = opts.maxConcurrency ?? Infinity
  const persistence = new TaskPersistence(opts.coordinator, opts.stateId, Boolean(opts.reportPolicy), snapshot, opts.ownedTask)
  const retentionSaves = new WeakMap<TaskRecord, import('./persistence.ts').OwnedTaskSave>()
  const retentionFlights = new WeakMap<TaskRecord, Promise<void>>()
  const save = () => persistence.save()

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
    if (task.legacyFormatVersion === 1 && !task.result) { task.retention = "durable"; delete task.retentionError; return }
    if (task.result?.kind === "pending") { task.retention = "pending"; delete task.retentionError; return }
    if (task.result?.kind === "retained" && task.result.envelope.retention.kind === "artifact" && owned) { task.retention = "durable"; delete task.retentionError; return }
    task.retention = "failed"
    task.retentionError = task.result?.kind === "retained" ? "Retained task body reader unavailable" : "Retained task body incomplete"
  }

  function retainResult(taskId: string): Promise<void> {
    const task = records.get(taskId)
    if (!task) return Promise.reject(new Error(`unknown task: ${taskId}`))
    const previous = retentionFlights.get(task)
    if (previous) return previous
    const flight = retainResultOnce(taskId)
    retentionFlights.set(task, flight)
    void flight.finally(() => { if (retentionFlights.get(task) === flight) retentionFlights.delete(task) }).catch(() => {})
    return flight
  }

  async function retainResultOnce(taskId: string): Promise<void> {
    const task = records.get(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    if (!task.result && (task.publication === 'unqualified' || documentVersion === 2 && task.legacyFormatVersion !== 1)) throw new Error('Retained task body incomplete')
    if (resultOwner) await resultOwner.settle(task)
    if (!opts.reportPolicy) return
    // The in-memory authoritative outcome is already complete. Persistence
    // failure changes delivery evidence only; it never reopens execution.
    if (!opts.coordinator || !opts.stateId) { task.retention = "memory"; return }
    if (task.retention === "durable") return
    task.retention = "pending"
    try {
      const previous = retentionSaves.get(task)
      const originalSave = previous ?? persistence.captureSave(true)
      if (originalSave) { retentionSaves.set(task, originalSave); if (previous) await originalSave.retry(); else await originalSave.done; originalSave.assertHandoff() }
      else await save()
      if (task.result?.kind === 'retained' && task.result.envelope.retention.kind === 'unavailable') {
        task.retention = 'failed'
        task.retentionError = task.result.envelope.retention.reason
      } else {
        task.retention = "durable"
        delete task.retentionError
      }
      originalSave?.release()
    } catch (error) {
      task.retention = "failed"
      task.retentionError = error instanceof Error ? error.message : String(error)
      publish(task)
      throw error
    }
    publish(task)
  }

  function announceTerminal(t: TaskRecord, notify = true): void {
    // A genuine new current capture leaves historical text recovery behind.
    if (t.result) delete t.legacyFormatVersion
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

  const registry: TaskRegistry = {
    bindForegroundHandoff(taskId) {
      const task = records.get(taskId)
      if (!task || task.delivery !== 'tool') throw new Error('Original foreground task unavailable')
      // A recipient binding certifies source identity, not owned task storage.
      // Unsupported compositions keep their original tool/manual route.
      if (!opts.coordinator || !opts.stateId || !opts.reportPolicy || !opts.ownedTask) return () => ({ kind: 'manual' })
      let selected: ReturnType<TaskRegistry['bindForegroundHandoff']> extends () => infer R ? R : never
      return () => {
        if (selected) return selected
        if (records.get(taskId) !== task) throw new Error('Original foreground task replaced')
        if (task.outcome !== undefined) return selected = { kind: 'ready' }
        task.delivery = 'parent'
        const save = persistence.captureSave(true)
        if (!save) { task.delivery = 'tool'; throw new Error('Durable foreground handoff unavailable') }
        return selected = { kind: 'parent', save }
      }
    },
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
      const { record, inserted } = records.submit(input, maxConcurrency)
      if (!inserted) return record
      void save().catch(() => {})
      publish(record)
      return record
    },
    get: (taskId) => records.get(taskId),
    getByIdentity: identity => records.getByIdentity(identity),
    getByChildSession: (childSessionId) => records.getByChildSession(childSessionId),
    list: () => [...records.values()],
    notifications: () => notifications.list(),
    updateNotification(id, patch) {
      if (!notifications.update(id, patch)) return false
      void save().catch(() => {})
      return true
    },
    claim(taskId, childSessionId, modelLabel, jobId) {
      const t = records.claim(taskId, childSessionId, modelLabel, jobId)
      if (!t) return false
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
    runningCount: () => records.runningCount(),
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
      records.seedRestoredCounter(doc.tasks)
      notifications.restore(doc.notifications)
      // anonymous 還原記錄用獨立命名空間（restored-anon:N），永不與新
      // anonymous submit 的 anon:<n> 相撞——anonymous 任務永不 adopt（Task 3 規約）。
      let restoredAnon = 0
      for (const t of doc.tasks) {
        records.checkRestoredId(t.id)
        if (doc.formatVersion === 1) { t.bodyKind = "legacy-text"; t.legacyFormatVersion = 1 }
        else unqualifyRestoredTask(t)
        records.insertRestored(t)
        if (opts.reportPolicy && t.outcome !== undefined) restoredRetention(t, resultOwner?.available?.() === true)
        const anon = t.callEventSeq === undefined && t.toolCallId === undefined
        if (anon) restoredAnon += 1
        records.indexRestored(t, restoredAnon)
      }
      for (const t of doc.tasks) publish(t)
    },
    save,
    flushPersistence: () => persistence.flush(),
  }
  associateTaskSaveOwner(registry, persistence)
  return registry

}
