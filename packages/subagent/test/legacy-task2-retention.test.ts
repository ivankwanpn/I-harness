import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { captureOwnedTaskContext } from '@i-harness/session-persistence/internal/task-persistence'
import { taskDocumentStorageContract } from '@i-harness/session-persistence/internal/task-state'
import { bindRequiredTaskSettlement, type RequiredTaskSettlement } from '../src/task/required-settlement.ts'
import { lastOriginalTaskSave } from '../src/task/save-owner.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createResultCapture } from '../../output-retention/src/index.ts'
import type { TaskResultStore } from '../src/index.ts'
import { expect, it } from 'vitest'
import { createTaskRegistry, SHIPPING_REPORT_POLICY } from '../src/index.ts'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import type { TaskProtocolDocument } from '../src/task/types.ts'

function legacyStrict(results?: TaskResultStore, beforeWrite?: (value: TaskProtocolDocument) => Promise<void>) {
  const writes: TaskProtocolDocument[] = []
  const coordinator = {
    async putDocumentStrict(_key: string, value: TaskProtocolDocument) {
      await beforeWrite?.(value)
      writes.push(structuredClone(value))
    },
    async putDocument() {},
  } as unknown as SessionCoordinator
  const tasks = createTaskRegistry({coordinator,stateId:'parent',reportPolicy:SHIPPING_REPORT_POLICY,results})
  return {tasks,writes}
}
function terminal(tasks: ReturnType<typeof createTaskRegistry>, text: string) {
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'root/legacy',description:'full presentation',prompt:'go',agent:'general',delivery:'tool'})
  tasks.claim(task.id,'child-'+task.id)
  tasks.terminalize({taskId:task.id,outcome:'completed',resultText:text})
  return task
}
it('preserves empty Task2 storage while a live legacy parent strictly retains full presentation',async()=>{
  const {tasks,writes}=legacyStrict()
  tasks.restore({formatVersion:2,tasks:[],notifications:[]})
  const full='中文🙂"\n'.repeat(5000)
  const task=terminal(tasks,full)
  await tasks.retainResult(task.id)
  await tasks.flushPersistence()
  const saved=writes.at(-1)!
  expect(saved.formatVersion).toBe(2)
  expect(saved.tasks[0]).toMatchObject({outcome:'completed',resultText:full})
  expect(saved.tasks[0]!.result).toBeUndefined()
  expect(saved.tasks[0]!.legacyFormatVersion).toBeUndefined()
  expect(tasks.get(task.id)?.retention).toBe('durable')
})
it('keeps missing bodies in restored nonempty Task2 unqualified rather than reinterpreting them as live legacy results',async()=>{
  const old=createTaskRegistry()
  const full='actual saved presentation'
  const original=terminal(old,full)
  const {tasks,writes}=legacyStrict()
  tasks.restore({formatVersion:2,tasks:[structuredClone(original)],notifications:[]})
  expect(tasks.get(original.id)).toMatchObject({publication:'unqualified',outcome:'recovery-required',resultText:full})
  await expect(tasks.retainResult(original.id)).rejects.toThrow('Retained task body incomplete')
  expect(writes).toHaveLength(0)
})
it('keeps literal Task1 text provenance without inventing a retained result',async()=>{
  const old=createTaskRegistry()
  const original=terminal(old,'genuine historical text')
  const {tasks}=legacyStrict()
  tasks.restore({formatVersion:1,tasks:[structuredClone(original)],notifications:[]})
  await tasks.retainResult(original.id)
  expect(tasks.get(original.id)).toMatchObject({legacyFormatVersion:1,outcome:'completed',resultText:'genuine historical text',retention:'durable'})
  expect(tasks.get(original.id)?.result).toBeUndefined()
})

