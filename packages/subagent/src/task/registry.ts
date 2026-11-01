import { observeColdExecutionWrites } from '../../../session-persistence/src/coordinator/cold-execution-writes.ts'
import { managedExecutionStatus } from '../../../session-persistence/src/coordinator/managed-document.ts'
import { createTaskLaunchPort, type TaskLaunchPort } from './launch-slots.ts'
import { stageTaskRestore } from './restore-stage.ts'
import { associateColdBindings, assertColdTaskAdmission } from './cold-bindings.ts'
import { isOwnedTaskContext } from './owned-context.ts'
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
  let stopObserving: (()=>void)|undefined
  let launchPort: TaskLaunchPort | undefined
  const ownedTask = opts.ownedTask
  if(opts.launchContext){
    if(!ownedTask||!isOwnedTaskContext(ownedTask))throw Error('Original task launch parent required')
    const document=opts.launchContext.factOwner as import('@i-harness/session-persistence').ManagedDocument
    ownedTask.operations.assertParentSession(ownedTask.operations.parent(document),ownedTask.stateId)
    const view=Object.getOwnPropertyDescriptor(document,'view')
    if(!view||!('value'in view)||view.value!==opts.launchContext.view||opts.launchContext.sessionId!==ownedTask.stateId)throw Error('Foreign task launch parent')
  }
  type State = { records: TaskRecords; notifications: TaskNotifications; version: 1 | 2 | 3; phase: 'pending' | 'ready' | 'poisoned' | 'retired'; failure?: { cause: unknown } }
  let currentState: State = { records: new TaskRecords(), notifications: new TaskNotifications(), version: opts.results ? 2 : 1, phase: ownedTask ? 'pending' : 'ready' }
  let coldBindings: ReadonlySet<string> = new Set()
  function assertReady() {
    if (currentState.phase !== 'ready') throw Object.assign(new Error('Task registry ' + currentState.phase, { cause: currentState.failure?.cause }), { code: 'TASK_REGISTRY_UNAVAILABLE' })
    if (ownedTask) ownedTask.operations.assertParentSession(ownedTask.parent, opts.stateId!)
  }
  const resultOwner = opts.results ? new TaskResultOwner(opts.results) : undefined
  const listeners = new Map<string, Set<(record: Readonly<TaskRecord>) => void>>()
  function subscribe(taskId: string, listener: (record: Readonly<TaskRecord>) => void): () => void {
    assertReady()
    if (!currentState.records.has(taskId)) throw new Error(`unknown task: ${taskId}`)
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
  const maxConcurrency = opts.maxConcurrency ?? Infinity
  const persistence = new TaskPersistence(opts.coordinator, opts.stateId, Boolean(opts.reportPolicy), snapshot, ownedTask)
  const retentionSaves = new WeakMap<TaskRecord, import('./persistence.ts').OwnedTaskSave>()
  const retentionFlights = new WeakMap<TaskRecord, Promise<void>>()
  const save = async () => { assertReady(); await persistence.save() }

  function snapshot(): TaskProtocolDocument {
    assertReady()
    launchPort?.assertSnapshot()
    // A loaded literal 1 remains literal until a subsequent result-aware save.
    if (currentState.version === 1 && opts.results) currentState.version = 2
    return {
      formatVersion: currentState.version,
      tasks: [...currentState.records.values()].map(({ modelLabel, ...task }) => ({
        ...task,
        ...(modelLabel !== undefined ? { modelLabel } : {}),
      })),
      notifications: currentState.notifications.snapshot(),
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
    assertReady()
    const task = currentState.records.get(taskId)
    if (!task) return Promise.reject(new Error(`unknown task: ${taskId}`))
    const previous = retentionFlights.get(task)
    if (previous) return previous
    const flight = retainResultOnce(taskId)
    retentionFlights.set(task, flight)
    void flight.finally(() => { if (retentionFlights.get(task) === flight) retentionFlights.delete(task) }).catch(() => {})
    return flight
  }

  async function retainResultOnce(taskId: string): Promise<void> {
    const task = currentState.records.get(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    if (!task.result && (task.publication === 'unqualified' || currentState.version >= 2 && task.legacyFormatVersion !== 1)) throw new Error('Retained task body incomplete')
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
    currentState.notifications.enqueue(t)
    if (opts.reportPolicy) {
      void retainResult(t.id).then(() => { if (notify) opts.onTerminalized?.(t) }, () => { if (notify) opts.onTerminalized?.(t) })
    } else {
      void save().catch(() => {})
    }
    publish(t)
    if (!opts.reportPolicy && notify) opts.onTerminalized?.(t)
  }

  function terminalize(input: TaskTerminalizeInput): boolean {
    assertReady()
    launchPort?.retireTask(input.taskId, new Error('Task terminalized'))
    const task = currentState.records.get(input.taskId)
    if (!settleTaskRecord(task, input, resultOwner)) return false
    announceTerminal(task)
    return true
  }

  const controller = new AbortController()
  type Operation = Awaited<ReturnType<NonNullable<TaskRegistryOptions['ownedTask']>['operations']['begin']>>
  let operation: Operation | undefined
  let handoff: ReturnType<Operation['prepareReadHandoff']> | undefined
  let beginCleanup: ReturnType<NonNullable<TaskRegistryOptions['ownedTask']>['operations']['cleanupFor']>
  let resourcesClosed = false, closeAttempted = false
  let cleanupFlight: Promise<void> | undefined
  function cleanupLoad(): Promise<void> {
    if (cleanupFlight) return cleanupFlight
    const flight = (async () => {
      handoff?.abandon()
      if (operation && !resourcesClosed) {
        if (closeAttempted) await operation.retryClose()
        else { closeAttempted = true; await operation.close() }
        resourcesClosed = true
      }
      if (beginCleanup) { await beginCleanup.retry(); beginCleanup = undefined }
    })()
    cleanupFlight = flight
    void flight.finally(() => { if (cleanupFlight === flight) cleanupFlight = undefined }).catch(() => {})
    return flight
  }
  // Only this original load closure can see its staged candidate and handoff.
  async function loadOwned(): Promise<void> {
    const owned = ownedTask!
    try {
      if (!isOwnedTaskContext(owned) || owned.coordinator !== opts.coordinator || owned.stateId !== opts.stateId) throw new Error('Original task owner unavailable')
      operation = await owned.operations.begin(owned.parent, { signal: controller.signal })
      const observed = await operation.observe()
      if (observed.kind !== 'present') throw new Error('Owned task document is absent')
      const staged = stageTaskRestore(observed.value as TaskProtocolDocument, Boolean(opts.reportPolicy), resultOwner?.available?.() === true)
      if (staged.version === 3) owned.operations.assertTaskV3Parent(owned.parent, opts.stateId!)
      const readyState: State = { records: staged.records, notifications: staged.notifications, version: staged.version, phase: 'ready' }
      const stagedColdBindings = new Set(staged.version === 3 ? [...staged.records.values()].filter(task => task.childBirth).flatMap(task => [task.childBirth!.request.invocation.targetSessionId, 'task:' + task.id]) : [])
      const confirmed = await operation.confirm(observed.witness)
      if (confirmed.kind !== 'confirmed' || confirmed.cleanupPending) throw new Error('Owned task read was not confirmed', { cause: confirmed })
      handoff = operation.prepareReadHandoff(observed.witness)
      closeAttempted = true
      await operation.close(); resourcesClosed = true
      if (currentState.phase !== 'pending' || controller.signal.aborted) throw new Error('Original task load retired')
      if (staged.version === 3) owned.operations.assertTaskV3Parent(owned.parent, opts.stateId!)
      // No callback, allocation, validation or await between consume and swap.
      handoff.consume()
      currentState = readyState
      coldBindings = stagedColdBindings
      for (const task of currentState.records.values()) publish(task)
    } catch (cause) {
      if (!operation) beginCleanup = owned.operations.cleanupFor(cause)
      currentState = { ...currentState, phase: 'poisoned', failure: { cause } }
      try { await cleanupLoad() } catch (cleanup) { throw new AggregateError([cause, cleanup], 'Owned task load and cleanup failed') }
      throw cause
    } finally { handoff?.abandon() }
  }
  const ready = ownedTask ? loadOwned() : Promise.resolve()
  void ready.catch(() => {})
  function retireOwnedLoad(): void {
    launchPort?.retireAll(new Error('Task launch owner retired'))
    if (!ownedTask) return
    if (currentState.phase !== 'poisoned') currentState = { ...currentState, phase: 'retired' }
    controller.abort(); handoff?.abandon()
  }
  const registry: TaskRegistry = {
    ready,
    assertReady,
    retireOwnedLoad,
    async closeOwnedLoad() { launchPort?.retireAll(new Error('Original slot owner closed'));stopObserving?.();stopObserving=undefined;await ready.catch(() => {}); await cleanupLoad(); await launchPort?.close(); await persistence.retireConsumers(); await persistence.flush() },
    bindForegroundHandoff(taskId) {
      assertReady()
      const task = currentState.records.get(taskId)
      if (!task || task.delivery !== 'tool') throw new Error('Original foreground task unavailable')
      // A recipient binding certifies source identity, not owned task storage.
      // Unsupported compositions keep their original tool/manual route.
      if (!opts.coordinator || !opts.stateId || !opts.reportPolicy || !ownedTask) return () => ({ kind: 'manual' })
      let selected: ReturnType<TaskRegistry['bindForegroundHandoff']> extends () => infer R ? R : never
      return () => {
        assertReady()
        if (selected) return selected
        if (currentState.records.get(taskId) !== task) throw new Error('Original foreground task replaced')
        if (task.outcome !== undefined) return selected = { kind: 'ready' }
        task.delivery = 'parent'
        const save = persistence.captureSave(true)
        if (!save) { task.delivery = 'tool'; throw new Error('Durable foreground handoff unavailable') }
        return selected = { kind: 'parent', save }
      }
    },
    async prepareResult(taskId, context, current) {
      assertReady()
      const task = currentState.records.get(taskId)
      if (!task) throw new Error(`unknown task: ${taskId}`)
      return resultOwner?.prepare(task, context, current)
    },
    async qualifyRestoredResults() {
      assertReady()
      if (!opts.coordinator?.snapshot) return
      const sessions = new Map<string, Awaited<ReturnType<NonNullable<typeof opts.coordinator.snapshot>>>>()
      for (const task of currentState.records.values()) {
        if (task.publication !== 'unqualified') continue
        let snapshot = sessions.get(task.parentSessionId)
        if (!snapshot) { snapshot = await opts.coordinator.snapshot(task.parentSessionId); sessions.set(task.parentSessionId, snapshot) }
        if (qualifyTaskPublication(task, snapshot.session)) publish(task)
      }
    },
    async readResult(taskId, args) {
      assertReady()
      const task = currentState.records.get(taskId)
      if (!task) throw new Error(`unknown task: ${taskId}`)
      if (!resultOwner) throw new Error("Retained task body reader unavailable")
      return resultOwner.read(task, args)
    },
    retainResult,
    subscribe,
    submit(input) {
      assertReady()
      if (input.identity.callEventSeq !== undefined || input.identity.toolCallId !== undefined) {
        const existing=currentState.records.getByIdentity(input.identity)
        assertColdTaskAdmission(registry, existing?.id)
        if(existing&&launchPort?.inspect(existing.id))throw Error('Original warm task slot admission required')
      }
      const { record, inserted } = currentState.records.submit(input, maxConcurrency)
      if (currentState.version === 3) currentState.records.protectSubmission(record)
      if (!inserted) return record
      void save().catch(() => {})
      publish(record)
      return record
    },
    get: (taskId) => { assertReady(); return currentState.records.get(taskId) },
    getByIdentity: identity => { assertReady(); return currentState.records.getByIdentity(identity) },
    getByChildSession: (childSessionId) => { assertReady(); return currentState.records.getByChildSession(childSessionId) },
    list: () => { assertReady(); return [...currentState.records.values()] },
    notifications: () => { assertReady(); return currentState.notifications.list() },
    updateNotification(id, patch) {
      assertReady()
      if (!currentState.notifications.update(id, patch)) return false
      void save().catch(() => {})
      return true
    },
    claim(taskId, childSessionId, modelLabel, jobId) {
      assertReady()
      const t = currentState.records.claim(taskId, childSessionId, modelLabel, jobId)
      if (!t) return false
      void save().catch(() => {})
      publish(t)
      return true
    },
    terminalize,
    cancelTree(taskId, error = "task cancelled by owner") {
      assertReady()
      const root = currentState.records.get(taskId)
      if (!root) return { taskIds: [], cancelled: 0 }
      const tree = [root, ...[...currentState.records.values()].filter((r) => r.agentPath.startsWith(`${root.agentPath}/`))]
      const taskIds: string[] = []
      let cancelled = 0
      for (const t of tree) {
        if (t.outcome !== undefined) continue
        launchPort?.retireTask(t.id, new Error(error))
        settleTaskRecord(t, { taskId: t.id, outcome: 'cancelled', error }, resultOwner)
        taskIds.push(t.id)
        cancelled += 1
      }
      for (const id of taskIds) announceTerminal(currentState.records.get(id)!, false)
      return { taskIds, cancelled }
    },
    runningCount: () => { assertReady(); return currentState.records.runningCount() },
    async wait(taskId, timeoutMs) {
      assertReady()
      const current = currentState.records.get(taskId)
      if (!current || current.outcome !== undefined) return current
      let terminal = false
      await waitForObservation({
        ready: () => terminal || currentState.records.get(taskId)!.outcome !== undefined,
        changes: { subscribe: listener => subscribe(taskId, record => { terminal ||= record.outcome !== undefined; listener() }) },
        // Legacy non-finite positive/NaN deadlines never expired; negatives expired immediately.
        timeoutMs: timeoutMs === -Infinity ? 0 : Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : undefined,
      })
      return currentState.records.get(taskId)
    },
    restore(doc) {
      if (ownedTask) throw new Error("Owned task restore requires original load")
      validateTaskDocument(doc)
      if (doc.formatVersion === 3) throw new Error('Task v3 adoption requires original eligible parent')
      const restoredColdBindings = coldBindings
      if (doc.formatVersion === 2 && currentState.version !== 3) currentState.version = doc.formatVersion
      // Counter seeding（Ruling M24a-T1a 同款）：還原的 id 是權威——task-<n> /
      // notif-<n> 從已知最大編號續增，避免 post-restore spawn 撞 id。
      currentState.records.seedRestoredCounter(doc.tasks)
      currentState.notifications.restore(doc.notifications)
      // anonymous 還原記錄用獨立命名空間（restored-anon:N），永不與新
      // anonymous submit 的 anon:<n> 相撞——anonymous 任務永不 adopt（Task 3 規約）。
      let restoredAnon = 0
      for (const t of doc.tasks) {
        currentState.records.checkRestoredId(t.id)
        if (doc.formatVersion === 1) { t.bodyKind = "legacy-text"; t.legacyFormatVersion = 1 }
        else unqualifyRestoredTask(t)
        currentState.records.insertRestored(t)
        if (opts.reportPolicy && t.outcome !== undefined) restoredRetention(t, resultOwner?.available?.() === true)
        const anon = t.callEventSeq === undefined && t.toolCallId === undefined
        if (anon) restoredAnon += 1
        currentState.records.indexRestored(t, restoredAnon)
      }
      coldBindings = restoredColdBindings
      for (const t of doc.tasks) publish(t)
    },
    save,
    flushPersistence: async () => { assertReady(); await persistence.flush() },
  }
  if (ownedTask && opts.launchContext) launchPort = createTaskLaunchPort(registry, opts.launchContext, {
    current(record) { assertReady();if(record&&currentState.records.get(record.id)!==record)throw Error('Original slot task replaced'); ownedTask.operations.assertTaskV3Parent(ownedTask.parent, opts.stateId!) },
    insert: input => currentState.records.submit(input, maxConcurrency),
    protect: record => currentState.records.protectSubmission(record, true),
    accept(record) { const saving=save();publish(record);return saving },
    bind(record,birth) {
      assertReady();ownedTask.operations.assertTaskV3Parent(ownedTask.parent,opts.stateId!)
      if(currentState.records.get(record.id)!==record||Object.hasOwn(record,'childBirth')||!Object.isExtensible(record))throw Error('Original warm task birth unavailable')
      const captured=birth
      const document=snapshot();document.formatVersion=3;document.tasks=document.tasks.map(task=>task.id===record.id?{...task,childBirth:captured}:task)
      validateTaskDocument(document)
      const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}};freeze(captured)
      Object.defineProperty(record,'childBirth',{value:captured,enumerable:true,writable:false,configurable:false});currentState.version=3
      return persistence.captureBindingSave()
    },
  })
  if(ownedTask&&opts.launchContext)stopObserving=observeColdExecutionWrites(ownedTask.coordinator,id=>{
    if(id===ownedTask.stateId&&managedExecutionStatus(opts.launchContext!.factOwner as import('@i-harness/session-persistence').ManagedDocument)==='retired')launchPort?.retireAll(new Error('Original task parent retired'))
  })
  associateTaskSaveOwner(registry, persistence)
  associateColdBindings(registry, () => coldBindings)
  return registry

}
