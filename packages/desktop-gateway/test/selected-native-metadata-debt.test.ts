import { it,expect,vi } from 'vitest'
const nativeLeases = vi.hoisted(() => ({ paths: new Set<string>(), handles: [] as import('@i-harness/fs-lock').SessionLock[] }))
vi.mock('@i-harness/fs-lock', async importOriginal => {
 const actual = await importOriginal<typeof import('@i-harness/fs-lock')>()
 return { ...actual, async acquireSessionLock(...args: Parameters<typeof actual.acquireSessionLock>) {
  const original = await actual.acquireSessionLock(...args)
  if(nativeLeases.paths.has(args[0].lockPath))nativeLeases.handles.push(original)
  return original
 } }
})
const fault=vi.hoisted(()=>({read:false,close:false,opens:0,handle:undefined as undefined|{fd:number},attempts:[] as object[],multiple:false,handles:[] as import('node:fs/promises').FileHandle[],reads:0,release:undefined as Promise<void>|undefined,entered:undefined as (()=>void)|undefined,allowed:new Set<object>()}))
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>()
 return {...fs,open:async(...args:Parameters<typeof fs.open>)=>{
  const handle=await fs.open(...args)
  if(fault.multiple&&String(args[0]).includes('legacy-fork-v1')&&String(args[0]).endsWith('plan.json')&&args[1]==='r'){
   fault.handles.push(handle)
   return new Proxy(handle,{get(target,key){if(key==='read')return async()=>{if(++fault.reads===2)fault.entered?.();await fault.release;throw Error('concurrent original plan read failed')};if(key==='close')return async()=>{fault.attempts.push(target);if(!fault.allowed.has(target))throw Error('concurrent original plan close failed');await target.close()};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
  }
  if(!fault.read||!String(args[0]).includes('legacy-fork-v1')||!String(args[0]).endsWith('plan.json')||args[1]!=='r')return handle
  fault.opens++;fault.handle=handle
  return new Proxy(handle,{get(target,key){if(key==='read')return async()=>{fault.read=false;throw Error('original metadata read failed')};if(key==='close')return async()=>{fault.attempts.push(target);if(fault.close)throw Error('original metadata close failed');await target.close()};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
 }}
})
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'
import { observationCleanupFor } from '../../session-persistence/src/coordinator/binding-observation.ts'
import { legacyFixture } from '../../context-output/test/legacy-fork-fixture.ts'
import { ContextStore } from '../../context-output/src/store.ts'
import { createProcessAwareResultService } from '../../session-executor/src/lifecycle/process-result-service.ts'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import * as core from '../../context-output/src/service.ts'
import * as locks from '@i-harness/fs-lock'
import { createHash } from 'node:crypto'
import { artifactPathsFor } from '../../session-persistence/src/coordinator/artifact-path-association.ts'
// One genuine native fork measured 13.3 seconds before metadata acquisition.
// Two-fork cases also retain and retry two real descriptors and binding leases.
const SINGLE_FORK_CASE_MS = 30_000
const TWO_FORK_CASE_MS = 60_000
it.each(['operation','service'] as const)('hands lower metadata acquisition debt to the original operation with %s cleanup',async cleanupOwner=>{
 fault.opens=0;fault.attempts=[];fault.handle=undefined
 const f=await createGatewayForkFixture()
 try{
  await f.runtime.contextOutput.configure({enabled:true});const source=await f.runtime.sourceFor('source'),ref=await f.runtime.contextOutput.capture({sessionId:'source',callId:'debt',label:'x',text:'retained',complete:true,source});if(!ref)throw Error('capture failed')
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'question'},{type:'context/result-ref',ref},{type:'turn/end'}]);expect((await f.execute(await f.prepare('source','target','metadata-debt'))).kind).toBe('ready')
  fault.read=fault.close=true
  const error=await f.runtime.acquireSelectedSourceObservation('target').catch(error=>error)
  expect(fault.handle!.fd).toBeGreaterThanOrEqual(0);const cleanup=observationCleanupFor(f.coordinator,error);expect(cleanup).toBeDefined()
  expect(()=>f.runtime.acquireSelectedSourceObservation('target')).toThrow('cleanup unresolved')
  fault.close=false;if(cleanupOwner==='service')await f.runtime.contextOutput.close();await cleanup!.retry();expect(fault.handle!.fd).toBe(-1);expect(fault.opens).toBe(1);expect(fault.attempts.every(handle=>handle===fault.handle)).toBe(true)
  await cleanup!.retry();await f.runtime.close()
 }finally{fault.read=fault.close=false;await f.close()}
}, SINGLE_FORK_CASE_MS)

it.each(['retry','service'] as const)('retains both actual lower acquisition errors and binding dependencies until %s settles their two descriptors',async settlement=>{
 const f=await createGatewayForkFixture(),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>(),lookup=core.selectedMetadataCleanupFor,captured:Array<{error:unknown;cleanup:NonNullable<ReturnType<typeof lookup>>}>=[]
 let spy:{mockRestore():void}|undefined
 const acquisitions: Promise<unknown>[] = []
 const bindingLocks=nativeLeases.handles
 nativeLeases.paths.clear();bindingLocks.length=0
 try{
  await f.runtime.contextOutput.configure({enabled:true});const source=await f.runtime.sourceFor('source'),ref=await f.runtime.contextOutput.capture({sessionId:'source',callId:'concurrent-debt',label:'x',text:'retained',complete:true,source});if(!ref)throw Error('capture failed')
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'question'},{type:'context/result-ref',ref},{type:'turn/end'}])
  for(const id of ['targetA','targetB'])expect((await f.execute(await f.prepare('source',id,'debt-'+id))).kind).toBe('ready')
  for(const id of ['targetA','targetB']){
   const key='desktop-session-project-'+createHash('sha256').update(id).digest('hex')
   const capture=artifactPathsFor(f.backend)!.document(key)
   if(capture.kind!=='ready')throw Error('Original project document parent unavailable')
   capture.assertCurrent()
   nativeLeases.paths.add(locks.lockPathFor(f.sessions,'artifact-document-lease:'+capture.key))
  }
  spy=vi.spyOn(core,'selectedMetadataCleanupFor').mockImplementation((service,error)=>{const cleanup=lookup(service,error);if(service===f.runtime.contextOutput&&cleanup)captured.push({error,cleanup});return cleanup})
  fault.handles=[];fault.attempts=[];fault.reads=0;fault.allowed.clear();fault.release=leave.promise;fault.entered=()=>entered.resolve();fault.multiple=true
  for (const id of ['targetA', 'targetB']) {
   const flight = Promise.resolve().then(() => f.runtime.acquireSelectedSourceObservation(id)).catch(error => error)
   acquisitions.push(flight)
  }
  await Promise.race([entered.promise, ...acquisitions.map(flight => flight.then(value => {
   throw value instanceof Error ? value : new Error('Original acquisition settled before both read gates', { cause: value })
  }))])
  expect(fault.handles.length).toBe(2);leave.resolve()
  const errors=await Promise.all(acquisitions);expect(captured.length).toBe(2);expect(captured[0]!.error).not.toBe(captured[1]!.error)
  for(const entry of captured)expect(lookup(f.runtime.contextOutput,entry.error)).toBe(entry.cleanup)
  const operations=errors.map(error=>observationCleanupFor(f.coordinator,error));expect(operations.every(Boolean)).toBe(true)
  expect(bindingLocks.length).toBe(2);expect(bindingLocks.every(lock=>lock.held)).toBe(true)
  fault.allowed.add(fault.handles[0]!);await expect(captured[0]!.cleanup.retry()).rejects.toThrow();expect(fault.handles[1]!.fd).toBeGreaterThanOrEqual(0)
  expect(bindingLocks.every(lock=>lock.held)).toBe(true)
  fault.allowed.add(fault.handles[1]!);if(settlement==='service')await f.runtime.contextOutput.close();else await captured[0]!.cleanup.retry();expect(fault.handles.map(handle=>handle.fd)).toEqual([-1,-1]);const attempts=fault.attempts.length;await captured[0]!.cleanup.retry();await captured[1]!.cleanup.retry();expect(fault.attempts.length).toBe(attempts)
  for(const cleanup of operations)await cleanup!.retry()
  expect(bindingLocks.every(lock=>!lock.held)).toBe(true);nativeLeases.paths.clear()
  for(const id of ['targetA','targetB'])expect(await f.coordinator.withExistingSessionBindingObservation!({sessionIds:[id]},async()=>true)).toBe(true)
  expect(fault.handles.length).toBe(2);expect(fault.attempts.every(handle=>fault.handles.includes(handle as import('node:fs/promises').FileHandle))).toBe(true)
 }finally{
  leave.resolve();fault.multiple=false
  for(const handle of fault.handles)fault.allowed.add(handle)
  nativeLeases.paths.clear()
  try { await Promise.allSettled(acquisitions); await f.close() }
  finally { spy?.mockRestore() }
 }
}, TWO_FORK_CASE_MS)