async function bodyStore(quota = false, pause?: Promise<void>, reader = true) {
  const root = await mkdtemp(join(tmpdir(),'legacy-task2-body-'))
  const store = createContextOutputService({root,workspaceId:'task2-matrix',config:{enabled:true,...(quota?{maxDiskBytes:1}:{})}})
  let captures = 0
  const results: TaskResultStore = {
    available: () => reader,
    capture(task,body,revision,execution) {
      captures++
      const scope = store.registerResultScope({operationId:revision,sessionId:'parent',callId:task.id,documentId:'task-parent'},()=>true)
      const original=createResultCapture(body,execution!,{forceArtifact:true,openArtifact:()=>store.beginResult(scope,'json-utf8-v1')})
      return pause?{async settle(){await pause;return original.settle()}}:original
    },
    async read(_task,ref,args) {
      if (!reader) throw Error('Declared result reader unavailable')
      return store.readResult({sessionId:'parent'},{ref,...args})
    },
  }
  return {results,captures:()=>captures,setReader(value:boolean){reader=value},async close(){
    await store.close()
    const target=resolve(root)
    if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('legacy-task2-body-'))throw Error('Unsafe body fixture cleanup')
    await rm(target,{recursive:true,force:true})
  }}
}
it('preserves actual retained Task2 data and literal Task1 rows when a cold reader has no result capability',async()=>{
  const bodies=await bodyStore()
  try {
    const old=createTaskRegistry()
    const legacy=terminal(old,'literal full text')
    const live=legacyStrict(bodies.results)
    live.tasks.restore({formatVersion:1,tasks:[structuredClone(legacy)],notifications:[]})
    const artifact=terminal(live.tasks,'actual retained body'.repeat(1000))
    await live.tasks.retainResult(artifact.id);await live.tasks.flushPersistence()
    const saved=structuredClone(live.writes.at(-1)!)
    const original=saved.tasks.find(row=>row.id===artifact.id)!.result!
    expect(original.kind).toBe('retained')
    const cold=legacyStrict()
    cold.tasks.restore(saved)
    expect(cold.tasks.get(legacy.id)).toMatchObject({legacyFormatVersion:1,resultText:'literal full text',retention:'durable'})
    expect(cold.tasks.get(artifact.id)).toMatchObject({publication:'unqualified',retention:'failed'})
    await expect(cold.tasks.readResult(artifact.id,{})).rejects.toThrow('reader unavailable')
    const added=terminal(cold.tasks,'new full legacy presentation')
    await cold.tasks.retainResult(added.id);await cold.tasks.flushPersistence()
    const mixed=cold.writes.at(-1)!
    expect(mixed.formatVersion).toBe(2)
    expect(mixed.tasks.find(row=>row.id===artifact.id)?.result).toEqual(cold.tasks.get(artifact.id)?.result)
    expect(mixed.tasks.find(row=>row.id===artifact.id)?.result?.revision).toBe(original.revision)
    expect(mixed.tasks.find(row=>row.id===added.id)).toMatchObject({resultText:'new full legacy presentation'})
    expect(mixed.tasks.find(row=>row.id===added.id)?.result).toBeUndefined()
    expect(mixed.tasks.find(row=>row.id===added.id)?.legacyFormatVersion).toBeUndefined()
    expect(bodies.captures()).toBe(1)
  } finally {await bodies.close()}
})
it('keeps a restored pending result unresolved even when a real result store is available',async()=>{
  const release=Promise.withResolvers<void>()
  const bodies=await bodyStore(false,release.promise)
  const live=legacyStrict(bodies.results)
  const task=terminal(live.tasks,'original pending body')
  try {
    await live.tasks.save();await live.tasks.flushPersistence()
    const pending=structuredClone(live.writes.at(-1)!)
    expect(pending.tasks[0]?.result?.kind).toBe('pending')
    const cold=legacyStrict(bodies.results)
    cold.tasks.restore(pending)
    await expect(cold.tasks.retainResult(task.id)).rejects.toThrow('Original task body capture unavailable')
    expect(cold.writes).toHaveLength(0)
    expect(bodies.captures()).toBe(1)
  } finally {release.resolve();await live.tasks.retainResult(task.id);await bodies.close()}
})
it('keeps actual quota-unavailable result capture separate from full legacy presentation',async()=>{
  const bodies=await bodyStore(true)
  try {
    const live=legacyStrict(bodies.results)
    live.tasks.restore({formatVersion:2,tasks:[],notifications:[]})
    const full='full source'.repeat(2000)
    const task=terminal(live.tasks,full)
    await live.tasks.retainResult(task.id);await live.tasks.flushPersistence()
    expect(live.tasks.get(task.id)).toMatchObject({outcome:'completed',retention:'failed'})
    expect(live.tasks.get(task.id)?.result).toMatchObject({kind:'retained',envelope:{retention:{kind:'unavailable',reason:'quota'}}})
    expect(live.tasks.get(task.id)?.resultText).not.toBe(full)
    expect(bodies.captures()).toBe(1)
  } finally {await bodies.close()}
})

