import {associateRequiredTaskRegistry,installRequiredTaskData,isInstalledRequiredTaskData,type RequiredTaskSettlement} from './required-settlement.ts'
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
import {captureTaskSnapshot} from '@i-harness/session-persistence/internal/task-document-operations'
import { TaskRecords } from "./records.ts"
import { type TaskRecord, type TaskRegistryOptions, type TaskRegistry, type TaskProtocolDocument, type TaskTerminalizeInput } from "./types.ts"
export function createTaskRegistry(opts: TaskRegistryOptions = {}): TaskRegistry {
  const ownedTask = opts.ownedTask
  type State = { records: TaskRecords; notifications: TaskNotifications; version: 1 | 2 | 3; phase: 'pending' | 'ready' | 'poisoned' | 'retired'; failure?: { cause: unknown } }
  let currentState: State = { records: new TaskRecords(), notifications: new TaskNotifications(), version: opts.results ? 2 : 1, phase: ownedTask ? 'pending' : 'ready' }
  const installedData=Object.freeze({})
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
  const requiredSaveAuthorities=new WeakMap<object,{parent:object;capture:()=>TaskProtocolDocument;beforeIssue:()=>Promise<void>}>()
  const persistence = new TaskPersistence(opts.coordinator, opts.stateId, Boolean(opts.reportPolicy), snapshot, ownedTask,authority=>{const original=requiredSaveAuthorities.get(authority);if(!original)throw Error('Original required Task capture unavailable');return original})
  const retentionSaves = new WeakMap<TaskRecord, import('./persistence.ts').OwnedTaskSave>()
  type RetentionIdentity={revision:string|undefined;fingerprint:string}
  const acknowledgedRetention = new WeakMap<TaskRecord, RetentionIdentity>()
  const capturedRetention = new WeakMap<TaskRecord, RetentionIdentity>()
  const retentionIdentity=(task:TaskRecord):RetentionIdentity=>({revision:task.result?.revision,fingerprint:JSON.stringify(captureTaskSnapshot(task.result??null))})
  const sameRetention=(identity:RetentionIdentity,task:TaskRecord)=>identity.revision===task.result?.revision&&identity.fingerprint===retentionIdentity(task).fingerprint
  const nativeTerminals=new WeakMap<TaskRecord,Readonly<TaskRecord>>(),terminalIntents=new WeakMap<TaskRecord,Readonly<TaskRecord>>()
  const terminalData=(task:Readonly<TaskRecord>,nativeOnly=false)=>{const data:Record<string,unknown>=Object.create(null);for(const[key,field]of Object.entries(Object.getOwnPropertyDescriptors(task))){if(!field.enumerable||nativeOnly&&(key==='retention'||key==='retentionError'))continue;if(!('value'in field))throw Error('Original Task data accessor changed');Object.defineProperty(data,key,{value:field.value,enumerable:true})};return data}
  const captureTerminal=(task:Readonly<TaskRecord>)=>captureTaskSnapshot(terminalData(task)) as Readonly<TaskRecord>
  const terminalFingerprint=(task:Readonly<TaskRecord>)=>JSON.stringify(captureTaskSnapshot(terminalData(task,true)))
  const retentionPrerequisites=new WeakMap<TaskRecord,()=>Promise<void>>()
  const retentionFlights = new WeakMap<TaskRecord, Promise<void>>()
  const terminalSettlements=new WeakMap<TaskRecord,Promise<void>>()
  const save = async () => { assertReady(); await persistence.save() }

  function snapshot():TaskProtocolDocument {assertReady();return snapshotData()}
  function snapshotData(): TaskProtocolDocument {
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
    const acknowledged=acknowledgedRetention.get(task)
    if(acknowledged){
      if(!sameRetention(acknowledged,task))throw Error('Original saved task result changed')
      return
    }
    if (task.retention === "durable") return
    task.retention = "pending"
    try {
      const previous = retentionSaves.get(task)
      const captured=previous?capturedRetention.get(task)!:retentionIdentity(task)
      if(!previous)nativeTerminals.set(task,captureTerminal(task))
      const originalSave = previous ?? persistence.captureSave(true,retentionPrerequisites.get(task))
      if (originalSave) { retentionSaves.set(task, originalSave);capturedRetention.set(task,captured); if (previous) await originalSave.retry(); else await originalSave.done; originalSave.assertHandoff() }
      else await save()
      originalSave?.release()
      acknowledgedRetention.set(task,captured);retentionSaves.delete(task);capturedRetention.delete(task)
      if(!sameRetention(captured,task))throw Error('Original saved task result changed')
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
    // A genuine new current capture leaves historical text recovery behind.
    if (t.result) delete t.legacyFormatVersion
    terminalIntents.set(t,captureTerminal(t))
    currentState.notifications.enqueue(t)
    if (opts.reportPolicy) {
      const originalRetention=retainResult(t.id);terminalSettlements.set(t,originalRetention)
      void originalRetention.then(() => { if (notify) opts.onTerminalized?.(t) }, () => { if (notify) opts.onTerminalized?.(t) })
    } else {
      const originalSave=save();terminalSettlements.set(t,originalSave);void originalSave.catch(() => {})
    }
    publish(t)
    if (!opts.reportPolicy && notify) opts.onTerminalized?.(t)
  }

  function terminalize(input: TaskTerminalizeInput): boolean {
    assertReady()
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
      installRequiredTaskData(owned.operations,opts.stateId!,installedData)
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
    if (!ownedTask) return
    if (currentState.phase !== 'poisoned') currentState = { ...currentState, phase: 'retired' }
    controller.abort(); handoff?.abandon()
  }
  const liveAccepted=new WeakSet<TaskRecord>()
  const registry: TaskRegistry = {
    ready,
    assertReady,
    retireOwnedLoad,
    async closeOwnedLoad() { await ready.catch(() => {}); await cleanupLoad(); await persistence.retireConsumers(); await persistence.flush() },
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
        assertColdTaskAdmission(registry, currentState.records.getByIdentity(input.identity)?.id)
      }
      const { record, inserted } = currentState.records.submit(input, maxConcurrency)
      if (currentState.version === 3) currentState.records.protectSubmission(record)
      if (!inserted) return record
      liveAccepted.add(record)
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
    // Cleanup joins original initialization/writes even after work is retired.
    // Failed initialization retains its original rejection; no work is admitted.
    flushPersistence: async () => { await ready; await persistence.flush() },
  }
  const requiredTasks=new WeakSet<TaskRecord>()
  associateRequiredTaskRegistry(registry,async(task,source,producer)=>{
    if(!ownedTask)return undefined;assertReady();if(task.parentSessionId!==opts.stateId||!liveAccepted.has(task)||currentState.records.get(task.id)!==task||task.outcome!==undefined||requiredTasks.has(task))throw Error('Original required Task unavailable');requiredTasks.add(task);
    const records=currentState.records,notifications=currentState.notifications,parent=await ownedTask.operations.requiredParent(ownedTask.document,source as import('@i-harness/core-session').SettlementFacts);
    const check=()=>{if(!isInstalledRequiredTaskData(ownedTask.operations,opts.stateId!,installedData)||currentState.records!==records||currentState.notifications!==notifications||currentState.phase==='poisoned'||records.get(task.id)!==task)throw Error('Original required Task incarnation replaced');source.assertHeld();ownedTask.operations.assertTaskV3Parent(parent,opts.stateId!)};check();
    let save:import('./persistence.ts').OwnedTaskSave|undefined,flight:Promise<Readonly<TaskRecord>>|undefined,revision:string|undefined,consumed=false,released=false,saveAttempted=false;
    let originalInput:TaskTerminalizeInput|undefined,saveIdentity:RetentionIdentity|undefined,sealedTerminal:Readonly<TaskRecord>|undefined
    const drive=async()=>{
      if(!save){const input=originalInput??=Object.freeze({...await producer()});check();if(input.taskId!==task.id)throw Error('Original required Task producer changed');
        const priorTerminal=task.outcome!==undefined?terminalSettlements.get(task):undefined;const won=(():boolean=>settleTaskRecord(task,input,resultOwner))();revision=task.result?.revision;if(!won&&priorTerminal){await priorTerminal;check();if(task.result?.revision!==revision)throw Error('Original Stop result changed');const ack=acknowledgedRetention.get(task);if(opts.reportPolicy&&(!ack||!sameRetention(ack,task)))throw Error('Original Stop acknowledgment unavailable');const original=nativeTerminals.get(task)??terminalIntents.get(task);if(!original||terminalFingerprint(original)!==terminalFingerprint(task))throw Error('Original Stop terminal changed');sealedTerminal=original;consumed=true;return captureTaskSnapshot({...original,...(task.retention!==undefined?{retention:task.retention}:{}),...(task.retentionError!==undefined?{retentionError:task.retentionError}:{})}) as Readonly<TaskRecord>};if(won){if(task.result)delete task.legacyFormatVersion;notifications.enqueue(task)}
        const prerequisite=retentionPrerequisites.get(task),previous=retentionSaves.get(task),saveAuthority=Object.freeze({});requiredSaveAuthorities.set(saveAuthority,{parent,capture:()=>{check();if(task.result?.revision!==revision)throw Error('Original required Task revision changed');saveIdentity=retentionIdentity(task);sealedTerminal=captureTerminal(task);return snapshotData()},beforeIssue:async()=>{if(prerequisite)await prerequisite();check();if(task.result?.revision!==revision)throw Error('Original required Task revision changed');if(resultOwner)await resultOwner.settle(task);check();if(task.result?.revision!==revision)throw Error('Original required Task revision changed')}});save=previous??persistence.captureRequiredSave(saveAuthority);
        publish(task)
      }
      if(saveAttempted)await save.retry();else{saveAttempted=true;await save.done};check();save.assertHandoff();if(!consumed){save.release();consumed=true}
      if(saveIdentity&&!sameRetention(saveIdentity,task)||sealedTerminal&&terminalFingerprint(sealedTerminal)!==terminalFingerprint(task))throw Error('Original required Task terminal changed after capture')
      if(task.result?.kind==='retained'&&task.result.envelope.retention.kind==='unavailable'){task.retention='failed';task.retentionError=task.result.envelope.retention.reason}else if(task.result?.kind==='pending')throw Error('Original required Task result pending');else{task.retention='durable';delete task.retentionError}
      publish(task);return captureTaskSnapshot({...sealedTerminal!,...(task.retention!==undefined?{retention:task.retention}:{}),...(task.retentionError!==undefined?{retentionError:task.retentionError}:{})}) as Readonly<TaskRecord>
    };
    const result:RequiredTaskSettlement=Object.freeze({settle(){if(this!==result)throw Error('Invalid required Task receiver');const pending=flight??=drive();void pending.catch(()=>{if(flight===pending)flight=undefined});return pending},reconcile(){if(this!==result)throw Error('Invalid required Task receiver');return result.settle()},assertProjectionCurrent(){if(this!==result||!consumed||released)throw Error('Original Task projection unavailable');check();if(saveIdentity&&!sameRetention(saveIdentity,task)||sealedTerminal&&terminalFingerprint(sealedTerminal)!==terminalFingerprint(task))throw Error('Original Task projection changed')},async release(){if(this!==result)throw Error('Invalid required Task receiver');if(!consumed)throw Error('Original required Task acknowledgment unavailable');if(!released){await ownedTask.operations.releaseRequiredParent(parent);released=true}}});return result
  })
  associateTaskSaveOwner(registry, persistence)
  associateColdBindings(registry, () => coldBindings)
  return registry

}
