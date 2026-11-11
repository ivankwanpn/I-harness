import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import { expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ target: '', renames: 0, loseAck: false, blockRead:false }))
vi.mock('node:fs/promises', async load => {
  const original = await load<typeof import('node:fs/promises')>()
  return { ...original, async open(...args:Parameters<typeof original.open>){if(io.blockRead&&String(args[0])===io.target&&args[1]==='r+')throw Error('Original Task write still uncertain');return original.open(...args)}, async rename(...args: Parameters<typeof original.rename>) {
    await original.rename(...args)
    if (String(args[1]) === io.target) { io.renames++; if (io.loseAck){io.blockRead=true;throw Error('original Task ACK lost')} }
  } }
})
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { createControlledJsonlBackend, createSessionCoordinator as composeControlledCoordinator, ownedControls, backendControls } from '../../session-persistence/test/helpers/composed.ts'
import { captureOwnedTaskContext, TaskPersistence, originalTaskAcknowledgmentRecovery } from '@i-harness/session-persistence/internal/task-persistence'
import { taskDocumentStorageContract } from '@i-harness/session-persistence/internal/task-state'
import { TaskPersistence as LegacyTaskPersistence, originalTaskAcknowledgmentRecovery as legacyAcknowledgmentRecovery } from '../src/task/persistence.ts'
import { taskDocumentStorageContract as legacyContract } from '../src/task/storage-contract.ts'
import { acquireManagedExecution } from '../../session-persistence/src/execution-internal.ts'
import { createManagedExecutionDomain } from '@i-harness/core-session/internal/execution'
import type { BatchKey } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createTaskRegistry } from '../src/task/registry.ts'
import { lastOriginalTaskSave } from '../src/task/save-owner.ts'
import { SHIPPING_REPORT_POLICY } from '../src/report-policy.ts'
import { bindRequiredTaskSettlement, captureTaskNotificationProgress, captureOriginalTaskRuntimeData, captureOriginalTaskAuxiliaryData, type RequiredTaskSettlement, type TaskNotificationProgress } from '../src/task/required-settlement.ts'
import { wireSubagentPersistence } from '../src/persist.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { createJobRegistry } from '../src/jobs.ts'
import { createRoleRegistry } from '../src/roles.ts'

async function fixture(controlled = false, compatibilityParent = false) {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'canonical-task-'))
  const backend = controlled ? createControlledJsonlBackend(root) : undefined
  const coordinator = backend
    ? composeControlledCoordinator(backend, { lock: { enabled: true }, acquireDeadlineMs: 40, acquireRetryMs: 5 })
    : createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true }, acquireDeadlineMs: 40, acquireRetryMs: 5 }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'parent' })
  const execution = compatibilityParent ? undefined : await acquireManagedExecution(coordinator,'parent')
  const document = await coordinator.openManagedDocument('parent')
  const context = execution ? createManagedExecutionDomain(execution.identity, execution.owner, createContext()) : document.view
  const ownedTask = captureOwnedTaskContext(coordinator, document, context, 'parent')!
  const registries: ReturnType<typeof createTaskRegistry>[] = []
  const registry = async (results?:import('../src/task/result.ts').TaskResultStore) => { const value = createTaskRegistry({ coordinator, stateId: 'parent', ownedTask, reportPolicy: SHIPPING_REPORT_POLICY,results }); registries.push(value); await value.ready; return value }
  io.target = join(root, 'task-parent.doc.jsonl'); io.renames = 0; io.loseAck = false;io.blockRead=false
  return { root, backend, coordinator, document, ownedTask, registry, async close() { io.loseAck = false;io.blockRead=false; for (const value of registries.reverse()) await value.closeOwnedLoad(); await coordinator.close(); io.target = '' } }
}
const submission = (name: string) => ({ identity: { parentSessionId: 'parent', toolCallId: name }, agentPath: name, description: name, prompt: 'complete original prompt ' + name, agent: 'general', delivery: 'tool' as const })

it('keeps admitted publication current across another canonical Task ACK and Stop without granting fresh work', async () => {
  const f = await fixture()
  try {
    const tasks = await f.registry(), current = captureOriginalTaskRuntimeData(tasks)
    tasks.submit(submission('other-task'))
    await tasks.flushPersistence()
    expect(() => current()).not.toThrow()
    f.coordinator.revokeManagedDocumentNewWork('parent')
    expect(() => tasks.assertReady()).toThrow()
    expect(() => current()).not.toThrow()
    expect(() => captureOriginalTaskRuntimeData({ ...tasks })).toThrow('Original Task runtime owner unavailable')
  } finally { await f.close() }
})