it('does not advertise a declared-unavailable real reader or replace its original retained data',async()=>{
  const bodies=await bodyStore(false,undefined,false)
  try {
    const live=legacyStrict(bodies.results)
    const task=terminal(live.tasks,'actual retained bytes')
    await live.tasks.retainResult(task.id);await live.tasks.flushPersistence()
    const saved=structuredClone(live.writes.at(-1)!)
    const cold=legacyStrict(bodies.results)
    cold.tasks.restore(saved)
    expect(cold.tasks.get(task.id)).toMatchObject({retention:'failed'})
    await expect(cold.tasks.readResult(task.id,{})).rejects.toThrow('Declared result reader unavailable')
    await cold.tasks.save();await cold.tasks.flushPersistence()
    expect(cold.writes.at(-1)!.formatVersion).toBe(2)
    expect(cold.writes.at(-1)!.tasks[0]!.result?.revision).toBe(saved.tasks[0]!.result?.revision)
    expect(bodies.captures()).toBe(1)
  } finally {await bodies.close()}
})
it('refuses a pending Task2 body without any original result owner rather than acknowledging only its document',async()=>{
  const release=Promise.withResolvers<void>(), bodies=await bodyStore(false,release.promise)
  const live=legacyStrict(bodies.results), task=terminal(live.tasks,'original pending bytes')
  try {
    await live.tasks.save();await live.tasks.flushPersistence()
    const pending=structuredClone(live.writes.at(-1)!)
    expect(pending.tasks[0]!.result?.kind).toBe('pending')
    const pendingResult=structuredClone(pending.tasks[0]!.result)
    const cold=legacyStrict()
    cold.tasks.restore(pending)
    await expect(cold.tasks.retainResult(task.id)).rejects.toThrow('Original task body capture unavailable')
    expect(cold.tasks.get(task.id)?.retention).not.toBe('durable')
    expect(cold.writes).toHaveLength(0)
    release.resolve()
    await live.tasks.retainResult(task.id)
    expect(live.tasks.get(task.id)?.result?.kind).toBe('retained')
    expect(cold.tasks.get(task.id)?.result).toEqual(pendingResult)
    await expect(cold.tasks.retainResult(task.id)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(cold.writes).toHaveLength(0)
    expect(bodies.captures()).toBe(1)
  } finally {release.resolve();await live.tasks.retainResult(task.id);await bodies.close()}
})

it('requires the original strict terminal write even if a live artifact row receives copied observation data',async()=>{
  const release=Promise.withResolvers<void>()
  const bodies=await bodyStore(false,release.promise)
  const live=legacyStrict(bodies.results)
  const task=terminal(live.tasks,'actual live artifact requiring strict ACK')
  try {
    const restored=legacyStrict(bodies.results)
    restored.tasks.restore({formatVersion:2,tasks:[structuredClone(task)],notifications:[]})
    task.savedObservation=structuredClone(restored.tasks.get(task.id)!.savedObservation)
    expect(task.savedObservation).toBeDefined()
    expect(live.writes).toHaveLength(0)
    release.resolve()
    await live.tasks.retainResult(task.id)
    expect(task.result?.kind).toBe('retained')
    expect(task.retention).toBe('durable')
    expect(live.writes.some(doc=>doc.tasks.some(row=>row.result?.kind==='retained'&&row.result.revision===task.result?.revision))).toBe(true)
    const revision=task.result!.revision
    task.result!.revision='changed-after-original-ack'
    await expect(live.tasks.retainResult(task.id)).rejects.toThrow('Original saved task result changed')
    task.result!.revision=revision
    expect(bodies.captures()).toBe(1)
  } finally {release.resolve();await live.tasks.retainResult(task.id);await bodies.close()}
})

it.each(['absent','unavailable'] as const)('does not upgrade the same restored artifact body from a document ACK when its reader is %s',async mode=>{
  const bodies=await bodyStore(false,undefined,mode==='absent')
  try {
    const live=legacyStrict(bodies.results)
    const task=terminal(live.tasks,'actual artifact body'.repeat(200))
    await live.tasks.retainResult(task.id);await live.tasks.flushPersistence()
    const saved=structuredClone(live.writes.at(-1)!)
    const cold=legacyStrict(mode==='absent'?undefined:bodies.results)
    cold.tasks.restore(saved)
    const before=structuredClone(cold.tasks.get(task.id)!)
    expect(before.retention).toBe('failed')
    const readBefore=await cold.tasks.readResult(task.id,{}).then(()=>({kind:'read'}),error=>({kind:'unavailable',message:error instanceof Error?error.message:String(error)}))
    const retained=await cold.tasks.retainResult(task.id).then(()=>({kind:'ack'}),error=>({kind:'blocked',error}))
    const after=cold.tasks.get(task.id)!
    const readAfter=await cold.tasks.readResult(task.id,{}).then(()=>({kind:'read'}),error=>({kind:'unavailable',message:error instanceof Error?error.message:String(error)}))
    expect(retained.kind).toBe('blocked')
    expect(after.retention).toBe('failed')
    expect(readAfter).toEqual(readBefore)
    expect(cold.writes).toHaveLength(0)
    expect(after.result).toEqual(before.result)
    expect(bodies.captures()).toBe(1)
  } finally {await bodies.close()}
})

it('rechecks cold reader availability after settlement without caching read qualification',async()=>{
  const bodies=await bodyStore()
  try {
    const live=legacyStrict(bodies.results)
    const task=terminal(live.tasks,'original live body')
    await live.tasks.retainResult(task.id)
    await live.tasks.flushPersistence()
    const cold=legacyStrict(bodies.results)
    cold.tasks.restore(structuredClone(live.writes.at(-1)!))
    const originalResult=structuredClone(cold.tasks.get(task.id)!.result)
    const observed: string[]=[]
    const unsubscribe=cold.tasks.subscribe(task.id,record=>observed.push(record.retention!))

    // The original result owner's settlement is asynchronous even when this
    // restored row has no pending capture. Withdraw the reader at that await.
    const retaining=cold.tasks.retainResult(task.id)
    bodies.setReader(false)
    await expect(retaining).rejects.toThrow('reader unavailable')
    expect(cold.tasks.get(task.id)?.retention).toBe('failed')
    expect(observed).toEqual(['failed'])
    expect(cold.writes).toHaveLength(0)
    await expect(cold.tasks.retainResult(task.id)).rejects.toThrow('reader unavailable')
    expect(observed).toEqual(['failed'])

    bodies.setReader(true)
    await cold.tasks.retainResult(task.id)
    await cold.tasks.retainResult(task.id)
    expect(cold.tasks.get(task.id)?.retention).toBe('durable')
    expect(observed).toEqual(['failed','durable'])
    expect(cold.writes).toHaveLength(1)
    bodies.setReader(false)
    await expect(cold.tasks.retainResult(task.id)).rejects.toThrow('reader unavailable')
    expect(cold.tasks.get(task.id)?.retention).toBe('failed')
    expect(observed).toEqual(['failed','durable','failed'])
    expect(cold.tasks.get(task.id)?.result).toEqual(originalResult)
    expect(cold.writes).toHaveLength(1)
    bodies.setReader(true)
    await cold.tasks.retainResult(task.id)
    expect(cold.tasks.get(task.id)?.retention).toBe('durable')
    expect(observed).toEqual(['failed','durable','failed','durable'])
    await cold.tasks.retainResult(task.id)
    expect(observed).toEqual(['failed','durable','failed','durable'])
    unsubscribe()
    expect(cold.writes).toHaveLength(1)
    expect(bodies.captures()).toBe(1)
    // A genuine live capture's existing ACK is independent of this cold read.
    await live.tasks.retainResult(task.id)
    expect(live.tasks.get(task.id)?.retention).toBe('durable')
  } finally {await bodies.close()}
})

it('retains the real strict ACK but refuses withdrawn cold-body qualification during its write',async()=>{
  const entered=Promise.withResolvers<void>()
  const release=Promise.withResolvers<void>()
  const bodies=await bodyStore()
  let retaining:Promise<void>|undefined
  try {
    const live=legacyStrict(bodies.results)
    const task=terminal(live.tasks,'real retained body before cold write')
    await live.tasks.retainResult(task.id)
    await live.tasks.flushPersistence()
    bodies.setReader(false)
    const cold=legacyStrict(bodies.results,async()=>{
      entered.resolve()
      await release.promise
    })
    cold.tasks.restore(structuredClone(live.writes.at(-1)!))
    expect(cold.tasks.get(task.id)?.retention).toBe('failed')
    const observed: string[]=[]
    const unsubscribe=cold.tasks.subscribe(task.id,record=>observed.push(record.retention!))
    bodies.setReader(true)
    retaining=cold.tasks.retainResult(task.id)
    void retaining.catch(()=>{})
    await Promise.race([entered.promise,retaining.then(()=>{throw Error('Strict write gate not reached')})])
    bodies.setReader(false)
    release.resolve()
    await expect(retaining).rejects.toThrow('reader unavailable')
    expect(cold.tasks.get(task.id)?.retention).toBe('failed')
    expect(observed).toEqual(['failed'])
    expect(cold.writes).toHaveLength(1)
    bodies.setReader(true)
    await cold.tasks.retainResult(task.id)
    expect(cold.tasks.get(task.id)?.retention).toBe('durable')
    expect(observed).toEqual(['failed','durable'])
    unsubscribe()
    expect(cold.writes).toHaveLength(1)
    expect(bodies.captures()).toBe(1)
  } finally {release.resolve();await retaining?.catch(()=>{});await bodies.close()}
})

it.each(['absent','unavailable'] as const)('keeps a genuinely owned restored artifact row failed when its reader is %s',async mode=>{
  const root=await mkdtemp(join(tmpdir(),'legacy-task2-owned-'))
  const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
  await coordinator.create({sessionId:'parent'})
  const document=await coordinator.openManagedDocument('parent')
  const ownedTask=captureOwnedTaskContext(coordinator,document,document.view,'parent')!
  const bodies=await bodyStore(false,undefined,false)
  const registries:ReturnType<typeof createTaskRegistry>[]=[]
  let terminal:RequiredTaskSettlement|undefined,released=false
  const action=document.beginAction(),source=action.registerSettlementSource(async()=>{if(!released)await terminal?.settle()})
  try {
    const live=createTaskRegistry({coordinator,stateId:'parent',ownedTask,reportPolicy:SHIPPING_REPORT_POLICY,results:bodies.results});registries.push(live);await live.ready
    const task=live.submit({identity:{parentSessionId:'parent',toolCallId:'owned-reader'},agentPath:'owned-reader',description:'before body',prompt:'go',agent:'general',delivery:'tool'})
    await live.flushPersistence()
    terminal=await bindRequiredTaskSettlement(live,task,source,async()=>({taskId:task.id,outcome:'cancelled',error:'original before-dispatch outcome'}))
    if(!terminal)throw Error('Original required Task unavailable')
    await terminal.settle();await terminal.release();released=true;action.finish();await source.close()
    const cold=createTaskRegistry({coordinator,stateId:'parent',ownedTask,reportPolicy:SHIPPING_REPORT_POLICY,results:mode==='absent'?undefined:bodies.results});registries.push(cold);await cold.ready
    const before=structuredClone(cold.get(task.id)!)
    expect(before.result).toMatchObject({kind:'retained',envelope:{retention:{kind:'artifact'}}})
    expect(before.retention).toBe('failed')
    const previous=lastOriginalTaskSave(cold)
    const result=await cold.retainResult(task.id).then(()=>({kind:'ack'}),error=>({kind:'blocked',error}))
    expect(result.kind).toBe('blocked')
    expect(cold.get(task.id)?.retention).toBe('failed')
    expect(lastOriginalTaskSave(cold)).toBe(previous)
    if(mode==='unavailable') {
      bodies.setReader(true)
      await cold.retainResult(task.id)
      expect(cold.get(task.id)?.retention).toBe('durable')
      expect(cold.get(task.id)?.result).toEqual(before.result)
      expect(lastOriginalTaskSave(cold)).not.toBe(previous)
    }
    expect(bodies.captures()).toBe(1)
  } finally {
    if(terminal&&!released){await terminal.settle();await terminal.release()}
    released=true;action.finish();await source.close()
    for(const registry of registries.reverse())await registry.closeOwnedLoad()
    await coordinator.close();await bodies.close()
    const target=resolve(root)
    if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('legacy-task2-owned-'))throw Error('Unsafe owned fixture cleanup')
    await rm(target,{recursive:true,force:true})
  }
})
