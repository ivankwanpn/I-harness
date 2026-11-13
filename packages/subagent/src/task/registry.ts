import {committedFactSeqs,type ProducerFactOutcome,type CapturedSettlementFact,type SettlementFacts} from '@i-harness/core-session'
import {readManagedTaskResult,readManagedSourceTaskDelivery} from '@i-harness/core-session/internal/execution'
import {canonicalJsonData} from '@i-harness/core-session'
import {associateRequiredTaskRegistry,prepareOriginalTaskDataReplacement,isInstalledRequiredTaskData,isOriginalTaskDataIncarnation,releaseOriginalTaskData,type RequiredTaskSettlement,type TaskNotificationProgress,type NotificationTaskAccess} from './required-settlement.ts'
import {types as nativeTypes} from 'node:util'
import {callOriginalCurrentnessMethod,propagateOriginalCurrentnessReader,runOpaqueCurrentnessRead} from '../../../core-session/src/managed/currentness-guards.ts'
import { observeColdExecutionWrites } from '../../../session-persistence/src/coordinator/cold-execution-writes.ts'
import { managedExecutionStatus } from '../../../session-persistence/src/coordinator/managed-document.ts'
import { createTaskLaunchPort, type TaskLaunchPort } from './launch-slots.ts'
import { stageTaskRestore } from './restore-stage.ts'
import { associateColdBindings, assertColdTaskAdmission } from './cold-bindings.ts'
import { isOwnedTaskContext } from './owned-context.ts'
import { validateTaskDocument } from "./validation.ts"
import { unqualifyRestoredTask, qualifyTaskPublication,qualifyManagedTaskPublication } from './publication.ts'
import { settleTaskRecord } from "./settlement.ts"
import { waitForObservation } from "@i-harness/core-tools"
import { TaskResultOwner } from "./result.ts"
import { TaskNotifications } from "./notifications.ts"
import { TaskPersistence, originalCapturedTaskAcknowledgment, capturedTaskAcknowledgmentFailure } from "./persistence.ts"
import { associateTaskSaveOwner } from './save-owner.ts'
import {captureTaskSnapshot} from '@i-harness/session-persistence/internal/task-document-operations'
import { TaskRecords } from "./records.ts"
import { join } from "node:path"
import { createJobRecordStore } from "../job-record.ts"
import { createDocumentIntentStore } from "./document-intent.ts"
import { randomUUID } from "node:crypto"
import { type TaskRecord, type TaskRegistryOptions, type TaskRegistry, type TaskProtocolDocument, type TaskTerminalizeInput, type TaskStatus } from "./types.ts"
export function createTaskRegistry(opts: TaskRegistryOptions = {}): TaskRegistry {
  let stopObserving: (()=>void)|undefined
  let launchPort: TaskLaunchPort | undefined
  const ownedTask = opts.ownedTask
  if(opts.launchContext){
    if(!ownedTask||!isOwnedTaskContext(ownedTask))throw Error('Original task launch parent required')
    const context=opts.launchContext
    const document='kind'in context?context.domain.owner:context.factOwner as import('@i-harness/session-persistence').ManagedDocument
    ownedTask.operations.assertParentSession(ownedTask.operations.parent(document),ownedTask.stateId)
    if('kind'in context){if(context.domain.owner!==document||context.domain.sessionId!==ownedTask.stateId||context.domain.context!==context.context)throw Error('Foreign task launch parent');context.domain.assertCurrent()}
    else {const view=Object.getOwnPropertyDescriptor(document,'view');if(!view||!('value'in view)||view.value!==context.view||context.sessionId!==ownedTask.stateId)throw Error('Foreign task launch parent')}
  }
  type State = { records: TaskRecords; notifications: TaskNotifications; version: 1 | 2 | 3; phase: 'pending' | 'ready' | 'poisoned' | 'retired'; failure?: { cause: unknown } }
  const launchReady=ownedTask&&isOwnedTaskContext(ownedTask)&&!nativeTypes.isProxy(ownedTask.document)?Object.getOwnPropertyDescriptor(ownedTask.document,'assertReady'):undefined
  const launchGuard=launchReady&&'value'in launchReady&&typeof launchReady.value==='function'?launchReady.value as ()=>void:undefined
  const taskStateId=()=>{if(!nativeTypes.isProxy(opts)){const field=Object.getOwnPropertyDescriptor(opts,'stateId');if(field&&'value'in field)return field.value as string|undefined}return launchGuard?runOpaqueCurrentnessRead(launchGuard,()=>opts.stateId):opts.stateId}
  let currentState: State = { records: new TaskRecords(), notifications: new TaskNotifications(), version: opts.results ? 2 : 1, phase: ownedTask ? 'pending' : 'ready' }
  const installedData=Object.freeze({})
  let coldBindings: ReadonlySet<string> = new Set()
  function assertReady() {
    if (currentState.phase !== 'ready') throw Object.assign(new Error('Task registry ' + currentState.phase, { cause: currentState.failure?.cause }), { code: 'TASK_REGISTRY_UNAVAILABLE' })
    if (ownedTask) {if(!isInstalledRequiredTaskData(ownedTask.operations,opts.stateId!,installedData))throw Error('Original Task registry data replaced');if(launchGuard)callOriginalCurrentnessMethod(launchGuard,ownedTask.operations,'assertParentSession',[ownedTask.parent,taskStateId()!]);else ownedTask.operations.assertParentSession(ownedTask.parent, opts.stateId!)}
  }
  function captureRuntimeData(originalData = isInstalledRequiredTaskData): () => void {
    assertReady()
    const records = currentState.records, notifications = currentState.notifications
    return () => {
      if ((currentState.phase !== 'ready' && currentState.phase !== 'retired') || currentState.records !== records || currentState.notifications !== notifications ||
        ownedTask && !originalData(ownedTask.operations, opts.stateId!, installedData)) {
        throw Error('Original Task runtime data retired or replaced')
      }
      if (ownedTask) ownedTask.operations.assertOriginalParentSession(ownedTask.parent, opts.stateId!)
    }
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
  const persistence = new TaskPersistence(opts.coordinator, opts.stateId, Boolean(opts.reportPolicy), snapshot, ownedTask,authority=>{const original=requiredSaveAuthorities.get(authority);if(!original)throw Error('Original required Task capture unavailable');return original},assertReady)
  // Only legacy, unowned registries retain their old auxiliary journals.
  // The native Task document already owns complete records, outbox and ACKs.
  let jobWrite: Promise<void> = Promise.resolve()
  let intentWrite: Promise<void> = Promise.resolve()
  const documentIntents = !ownedTask && opts.coordinator?.storageRoot && opts.stateId
    ? createDocumentIntentStore(join(opts.coordinator.storageRoot, "jobs", opts.stateId + ".write-intents.jsonl"))
    : undefined
  const jobRecords = !ownedTask && opts.coordinator?.storageRoot && opts.stateId
    ? createJobRecordStore(join(opts.coordinator.storageRoot, "jobs", `${opts.stateId}.jobs.jsonl`))
    : undefined
  // Legacy import/diagnostic history remains readable. It never becomes a
  // second native execution authority or an owned Task save prerequisite.
  const jobRecordFailures: unknown[] = []
  const recordJob = (task: TaskRecord, status: TaskStatus, extra: { terminal?: { at: number; reason?: string } } = {}): void => {
    if (!jobRecords) return
    const now = Date.now()
    jobWrite = jobWrite.then(() => jobRecords.append({
      version: 1, jobId: task.id, parentSessionId: task.parentSessionId || opts.stateId!,
      ...(task.childSessionId !== undefined ? { childSessionId: task.childSessionId } : {}),
      status, createdAt: task.timeCreated ?? now, updatedAt: now,
      agentPath: task.agentPath, description: task.description, agent: task.agent, delivery: task.delivery, ...extra,
    })).catch(error => {
      if (jobRecordFailures.length < 16) jobRecordFailures.push(error)
      if (process.env.IH_JOB_RECORD_DEBUG) console.error('[job-record]', error)
    })
  }
  const requiredClaimRoutes=new WeakMap<TaskRecord,()=>void>()
  const requiredTerminalRoutes=new WeakMap<TaskRecord,()=>Promise<void>>()
  const retentionSaves = new WeakMap<TaskRecord, import('./persistence.ts').OwnedTaskSave>()
  type RetentionIdentity={revision:string|undefined;fingerprint:string}
  const acknowledgedRetention = new WeakMap<TaskRecord, RetentionIdentity>()
  const capturedRetention = new WeakMap<TaskRecord, RetentionIdentity>()
  const retentionIdentity=(task:TaskRecord):RetentionIdentity=>({revision:task.result?.revision,fingerprint:canonicalJsonData(terminalData(task,true))})
  const sameRetention=(identity:RetentionIdentity,task:TaskRecord)=>identity.revision===task.result?.revision&&identity.fingerprint===retentionIdentity(task).fingerprint
  const terminalData=(task:Readonly<TaskRecord>,nativeOnly=false)=>{const data:Record<string,unknown>=Object.create(null);for(const[key,field]of Object.entries(Object.getOwnPropertyDescriptors(task))){if(!field.enumerable||key==='projectionWarning'||nativeOnly&&(key==='retention'||key==='retentionError'||key==='publication'||key==='savedObservation'))continue;if(!('value'in field))throw Error('Original Task data accessor changed');Object.defineProperty(data,key,{value:field.value,enumerable:true})};return data}
  const captureTerminal=(task:Readonly<TaskRecord>)=>captureTaskSnapshot(terminalData(task)) as Readonly<TaskRecord>
  const terminalFingerprint=(task:Readonly<TaskRecord>)=>JSON.stringify(captureTaskSnapshot(terminalData(task,true)))
  const retentionPrerequisites=new WeakMap<TaskRecord,()=>Promise<void>>()
  const retentionFlights = new WeakMap<TaskRecord, Promise<void>>()
  // Legacy mirrors retain their own diagnostic failures. Native save debt
  // belongs to TaskPersistence and clears only with its original outcome.
  const persistenceFailures: unknown[] = []
  const save = async () => {
    assertReady()
    // Preserve the legacy forensic journal without duplicating the native
    // Task document's canonical result, outbox or acknowledgment.
    const intentId = documentIntents ? randomUUID() : undefined
    if (documentIntents) intentWrite = intentWrite.then(() => documentIntents.pending(intentId!)).catch(() => {})
    try {
      await persistence.save()
      if (documentIntents) intentWrite = intentWrite.then(() => documentIntents.settled(intentId!)).catch(() => {})
    } catch (error) {
      if (!ownedTask && persistenceFailures.length < 16) persistenceFailures.push(error)
      throw error
    }
  }

  function snapshot():TaskProtocolDocument {assertReady();return snapshotData()}
  function snapshotData(): TaskProtocolDocument {
    launchPort?.assertSnapshot()
    // A loaded literal 1 remains literal until a subsequent result-aware save.
    if (currentState.version === 1 && opts.results) currentState.version = 2
    return {
      formatVersion: currentState.version,
      tasks: [...currentState.records.values()].map(({ modelLabel, ...task }) => {
        delete task.projectionWarning
        return { ...task, ...(modelLabel !== undefined ? { modelLabel } : {}) }
      }),
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
    const required=requiredTerminalRoutes.get(task);if(required&&task.outcome!==undefined)return required()
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
    // Require captured bodies from compositions that own a body producer.
    // Legacy memory parents persist full presentation in the strict document.
    const capturesBody = resultOwner !== undefined
    if (!task.result && (task.publication === 'unqualified' || capturesBody && task.legacyFormatVersion !== 1)) {
      throw new Error('Retained task body incomplete')
    }
    if (resultOwner) await resultOwner.settle(task)
    if (!resultOwner && task.result?.kind === 'pending') {
      throw Object.assign(new Error('Original task body capture unavailable after restart'), { code: 'FACT_RECOVERY_REQUIRED' })
    }
    if (!opts.reportPolicy) return
    // The in-memory authoritative outcome is already complete. Persistence
    // failure changes delivery evidence only; it never reopens execution.
    if (!opts.coordinator || !opts.stateId) { task.retention = "memory"; return }
    const acknowledged=acknowledgedRetention.get(task)
    if(acknowledged&&!sameRetention(acknowledged,task))throw Error('Original saved task result changed')
    assertRestoredReader(task)
    if(acknowledged){
      if (task.savedObservation && task.result?.kind === 'retained'
        && task.result.envelope.retention.kind === 'artifact') {
        const previous = task.retention
        const previousError = task.retentionError
        restoredRetention(task, true)
        if (task.retention !== previous || task.retentionError !== previousError) publish(task)
      }
      return
    }
    if (task.retention === "durable") return
    task.retention = "pending"
    try {
      const previous = retentionSaves.get(task)
      const captured=previous?capturedRetention.get(task)!:retentionIdentity(task)
      const originalSave = previous ?? persistence.captureSave(true,retentionPrerequisites.get(task))
      if (originalSave) { retentionSaves.set(task, originalSave);capturedRetention.set(task,captured); await completeOriginalRetention(task,originalSave,Boolean(previous));return }
      else await save()
      if(!sameRetention(captured,task))throw Error('Original saved task result changed')
      acknowledgedRetention.set(task,captured)
      assertRestoredReader(task)
      if (task.result?.kind === 'retained' && task.result.envelope.retention.kind === 'unavailable') {
        task.retention = 'failed'
        task.retentionError = task.result.envelope.retention.reason
      } else {
        task.retention = "durable"
        delete task.retentionError
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const changed = task.retention !== 'failed' || task.retentionError !== message
      task.retention = "failed"
      task.retentionError = message
      if (changed) publish(task)
      throw error
    }
    publish(task)
  }

  function assertRestoredReader(task: TaskRecord): void {
    if (task.savedObservation && task.result?.kind === 'retained'
      && task.result.envelope.retention.kind === 'artifact'
      && resultOwner?.available() !== true) {
      const previous = task.retention
      const previousError = task.retentionError
      restoredRetention(task, false)
      if (task.retention !== previous || task.retentionError !== previousError) publish(task)
      throw new Error(task.retentionError)
    }
  }

  async function completeOriginalRetention(task:TaskRecord,save:import('./persistence.ts').OwnedTaskSave,retry:boolean):Promise<void>{
    if(currentState.records.get(task.id)!==task)throw Error('Original terminal task replaced')
    const captured=capturedRetention.get(task);if(!captured)throw Error('Original terminal result identity unavailable')
    if(retry)await save.retry();else await save.done
    save.assertHandoff()
    save.release();acknowledgedRetention.set(task,captured);retentionSaves.delete(task);capturedRetention.delete(task)
    if(!sameRetention(captured,task))throw Error('Original saved task result changed')
    assertRestoredReader(task)
    if(task.result?.kind==='retained'&&task.result.envelope.retention.kind==='unavailable'){task.retention='failed';task.retentionError=task.result.envelope.retention.reason}else task.retention='durable'
    publish(task)
  }
  function resumeOriginalRetention(task:TaskRecord):Promise<void>{
    if(currentState.records.get(task.id)!==task)return Promise.reject(Error('Original terminal task replaced'))
    const required=requiredTerminalRoutes.get(task);if(required&&task.outcome!==undefined)return required()
    const active=retentionFlights.get(task);if(active)return active
    const acknowledged=acknowledgedRetention.get(task);if(acknowledged&&sameRetention(acknowledged,task))return Promise.resolve()
    const save=retentionSaves.get(task)
    if(!save)return retainResult(task.id)
    const flight=completeOriginalRetention(task,save,true);retentionFlights.set(task,flight)
    void flight.finally(()=>{if(retentionFlights.get(task)===flight)retentionFlights.delete(task)}).catch(()=>{})
    return flight
  }

  function announceTerminal(t: TaskRecord, notify = true): void {
    // A genuine new current capture leaves historical text recovery behind.
    if (t.result) delete t.legacyFormatVersion
    currentState.notifications.enqueue(t)
    const required=requiredTerminalRoutes.get(t)
    if(required){const original=required();void original.then(()=>{if(notify)opts.onTerminalized?.(t)},()=>{if(notify)opts.onTerminalized?.(t)});publish(t);return}
    if (opts.reportPolicy) {
      const originalRetention=retainResult(t.id);
      void originalRetention.then(() => { if (notify) opts.onTerminalized?.(t) }, () => { if (notify) opts.onTerminalized?.(t) })
    } else {
      const originalSave=save();void originalSave.catch(() => {})
    }
    publish(t)
    if (!opts.reportPolicy && notify) opts.onTerminalized?.(t)
  }

  function terminalize(input: TaskTerminalizeInput): boolean {
    assertReady()
    launchPort?.retireTask(input.taskId, new Error('Task terminalized'))
    const task = currentState.records.get(input.taskId)
    if (!settleTaskRecord(task, input, resultOwner)) return false
    recordJob(task, task.outcome!, task.outcome === "recovery-required" ? {} : { terminal: { at: Date.now(), ...(task.error !== undefined ? { reason: task.error } : {}) } })
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
      const replacement = await prepareOriginalTaskDataReplacement(owned.operations,opts.stateId!,installedData)
      operation = await owned.operations.begin(owned.parent, { signal: controller.signal })
      const observed = await operation.observe()
      if (observed.kind !== 'present') throw new Error('Owned task document is absent')
      const staged = stageTaskRestore(observed.value as TaskProtocolDocument, Boolean(opts.reportPolicy), resultOwner?.available?.() === true)
      if (staged.version === 3) owned.operations.assertTaskV3Parent(owned.parent, opts.stateId!)
      // This candidate is trusted only after the original protected native read
      // is confirmed, its IO closes and the handoff below is consumed. Imported
      // V1/V2 rows and unproved physical outcomes keep conservative recovery.
      const canonicalTerminals:TaskRecord[]=[]
      if(staged.version===3){
        for(const original of (observed.value as TaskProtocolDocument).tasks){
          const execution=original.result?.kind==='retained'?original.result.envelope.execution:undefined
          const expected=original.outcome==='completed'?'succeeded':original.outcome==='error'?'failed':original.outcome==='cancelled'?'canceled':undefined
          if(original.parentSessionId!==owned.stateId||original.legacyFormatVersion||!expected||execution?.outcome!==expected||execution.dispatch==='unknown'||execution.dispatch==='dispatched'&&!original.childBirth)continue
          const task=staged.records.get(original.id)!
          const savedObservation={status:original.status,outcome:original.outcome!,execution:{...execution}}
          task.status=original.status;task.outcome=original.outcome;task.result=structuredClone(original.result)
          task.publication='unqualified';task.savedObservation=savedObservation
          canonicalTerminals.push(task)
        }
      }
      const readyState: State = { records: staged.records, notifications: staged.notifications, version: staged.version, phase: 'ready' }
      const stagedColdBindings = new Set(staged.version === 3 ? [...staged.records.values()].filter(task => task.childBirth).flatMap(task => [task.childBirth!.request.invocation.targetSessionId, 'task:' + task.id]) : [])
      const confirmed = await operation.confirm(observed.witness)
      if (confirmed.kind !== 'confirmed' || confirmed.cleanupPending) throw new Error('Owned task read was not confirmed', { cause: confirmed })
      handoff = operation.prepareReadHandoff(observed.witness)
      closeAttempted = true
      await operation.close(); resourcesClosed = true
      if (currentState.phase !== 'pending' || controller.signal.aborted) throw new Error('Original task load retired')
      if (staged.version === 3) owned.operations.assertTaskV3Parent(owned.parent, opts.stateId!)
      replacement.assertCurrent()
      // No callback, allocation, validation or await between consume and swap.
      handoff.consume()
      currentState = readyState
      replacement.install(async()=>{retireOwnedLoad();await registry.closeOwnedLoad()})
      coldBindings = stagedColdBindings
      for(const task of canonicalTerminals)acknowledgedRetention.set(task,retentionIdentity(task))
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
  let ownerClose:Promise<void>|undefined
  function closeOwnedLoad(accepted?:Promise<void>):Promise<void>{
    if(ownerClose)return ownerClose
    launchPort?.retireAll(new Error('Original slot owner closed'))
    stopObserving?.();stopObserving=undefined
    const flight=(async()=>{
      const errors:unknown[]=[]
      await ready.catch(()=>{})
      // Release old snapshot consumers before producer/notification joins:
      // those producers may have queued their saves behind a held consumer.
      const consumers=persistence.retireConsumers()
      void consumers.catch(()=>{})
      try{await cleanupLoad()}catch(error){errors.push(error)}
      try{await launchPort?.close()}catch(error){errors.push(error)}
      for(const source of new Set([...requiredTasks.values()].map(entry=>entry.source)))try{await source.close()}catch(error){errors.push(error)}
      if(accepted){
        try{await accepted}catch(error){errors.push(error)}
        retireOwnedLoad()
      }
      try{await consumers}catch(error){errors.push(error)}
      try{await persistence.flush()}catch(error){errors.push(error)}
      if(errors.length)throw new AggregateError(errors,'Original Task owner cleanup unresolved')
      if(ownedTask&&currentState.phase==='retired')releaseOriginalTaskData(ownedTask.operations,opts.stateId!,installedData)
    })()
    ownerClose=flight
    void flight.catch(()=>{if(ownerClose===flight)ownerClose=undefined})
    return flight
  }
  const liveAccepted=new WeakSet<TaskRecord>()
  const registry: TaskRegistry = {
    ready,
    assertReady,
    retireOwnedLoad,
    closeOwnedLoad:()=>closeOwnedLoad(),
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
      if(opts.launchContext&&'kind'in opts.launchContext){for(const task of currentState.records.values())if(task.publication==='unqualified'&&await qualifyManagedTaskPublication(task,opts.launchContext.domain))publish(task);return}
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
      recordJob(record, "accepted")
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
      recordJob(t, "running")
      const required=requiredClaimRoutes.get(t);if(required)required();else void save().catch(() => {})
      publish(t)
      return true
    },
    terminalize,
    async recoverPersistence() {
      assertReady()
      await persistence.retireConsumers()
      await persistence.flush()
    },
    annotateProjection(taskId, warning) {
      assertReady()
      const task = currentState.records.get(taskId)
      if (!task) throw new Error('unknown task')
      if (task.projectionWarning === warning) return false
      if (warning === undefined) delete task.projectionWarning
      else task.projectionWarning = warning
      publish(task)
      return true
    },
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
        recordJob(t, 'cancelled', { terminal: { at: Date.now(), reason: error } })
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
    flushPersistence: async () => { await ready; await persistence.flush(); await jobWrite; await intentWrite },
    async flushPersistenceBestEffort() {
      let error: unknown
      try { await ready; await persistence.flush() }
      catch (cause) { error = cause }
      finally { await jobWrite; await intentWrite }
      if (error === undefined && persistenceFailures.length) error = persistenceFailures[0]
      if (error === undefined && jobRecordFailures.length) error = jobRecordFailures[0]
      return error === undefined ? { ok: true } : { ok: false, error }
    },
  }
  const publicationRepairs=new Map<TaskRecord,{source:SettlementFacts<ProducerFactOutcome>;fact:CapturedSettlementFact<ProducerFactOutcome>}>()
  async function recoverCanonicalPublications(namespace:string):Promise<void>{
    for(const entry of [...requiredTasks.values()])if(entry.notification)await entry.notification()
    // Reconcile already-issued original work before any fresh-read admission:
    // its own unknown outcome deliberately fences ordinary currentness.
    for(const [task,repair]of publicationRepairs){
      committedFactSeqs(await repair.fact.reconcile())
      await repair.source.close()
      publicationRepairs.delete(task);requiredTasks.delete(task)
    }
    assertReady()
    if(!opts.launchContext||!('kind'in opts.launchContext))return
    const domain=opts.launchContext.domain
    for(const task of currentState.records.values()){
      if(task.delivery!=='parent'||task.publication!=='unqualified'||!coldBindings.has('task:'+task.id))continue
      const acknowledged=acknowledgedRetention.get(task)
      const outcome=task.outcome
      if(!acknowledged||!sameRetention(acknowledged,task)||task.result?.kind!=='retained'||!task.childBirth||
        outcome!=='completed'&&outcome!=='error'&&outcome!=='cancelled')continue
      let repair=publicationRepairs.get(task)
      if(!repair){
        const cleanup=requiredTasks.get(task);if(cleanup){await cleanup.source.close();requiredTasks.delete(task)}
        const existing=await readManagedTaskResult(domain,task.id)
        assertReady()
        if(existing){if(!await qualifyManagedTaskPublication(task,domain))throw Error('Canonical Task publication conflicts with parent result');publish(task);continue}
        const action=domain.owner.beginAction()
        let fact:CapturedSettlementFact<ProducerFactOutcome>|undefined
        const source=action.registerSettlementSource(async()=>{if(fact)committedFactSeqs(await fact.reconcile())})
        action.finish();requiredTasks.set(task,{source})
        try{
          const binding=readManagedSourceTaskDelivery(domain.identity,source,namespace,task.id)
          if(!binding||binding.kind!=='subagent'||binding.recipientSessionId!==task.parentSessionId||binding.callSeq!==task.callEventSeq)throw Error('Original canonical Task delivery binding unavailable')
          if(!sameRetention(acknowledged,task))throw Error('Original canonical Task changed before publication')
          fact=source.delivery.capture({
            type:'subagent/end',version:1,taskId:task.id,outcome,
            envelope:task.result.envelope,resultRevision:task.result.revision,
            ...(task.resultText!==undefined?{resultText:task.resultText}:{}),
            ...(task.error!==undefined?{error:task.error}:{}),
          })
          repair={source,fact};publicationRepairs.set(task,repair);requiredTasks.set(task,{source})
        }catch(error){try{await source.close();requiredTasks.delete(task)}catch(cleanup){throw new AggregateError([error,cleanup],'Canonical Task publication validation and cleanup failed')}throw error}
      }
      committedFactSeqs(await repair.fact.reconcile())
      await repair.source.close()
      publicationRepairs.delete(task);requiredTasks.delete(task)
      if(!await qualifyManagedTaskPublication(task,domain))throw Error('Canonical Task publication was not observed after acknowledgment')
      publish(task)
    }
  }
  const requiredTasks=new Map<object,{source:SettlementFacts<ProducerFactOutcome>;notification?:()=>Promise<void>}>()
  function canonicalChildren(query?:{sessionId:string;taskId?:string}):readonly Readonly<TaskRecord>[] {
    assertReady()
    if(!ownedTask)return []
    const candidates=query?[query.taskId?currentState.records.get(query.taskId):currentState.records.getByChildSession(query.sessionId)]:[...currentState.records.values()]
    return candidates.filter((task):task is TaskRecord=>{
      const ack=task&&acknowledgedRetention.get(task)
      return !!task&&task.parentSessionId===ownedTask.stateId&&!!ack&&sameRetention(ack,task)&&!!task.childBirth&&!!task.childSessionId&&
        (!query||task.childSessionId===query.sessionId)&&task.outcome!==undefined&&task.outcome!=='recovery-required'
    })
  }
  async function captureNotificationProgress():Promise<TaskNotificationProgress|undefined>{
    if(!ownedTask)return undefined
    assertReady()
    const records=currentState.records,notifications=currentState.notifications,key=Object.freeze({})
    const publicationReady=Promise.withResolvers<void>()
    const action=ownedTask.document.beginAction()
    let parent:object|undefined,save:import('./persistence.ts').OwnedTaskSave|undefined
    let attempted=false,saved=false,released=false,closing:Promise<void>|undefined
    let initialCleanup:ReturnType<typeof ownedTask.operations.cleanupFor>
    const check=()=>{
      if(released||!parent||currentState.records!==records||currentState.notifications!==notifications||
        currentState.phase==='poisoned'||!isInstalledRequiredTaskData(ownedTask.operations,opts.stateId!,installedData))throw Error('Original Task notification owner changed')
      source.assertHeld()
      ownedTask.operations.assertOriginalRequiredParent(parent,opts.stateId!)
    }
    const settleSave=async()=>{
      if(!save||saved)return
      if(attempted)await save.retry();else{attempted=true;await save.done}
      await ownedTask.operations.joinRequiredWriter(parent!);check()
      save.assertHandoff();save.release();saved=true
    }
    const source=action.registerSettlementSource(async()=>{
      await publicationReady.promise
      if(initialCleanup){await initialCleanup.retry();initialCleanup=undefined}
      await settleSave()
      if(parent&&!released){await ownedTask.operations.releaseRequiredParent(parent);released=true}
    })
    const parentReady=ownedTask.operations.requiredParent(ownedTask.document,source).then(original=>{parent=original;action.finish();return original})
    const close=()=>{
      if(closing)return closing
      publicationReady.resolve()
      const pending=source.close().then(()=>{requiredTasks.delete(key)})
      closing=pending
      void pending.catch(()=>{if(closing===pending)closing=undefined})
      return pending
    }
    requiredTasks.set(key,{source,notification:close})
    const tasks:NotificationTaskAccess={
      get(id){check();return records.get(id)},
      notifications(){check();return notifications.list()},
      updateNotification(id,patch){check();if(save)throw Error('Original notification progress already captured');return notifications.update(id,patch)},
      async retainResult(id){check();await retainResultOnce(id);check()},
      async save(){
        check()
        if(!save){
          const authority=Object.freeze({})
          requiredSaveAuthorities.set(authority,{parent:parentReady,capture:()=>{check();return snapshotData()},beforeIssue:async()=>{check()}})
          save=persistence.captureRequiredSave(authority)
        }
        await settleSave()
      },
    }
    try{await parentReady;check();return Object.freeze({tasks:Object.freeze(tasks),close})}
    catch(cause){
      initialCleanup=ownedTask.operations.cleanupFor(cause)
      action.finish()
      try{await close()}catch(cleanup){throw new AggregateError([cause,cleanup],'Original notification admission cleanup failed')}
      throw cause
    }
  }
  associateRequiredTaskRegistry(registry,async(task,source,producer)=>{
    if(!ownedTask)return undefined
    assertReady();if(task.parentSessionId!==opts.stateId||!liveAccepted.has(task)||currentState.records.get(task.id)!==task||task.outcome!==undefined||requiredTasks.has(task))throw Error('Original required Task unavailable')
    requiredTasks.set(task,{source})
    const records=currentState.records,notifications=currentState.notifications
    let parent:object|undefined
    const readyParent=ownedTask.operations.requiredParent(ownedTask.document,source).then(original=>{parent=original;return original})
    const checkData=()=>{if(!isInstalledRequiredTaskData(ownedTask.operations,opts.stateId!,installedData)||currentState.records!==records||currentState.notifications!==notifications||currentState.phase==='poisoned'||records.get(task.id)!==task)throw Error('Original required Task incarnation replaced');source.assertHeld()}
    const joinWriter=async()=>{const original=await readyParent;checkData();await ownedTask.operations.joinRequiredWriter(original);checkData()};
    const checkOriginal=()=>{checkData();if(!parent)throw Error('Original required parent pending');ownedTask.operations.assertOriginalRequiredParent(parent,opts.stateId!)};
    const check=()=>{checkData();if(!parent)throw Error('Original required parent pending');ownedTask.operations.assertTaskV3Parent(parent,opts.stateId!)}
    let save:import('./persistence.ts').OwnedTaskSave|undefined,flight:Promise<Readonly<TaskRecord>>|undefined,ackFlight:Promise<Readonly<TaskRecord>>|undefined,revision:string|undefined,consumed=false,released=false,saveAttempted=false
    let originalInput:TaskTerminalizeInput|undefined,saveIdentity:RetentionIdentity|undefined,sealedTerminal:Readonly<TaskRecord>|undefined,projection:Readonly<TaskRecord>|undefined
    let prelude:import('./persistence.ts').OwnedTaskSave|undefined,preludeFlight:Promise<void>|undefined,preludeAttempted=false,preludeAcknowledged=false
    const settlePrelude=():Promise<void>=>{
      if(!prelude||preludeAcknowledged)return Promise.resolve();if(preludeFlight)return preludeFlight
      const pending=(async()=>{if(preludeAttempted)await prelude!.retry();else{preludeAttempted=true;await prelude!.done};await joinWriter();check();prelude!.assertHandoff();prelude!.release();preludeAcknowledged=true})()
      preludeFlight=pending;void pending.catch(()=>{if(preludeFlight===pending)preludeFlight=undefined});return pending
    }
    requiredClaimRoutes.set(task,()=>{
      checkData();if(prelude)throw Error('Original claim snapshot already reserved')
      const snapshot=captureTaskSnapshot(snapshotData()) as TaskProtocolDocument,authority=Object.freeze({})
      requiredSaveAuthorities.set(authority,{parent:readyParent,capture:()=>snapshot,beforeIssue:async()=>{checkOriginal()}})
      prelude=persistence.captureRequiredSave(authority);void settlePrelude().catch(()=>{})
    })
    const reserve=()=>{
      if(save)return
      checkData();if(task.outcome===undefined)throw Error('Original terminal disposition unavailable')
      revision=task.result?.revision
      const prerequisite=retentionPrerequisites.get(task),authority=Object.freeze({})
      requiredSaveAuthorities.set(authority,{parent:readyParent,capture:()=>{check();if(task.result?.revision!==revision)throw Error('Original required Task revision changed');saveIdentity=retentionIdentity(task);sealedTerminal=captureTerminal(task);capturedRetention.set(task,saveIdentity);return snapshotData()},beforeIssue:async()=>{if(prerequisite)await prerequisite();checkOriginal();if(task.result?.revision!==revision)throw Error('Original required Task revision changed');if(resultOwner)await resultOwner.settle(task);checkOriginal();if(task.result?.revision!==revision)throw Error('Original required Task revision changed')}})
      save=persistence.captureRequiredSave(authority);retentionSaves.set(task,save)
    }
    const acknowledge=():Promise<Readonly<TaskRecord>>=>{
      if(projection){if(!saveIdentity||!sameRetention(saveIdentity,task))return Promise.reject(Error('Original saved task result changed'));return Promise.resolve(projection)}
      if(ackFlight)return ackFlight
      // Reserve synchronously at the terminal CAS, including a live Stop winner.
      reserve()
      const pending=(async()=>{
        await settlePrelude()
        if(saveAttempted)await save!.retry();else{saveAttempted=true;try{await save!.done}catch(error){if(preludeAcknowledged&&save!.outcome()===undefined)await save!.retry();else throw error}}
        await joinWriter();check();save!.assertHandoff();if(!consumed){save!.release();consumed=true}
        if(saveIdentity&&!sameRetention(saveIdentity,task)||sealedTerminal&&terminalFingerprint(sealedTerminal)!==terminalFingerprint(task))throw Error('Original required Task terminal changed after capture')
        if(task.result?.kind==='retained'&&task.result.envelope.retention.kind==='unavailable'){task.retention='failed';task.retentionError=task.result.envelope.retention.reason}else if(task.result?.kind==='pending')throw Error('Original required Task result pending');else{task.retention='durable';delete task.retentionError}
        acknowledgedRetention.set(task,saveIdentity!);retentionSaves.delete(task);capturedRetention.delete(task)
        projection=captureTaskSnapshot({...sealedTerminal!,...(task.retention!==undefined?{retention:task.retention}:{}),...(task.retentionError!==undefined?{retentionError:task.retentionError}:{})}) as Readonly<TaskRecord>
        publish(task);return projection
      })();ackFlight=pending;void pending.catch(()=>{if(ackFlight===pending)ackFlight=undefined});return pending
    }
    let stopFlight:Promise<void>|undefined
    const stopRoute=()=>{if(stopFlight)return stopFlight;const pending=acknowledge().then(()=>{});stopFlight=pending;retentionFlights.set(task,pending);void pending.finally(()=>{if(stopFlight===pending)stopFlight=undefined;if(retentionFlights.get(task)===pending)retentionFlights.delete(task)}).catch(()=>{});return pending}
    requiredTerminalRoutes.set(task,stopRoute)
    const drive=async()=>{
      const input=originalInput??=Object.freeze({...await producer()});checkOriginal();if(input.taskId!==task.id)throw Error('Original required Task producer changed')
      if(task.outcome===undefined){settleTaskRecord(task,input,resultOwner);if(task.result)delete task.legacyFormatVersion;notifications.enqueue(task)}
      return acknowledge()
    }
    const result:RequiredTaskSettlement=Object.freeze({
      settle(){if(this!==result)throw Error('Invalid required Task receiver');const pending=flight??=drive();void pending.catch(()=>{if(flight===pending)flight=undefined});return pending},
      reconcile(){if(this!==result)throw Error('Invalid required Task receiver');return result.settle()},
      async recoverCapturedAcknowledgment(){
        if(this!==result)throw Error('Invalid required Task receiver')
        if(!save||!originalCapturedTaskAcknowledgment(save))return undefined
        checkOriginal()
        if(ackFlight)await ackFlight.catch(()=>{})
        if(!originalCapturedTaskAcknowledgment(save))return undefined
        const pending=acknowledge();flight=pending;void pending.catch(()=>{if(flight===pending)flight=undefined});return pending
      },
      acknowledgmentRecovery(cause:unknown){if(this!==result)throw Error('Invalid required Task receiver');return save&&capturedTaskAcknowledgmentFailure(save,cause)},
      captureProjectionRecovery(cause:unknown){
        if(this!==result||!consumed||released||!parent)throw Error('Original Task projection unavailable');
        checkData();
        return ownedTask.operations.captureRequiredWriterRecovery(parent,cause);
      },
      async waitProjectionCurrent(){if(this!==result||!consumed||released)throw Error('Original Task projection unavailable');await joinWriter();result.assertProjectionCurrent()},
      assertProjectionCurrent(){if(this!==result||!consumed||released)throw Error('Original Task projection unavailable');check();if(saveIdentity&&!sameRetention(saveIdentity,task)||sealedTerminal&&terminalFingerprint(sealedTerminal)!==terminalFingerprint(task))throw Error('Original Task projection changed')},
      async release(){if(this!==result)throw Error('Invalid required Task receiver');if(!consumed)throw Error('Original required Task acknowledgment unavailable');if(!released){await ownedTask.operations.releaseRequiredParent(parent!);released=true;requiredTerminalRoutes.delete(task);requiredClaimRoutes.delete(task);requiredTasks.delete(task)}}
    })
    try{await readyParent;check();return result}catch(error){requiredTerminalRoutes.delete(task);requiredClaimRoutes.delete(task);throw error}
  },{recover:recoverCanonicalPublications,closeAfter:closeOwnedLoad,notification:captureNotificationProgress,children:canonicalChildren,runtimeData:captureRuntimeData,auxiliaryData:()=>captureRuntimeData(isOriginalTaskDataIncarnation)})
  if (ownedTask && opts.launchContext) {
   const launchHooks:Parameters<typeof createTaskLaunchPort>[2]={
    beforeResultIssue(record,before){assertReady();if(currentState.records.get(record.id)!==record)throw Error('Original task replaced');retentionPrerequisites.set(record,before)},
    retainResult:resumeOriginalRetention,
    current(record) { assertReady();if(record&&(launchGuard?runOpaqueCurrentnessRead(launchGuard,()=>currentState.records.get(record.id)):currentState.records.get(record.id))!==record)throw Error('Original slot task replaced'); if(launchGuard)callOriginalCurrentnessMethod(launchGuard,ownedTask.operations,'assertTaskV3Parent',[ownedTask.parent,taskStateId()!]);else ownedTask.operations.assertTaskV3Parent(ownedTask.parent, opts.stateId!) },
    insert: input => {const result=currentState.records.submit(input,maxConcurrency);if(result.inserted)liveAccepted.add(result.record);return result},
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
   }
   if(launchGuard)propagateOriginalCurrentnessReader(ownedTask.operations,'assertTaskV3Parent',launchHooks,'current',[launchGuard],[[ownedTask.operations,'assertParentSession']])
   launchPort=createTaskLaunchPort(registry,opts.launchContext,launchHooks)
  }
  if(ownedTask&&opts.launchContext)stopObserving=observeColdExecutionWrites(ownedTask.coordinator,id=>{
    const context=opts.launchContext!;const owner='kind'in context?context.domain.owner:context.factOwner
    if(id===ownedTask.stateId&&managedExecutionStatus(owner as import('@i-harness/session-persistence').ManagedDocument)==='retired')launchPort?.retireAll(new Error('Original task parent retired'))
  })
  associateTaskSaveOwner(registry, persistence)
  associateColdBindings(registry, () => coldBindings)
  return registry

}