it('refuses an admitted publisher after genuine canonical Task owner replacement', async () => {
  const f = await fixture()
  try {
    const tasks = await f.registry(), current = captureOriginalTaskRuntimeData(tasks)
    expect(() => current()).not.toThrow()
    const next = await f.registry()
    next.submit(submission('replacement-task'))
    await next.flushPersistence()
    expect(() => current()).toThrow('Original Task runtime data retired or replaced')
    expect(() => captureOriginalTaskRuntimeData(next)()).not.toThrow()
  } finally { await f.close() }
})

it('joins an already admitted original auxiliary write before replacing its canonical data owner', async () => {
  const f = await fixture(true), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const backend = backendControls(f.backend!), put = backend.original.putDocument!
  let held = true, replacementReady = false, nativeWrites = 0
  backend.methods.putDocument = async (...args) => {
    if (args[0] === 'parent') {
      if (held) { entered.resolve(); await release.promise }
      nativeWrites++
    }
    return put.call(f.backend, ...args)
  }
  try {
    const old = await f.registry(), auxiliary = captureOriginalTaskAuxiliaryData(old)
    const state = { table: createAgentTable(), jobs: createJobRegistry(), roles: createRoleRegistry() }
    const wired = wireSubagentPersistence(state, { coordinator: f.coordinator, stateId: 'parent', parentSessionId: 'parent' }, auxiliary)
    wired.roles.register({ name: 'old-original', description: '', systemPrompt: '', tools: [] })
    await entered.promise
    const replacing = f.registry().then(value => { replacementReady = true; return value })
    // The real Task read/installation is queued behind the original native
    // document write, not authorized merely by a pre-await incarnation check.
    expect(() => old.assertReady()).toThrow()
    expect(replacementReady).toBe(false)
    held = false; release.resolve()
    await replacing
    await wired.flushFacts()
    expect(nativeWrites).toBe(1)
    expect(() => auxiliary()).toThrow()
    wired.roles.register({ name: 'stale-must-not-write', description: '', systemPrompt: '', tools: [] })
    await expect(wired.flushFacts()).rejects.toThrow()
    expect(nativeWrites).toBe(1)
    const snapshot = await f.coordinator.getDocument('parent') as { roles: { name: string }[] }
    expect(snapshot.roles.map(role => role.name)).toEqual(['old-original'])
  } finally { held = false; release.resolve(); await f.close() }
})

it.each([false, true])('refuses retained publication while its original parent journal is quarantined by a genuine unknown ACK (compatibility=$0)', async compatibility => {
  const f = await fixture(true, compatibility)
  const controls = ownedControls(f.backend!)
  let unknown = true
  let pendingKey: BatchKey | undefined
  controls.append = async (...args) => {
    const outcome = await controls.originalAppend(...args)
    return unknown && args[0] === 'parent' ? { kind: 'unknown', key: args[3].key } : outcome
  }
  controls.reconcile = async (...args) => unknown && args[0] === 'parent'
    ? { kind: 'unknown', key: args[3].key } : controls.originalReconcile(...args)
  const action = f.document.beginAction()
  try {
    const tasks = await f.registry(), current = captureOriginalTaskRuntimeData(tasks)
    const outcome = await action.facts.metadata.admit({ type: 'session/title', title: 'same parent uncertain', source: 'user', messageSeqs: [] })
    expect(outcome.kind).toBe('unknown')
    if (outcome.kind !== 'unknown') throw Error('Original parent unknown ACK required')
    pendingKey = outcome.key
    expect(() => current()).toThrow()
    unknown = false
    await f.document.reconcile(pendingKey)
    expect(() => current()).not.toThrow()
  } finally { unknown = false; if (pendingKey) await f.document.reconcile(pendingKey); action.finish(); await f.close() }
})

it('shares canonical Task codec, save class and acknowledgment registry through compatibility paths',()=>{
  expect(TaskPersistence).toBe(LegacyTaskPersistence)
  expect(taskDocumentStorageContract).toBe(legacyContract)
  expect(originalTaskAcknowledgmentRecovery).toBe(legacyAcknowledgmentRecovery)
})