it('preserves the original metadata owner and exact close debt when its bridge retires during acquisition',async()=>{
 const f=await legacyFixture();let bridge:ReturnType<typeof createProcessAwareResultService>|undefined,handle:Awaited<ReturnType<typeof open>>|undefined,fail=true,injected=false,attempts=0
 const canonical=ContextStore.prototype.canonicalRef,joinFiles=ContextStore.prototype.joinLegacyFiles
 let canonicalSpy:{mockRestore():void}|undefined,joinSpy:{mockRestore():void}|undefined
 try{
  expect((await f.run()).kind).toBe('ready');const observation=await f.observation();await f.service().close()
  bridge=createProcessAwareResultService({root:f.root,workspaceId:'workspace',config:{enabled:true},coordinatorFor:()=>f.coordinator(),sourceFor:async()=>({sourceId:observation.sourceId,readonly:true}),genericVisible:async()=>false})
  canonicalSpy=vi.spyOn(ContextStore.prototype,'canonicalRef').mockImplementation(async function(this:ContextStore,...args:Parameters<ContextStore['canonicalRef']>){const value=await canonical.apply(this,args);bridge!.retireBridge();return value})
  joinSpy=vi.spyOn(ContextStore.prototype,'joinLegacyFiles').mockImplementation(async function(this:ContextStore){if(!injected){injected=true;handle=await open(join(this.directory,'artifacts',f.visible.id+'.json'),'r');const original=handle;await this.retireLegacyFile(new Proxy(original,{get(target,key){if(key==='close')return async()=>{attempts++;if(fail)throw Error('retired original close debt');await target.close()};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}}))}await joinFiles.call(this)})
  const error=await bridge.acquireSelectedMetadata(observation).catch(error=>error);expect(error).toMatchObject({message:'retired original close debt'});expect(handle!.fd).toBeGreaterThanOrEqual(0)
  const cleanup=bridge.selectedMetadataCleanupFor(error);expect(cleanup).toBeDefined();fail=false;await cleanup!.retry();expect(handle!.fd).toBe(-1);expect(attempts).toBe(2);await cleanup!.retry();expect(attempts).toBe(2)
 }finally{fail=false;canonicalSpy?.mockRestore();joinSpy?.mockRestore();await bridge?.service.close();await f.close()}
}, SINGLE_FORK_CASE_MS)
