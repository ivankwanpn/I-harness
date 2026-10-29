import { it,expect,vi } from 'vitest'
const fault=vi.hoisted(()=>({read:false,close:false,opens:0,handle:undefined as undefined|{fd:number},attempts:[] as object[]}))
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>()
 return {...fs,open:async(...args:Parameters<typeof fs.open>)=>{
  const handle=await fs.open(...args)
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
})

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
})