it('keeps native Task ACKs independent from unavailable redundant journals and derived warnings', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'jobs'), 'projection path is unavailable')
    const tasks = await f.registry(), task = tasks.submit(submission('canonical'))
    expect(await tasks.flushPersistenceBestEffort()).toEqual({ ok: true })
    const save = lastOriginalTaskSave(tasks)!
    expect(save.outcome()?.kind).toBe('committed'); save.assertHandoff()
    const before = await readFile(io.target), writes = io.renames
    tasks.annotateProjection(task.id, 'missing-child-session')
    expect(tasks.get(task.id)?.projectionWarning).toBe('missing-child-session')
    await tasks.flushPersistence()
    expect(lastOriginalTaskSave(tasks)).toBe(save); save.assertHandoff()
    expect(io.renames).toBe(writes); expect(await readFile(io.target)).toEqual(before)
    const stored = await f.coordinator.getDocument('task-parent') as { tasks: { prompt: string; projectionWarning?: string }[] }
    expect(stored.tasks[0]?.prompt).toBe(task.prompt); expect(stored.tasks[0]?.projectionWarning).toBeUndefined()
    expect(await readFile(join(f.root, 'jobs'), 'utf8')).toBe('projection path is unavailable')
  } finally { await f.close() }
})

it('does not let an old queued snapshot overwrite a superseding original Task owner', async () => {
  const f = await fixture()
  try {
    const old = await f.registry(), first = old.submit(submission('first'))
    await old.flushPersistence()
    const handoff = old.bindForegroundHandoff(first.id)()
    if (handoff.kind !== 'parent') throw Error('Original held save required')
    await handoff.save.done
    const unsaved = old.submit(submission('old-queued')), queued = lastOriginalTaskSave(old)!
    const next = await f.registry(), current = next.submit(submission('new-current'))
    await next.flushPersistence()
    expect(current.id).toBe(unsaved.id)
    expect(() => old.submit(submission('stale'))).toThrow()
    expect(()=>handoff.save.release()).toThrow()
    await expect(queued.done).rejects.toThrow()
    await old.closeOwnedLoad()
    const doc = await f.coordinator.getDocument('task-parent') as { tasks: { id: string; description: string }[] }
    expect(doc.tasks.find(row => row.id === current.id)?.description).toBe('new-current')
  } finally { await f.close() }
})

it('keeps true native Task uncertainty fenced until its same original save reconciles', async () => {
  const f = await fixture()
  try {
    const tasks = await f.registry()
    io.loseAck = true
    tasks.submit(submission('uncertain'))
    const original = lastOriginalTaskSave(tasks)!
    await expect(original.done).rejects.toThrow()
    expect(original.outcome()?.kind).toBe('unknown')
    expect((await tasks.flushPersistenceBestEffort()).ok).toBe(false)
    const conflicting = createTaskRegistry({ coordinator: f.coordinator, stateId: 'parent', ownedTask: f.ownedTask, reportPolicy: SHIPPING_REPORT_POLICY })
    await expect(conflicting.ready).rejects.toThrow()
    expect(() => conflicting.submit(submission('must-not-enter'))).toThrow()
    io.loseAck = false;io.blockRead=false
    await original.retry()
    expect(original.outcome()?.kind).toBe('committed')
    expect(await tasks.flushPersistenceBestEffort()).toEqual({ ok: true })
    await conflicting.closeOwnedLoad()
  } finally { await f.close() }
})

it('preserves a genuine terminal handoff when only its diagnostic warning changes', async () => {
  const f = await fixture()
  let terminal: RequiredTaskSettlement | undefined, released = false
  const action = f.document.beginAction(), source = action.registerSettlementSource(async () => { if (!released) await terminal?.settle() })
  try {
    const tasks = await f.registry(), task = tasks.submit(submission('cancelled-before-body'))
    await tasks.flushPersistence()
    terminal = await bindRequiredTaskSettlement(tasks, task, source, async () => ({ taskId: task.id, outcome: 'cancelled', error: 'original cancellation before body' }))
    if (!terminal) throw Error('Original terminal owner required')
    const result = await terminal.settle()
    terminal.assertProjectionCurrent()
    const writes = io.renames
    tasks.annotateProjection(task.id, 'missing-child-session')
    terminal.assertProjectionCurrent()
    expect(result.outcome).toBe('cancelled'); expect(task.outcome).toBe('cancelled')
    expect(io.renames).toBe(writes)
  } finally { if (terminal) await terminal.release(); released = true; action.finish(); await source.close(); await f.close() }
})

it('joins original required work before transferring the canonical Task data owner', async () => {
  const f=await fixture(), producer=Promise.withResolvers<{taskId:string;outcome:'cancelled';error:string}>(),drainEntered=Promise.withResolvers<void>()
  let terminal:RequiredTaskSettlement|undefined,released=false,calls=0,taskId='unused'
  const action=f.document.beginAction(),source=action.registerSettlementSource(async()=>{
    drainEntered.resolve()
    if(!released&&terminal){await terminal.settle();await terminal.release();released=true}
  })
  try{
    const old=await f.registry(),task=old.submit(submission('held-original'));taskId=task.id
    await old.flushPersistence()
    terminal=await bindRequiredTaskSettlement(old,task,source,async()=>{calls++;return producer.promise})
    if(!terminal)throw Error('Original required Task source unavailable')
    const next=f.registry()
    await Promise.race([drainEntered.promise,next.then(()=>{throw Error('Replacement installed before original source drain')})])
    expect(()=>old.submit(submission('during-transfer'))).toThrow()
    producer.resolve({taskId:task.id,outcome:'cancelled',error:'original body never dispatched'})
    const current=await next
    expect(calls).toBe(1);expect(current.list()).toHaveLength(1)
    expect(()=>terminal!.assertProjectionCurrent()).toThrow()
    const doc=await f.coordinator.getDocument('task-parent') as {tasks:{outcome?:string}[]}
    expect(doc.tasks[0]?.outcome).toBe('cancelled')
  }finally{
    producer.resolve({taskId,outcome:'cancelled',error:'cleanup'})
    if(terminal&&!released){await terminal.settle();await terminal.release();released=true}
    action.finish();await source.close();await f.close()
  }
})

it('does not promote V2 mirrors into native V3 terminal authority after an owned read',async()=>{
 const f=await fixture()
 let terminal:RequiredTaskSettlement|undefined,released=false
 const action=f.document.beginAction(),source=action.registerSettlementSource(async()=>{if(!released)await terminal?.settle()})
 try{
  const tasks=await f.registry(createTaskResultRetention(undefined,undefined,'parent'))
  const task=tasks.submit(submission('native-before-parent'))
  await tasks.flushPersistence()
  terminal=await bindRequiredTaskSettlement(tasks,task,source,async()=>({taskId:task.id,outcome:'cancelled',error:'known before dispatch'}))
  if(!terminal)throw Error('Original required Task missing')
  await terminal.settle();await terminal.release();released=true
  action.finish();await source.close()
  const current=await f.registry(createTaskResultRetention(undefined,undefined,'parent')),restored=current.get(task.id)!
  expect(restored.outcome).toBe('recovery-required');expect(restored.status).toBe('recovery-required')
  expect(restored.result?.kind==='retained'&&restored.result.envelope.execution).toEqual({outcome:'unknown',dispatch:'unknown'})
  expect(restored.publication).toBe('unqualified')
  const writes=io.renames
  expect(io.renames).toBe(writes)
  const imported=createTaskRegistry({results:createTaskResultRetention(undefined,undefined,'parent')})
  imported.restore({formatVersion:2,tasks:[{...task}],notifications:[]})
  expect(imported.get(task.id)?.outcome).toBe('recovery-required')
 }finally{if(terminal&&!released)await terminal.release();released=true;action.finish();await source.close();await f.close()}
})

it('settles the original required Task document ACK while coordinator close drains its accepted source',async()=>{
 const f=await fixture(),producer=Promise.withResolvers<{taskId:string;outcome:'cancelled';error:string}>(),entered=Promise.withResolvers<void>()
 let terminal:RequiredTaskSettlement|undefined,released=false,calls=0,taskId='unused'
 const action=f.document.beginAction(),source=action.registerSettlementSource(async()=>{
  entered.resolve()
  if(terminal&&!released){await terminal.settle();await terminal.release();released=true}
 })
 try{
  const tasks=await f.registry(),task=tasks.submit(submission('accepted-before-close'));taskId=task.id
  await tasks.flushPersistence()
  terminal=await bindRequiredTaskSettlement(tasks,task,source,async()=>{calls++;return producer.promise})
  if(!terminal)throw Error('Original required Task unavailable')
  const settling=terminal.settle()
  action.finish()
  const closing=f.coordinator.close()
  await Promise.race([entered.promise,closing.then(()=>{throw Error('Close skipped accepted Task source')})])
  producer.resolve({taskId:task.id,outcome:'cancelled',error:'original disposition during close'})
  expect((await settling).outcome).toBe('cancelled')
  await closing
  expect(calls).toBe(1)
  const reopened=createJsonlTaskTransitionCoordinator(f.root,{lock:{enabled:true}},taskDocumentStorageContract)
  try{expect(await reopened.getDocument('task-parent')).toMatchObject({tasks:[{id:task.id,outcome:'cancelled'}]})}finally{await reopened.close()}
 }finally{
  producer.resolve({taskId,outcome:'cancelled',error:'cleanup'})
  if(terminal&&!released){await terminal.settle();await terminal.release();released=true}
  action.finish();await source.close();await f.close()
 }
})

it('does not grant native terminal proof to a legacy row carried inside a mixed current document',async()=>{
 const f=await fixture()
 let terminal:RequiredTaskSettlement|undefined,released=false
 const action=f.document.beginAction(),source=action.registerSettlementSource(async()=>{if(!released)await terminal?.settle()})
 try{
  const tasks=await f.registry(createTaskResultRetention(undefined,undefined,'parent')),task=tasks.submit(submission('carried-legacy'))
  await tasks.flushPersistence()
  terminal=await bindRequiredTaskSettlement(tasks,task,source,async()=>({taskId:task.id,outcome:'cancelled',error:'original before-body cancellation'}))
  if(!terminal)throw Error('Original required Task unavailable')
  await terminal.settle();await terminal.release();released=true;action.finish();await source.close()
  const forged={...task,legacyFormatVersion:1 as const,bodyKind:'legacy-text' as const}
  await f.coordinator.putDocumentStrict!('task-parent',{formatVersion:3,tasks:[forged],notifications:[]})
  await expect(f.registry(createTaskResultRetention(undefined,undefined,'parent'))).rejects.toThrow()
  // Valid legacy rows carry text, not a forged current result descriptor.
  delete forged.result
  await f.coordinator.putDocumentStrict!('task-parent',{formatVersion:3,tasks:[forged],notifications:[]})
  const cold=await f.registry(createTaskResultRetention(undefined,undefined,'parent')),restored=cold.get(task.id)!
  expect(restored).toMatchObject({legacyFormatVersion:1,bodyKind:'legacy-text',outcome:'cancelled'})
  expect(restored.publication).toBeUndefined();expect(restored.savedObservation).toBeUndefined()
 }finally{if(terminal&&!released)await terminal.release();released=true;action.finish();await source.close();await f.close()}
})

it.each([false,true])('reconciles the same native notification progress save without another result or write (cleanup blocked=%s)',async blocked=>{
 const f=await fixture()
 let terminal:RequiredTaskSettlement|undefined,progress:TaskNotificationProgress|undefined,released=false,producerCalls=0
 const action=f.document.beginAction(),source=action.registerSettlementSource(async()=>{if(!released)await terminal?.settle()})
 try{
  const tasks=await f.registry(),task=tasks.submit({...submission('cancelled-progress'),delivery:'parent'})
  await tasks.flushPersistence()
  terminal=await bindRequiredTaskSettlement(tasks,task,source,async()=>{producerCalls++;return{taskId:task.id,outcome:'cancelled',error:'original undispatched cancellation'}})
  if(!terminal)throw Error('Original required Task unavailable')
  await terminal.settle();await terminal.release();released=true;action.finish();await source.close()
  expect(await captureTaskNotificationProgress({...tasks})).toBeUndefined()
  progress=await captureTaskNotificationProgress(tasks)
  if(!progress)throw Error('Original notification progress source unavailable')
  progress.tasks.updateNotification(tasks.notifications()[0]!.id,{status:'suppressed',error:'original cancellation'})
  const before=io.renames
  io.loseAck=true
  await expect(progress.tasks.save()).rejects.toThrow()
  expect((await tasks.flushPersistenceBestEffort()).ok).toBe(false)
  if(blocked){
   await expect(progress.close()).rejects.toThrow()
   expect((await tasks.flushPersistenceBestEffort()).ok).toBe(false)
  }
  io.loseAck=false;io.blockRead=false
  await progress.close()
  expect(io.renames).toBe(before+1);expect(producerCalls).toBe(1)
  expect(await tasks.flushPersistenceBestEffort()).toEqual({ok:true})
  expect(await f.coordinator.getDocument('task-parent')).toMatchObject({tasks:[{outcome:'cancelled'}],notifications:[{status:'suppressed'}]})
  expect(()=>progress!.tasks.updateNotification('unknown',{status:'delivered'})).toThrow()
 }finally{
  io.loseAck=false;io.blockRead=false
  await progress?.close()
  if(terminal&&!released)await terminal.release()
  released=true;action.finish();await source.close();await f.close()
 }
})
