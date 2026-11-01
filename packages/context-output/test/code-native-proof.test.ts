import { it, expect, vi } from 'vitest'
const native=vi.hoisted(()=>({armed:false,entered:undefined as (()=>void)|undefined,gate:undefined as Promise<void>|undefined,fail:false,releases:0}))
vi.mock('@i-harness/fs-lock',async load=>{
 const real=await load<typeof import('@i-harness/fs-lock')>()
 return {...real,async acquireSessionLock(...args:Parameters<typeof real.acquireSessionLock>){
  const lease=await real.acquireSessionLock(...args),release=lease.release.bind(lease)
  lease.release=async()=>{const held=native.armed; if(held)native.armed=false;await release();if(held){native.releases++;native.entered?.();await native.gate;if(native.fail)throw false}}
  return lease
 }}
})
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import * as owner from '../src/service.ts'

async function fixture(effect:()=>void=()=>{},operationId='op') {
 const service=owner.createContextOutputService({root:await mkdtemp(join(process.env.IH_CONFIG_DIR!,'native-causal-')),workspaceId:'w'})
 const input={operationId,sessionId:'s',callId:'c',documentId:'document',source:{sourceId:'source'}}
 const scope=service.registerResultScope(input,()=>{effect();return true}),sink=await service.beginResult(scope,'code-output-manifest-v1')
 await sink.write(Buffer.from('native original'));const result=await sink.finish('complete')
 if(result.kind!=='committed')throw Error('Expected original native operation')
 return {service,scope,sink,expected:{operationId:input.operationId,sessionId:input.sessionId,callId:input.callId,source:input.source,ref:result.ref}}
}
it('refuses replaced method getters without invoking them and rejects currentness callback mutation',async()=>{
 let effect=()=>{};const f=await fixture(()=>effect());await f.service.confirmResultOwner(f.scope,f.expected.ref)
 const serviceMethod=Object.getOwnPropertyDescriptor(f.service,'beginResult')!,sinkMethod=Object.getOwnPropertyDescriptor(f.sink,'finish')!
 let calls=0
 try{
  Object.defineProperty(f.service,'beginResult',{configurable:true,enumerable:true,get(){calls++;return serviceMethod.value}})
  expect(()=>owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,f.expected)).toThrow();expect(calls).toBe(0)
  Object.defineProperty(f.service,'beginResult',serviceMethod)
  Object.defineProperty(f.sink,'finish',{configurable:true,enumerable:true,get(){calls++;return sinkMethod.value}})
  expect(()=>owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,f.expected)).toThrow();expect(calls).toBe(0)
  Object.defineProperty(f.sink,'finish',sinkMethod)
  effect=()=>{f.service.beginResult=async()=>f.sink}
  expect(()=>owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,f.expected)).toThrow()
  Object.defineProperty(f.service,'beginResult',serviceMethod)
  effect=()=>{f.sink.finish=async()=>({kind:'recovery-required',operationId:'forged'})}
  expect(()=>owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,f.expected)).toThrow()
 }finally{effect=()=>{};Object.defineProperty(f.service,'beginResult',serviceMethod);Object.defineProperty(f.sink,'finish',sinkMethod);await f.service.close()}
})
it('keeps confirmation proof nominal to its original service and refuses foreign refs or late closed lookup',async()=>{
 const f=await fixture(),other=await fixture(()=>{},'foreign')
 try{
  await f.service.confirmResultOwner(f.scope,f.expected.ref)
  const proof=owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,f.expected)
  expect(Object.keys(proof)).toEqual([])
  expect(owner.readConfirmedCodeManifest(f.service,proof)).toMatchObject(f.expected)
  expect(()=>owner.readConfirmedCodeManifest(f.service,{...proof})).toThrow()
  expect(()=>owner.readConfirmedCodeManifest(other.service,proof)).toThrow()
  expect(()=>owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,{...f.expected,ref:other.expected.ref})).toThrow()
  await f.service.close()
  expect(()=>owner.readConfirmedCodeManifest(f.service,proof)).toThrow()
  expect(()=>owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,f.expected)).toThrow()
 }finally{await f.service.close();await other.service.close()}
})
it('fences callback-started service close before returning a new nominal proof',async()=>{
 let effect=()=>{};const f=await fixture(()=>effect());await f.service.confirmResultOwner(f.scope,f.expected.ref)
 let close:Promise<void>|undefined
 try{effect=()=>{effect=()=>{};close=f.service.close()};expect(()=>owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,f.expected)).toThrow();await close}
 finally{effect=()=>{};await f.service.close()}
})
it.each([false,true])('requires the actual original native confirmation cleanup ACK (failure=%s)',async fail=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>()
 await f.service.confirmResultOwner(f.scope,f.expected.ref)
 const historical=owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,f.expected)
 native.armed=true;native.fail=fail;native.entered=entered.resolve;native.gate=gate.promise;native.releases=0
 let confirming:Promise<void>|undefined
 try{
  confirming=f.service.confirmResultOwner(f.scope,f.expected.ref);void confirming.catch(()=>{})
  await entered.promise // Actual confirmation IO finished; original lease release reply is held.
  expect(native.releases).toBe(1)
  expect(()=>owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,f.expected)).toThrow()
  expect(()=>owner.readConfirmedCodeManifest(f.service,historical)).toThrow()
  gate.resolve()
  if(fail){
   await expect(confirming).rejects.toBe(false)
   expect(()=>owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,f.expected)).toThrow()
   await expect(f.service.confirmResultOwner(f.scope,f.expected.ref)).rejects.toThrow(/cleanup|unresolved/)
   await expect(f.service.close()).rejects.toBe(false)
   expect(native.releases).toBe(1)
  }else{
   await confirming
   expect(owner.readConfirmedCodeManifest(f.service,owner.captureConfirmedCodeManifest(f.service,f.scope,f.sink,f.expected))).toMatchObject(f.expected)
   await f.service.close()
  }
 }finally{gate.resolve();native.armed=false;native.entered=undefined;native.gate=undefined;native.fail=false;await confirming?.catch(()=>{});if(!fail)await f.service.close()}
})

it('qualifies only the genuine confirmed manifest operation', async () => {
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'native-proof-'))
 const service=owner.createContextOutputService({root,workspaceId:'w'})
 const input={operationId:'op',sessionId:'s',callId:'c',source:{sourceId:'source'}}
 const scope=service.registerResultScope(input,()=>true), other=service.registerResultScope({...input,operationId:'other'},()=>true)
 const sink=await service.beginResult(scope,'code-output-manifest-v1')
 try {
  await sink.write(Buffer.from('manifest')); const result=await sink.finish('complete')
  if(result.kind!=='committed') throw Error('expected committed')
  const expected={...input,ref:result.ref}
  expect(()=>owner.captureConfirmedCodeManifest(service,scope,sink,expected)).toThrow()
  await service.confirmResultOwner(scope,result.ref)
  expect(owner.readConfirmedCodeManifest(service,owner.captureConfirmedCodeManifest(service,scope,sink,expected))).toMatchObject(expected)
  expect(()=>owner.captureConfirmedCodeManifest({...service},scope,sink,expected)).toThrow()
  expect(()=>owner.captureConfirmedCodeManifest(service,other,sink,expected)).toThrow()
  expect(()=>owner.captureConfirmedCodeManifest(service,scope,{...sink},expected)).toThrow()
 } finally { await service.close() }
})

it('does not qualify a pending or falsey failed original confirmation', async () => {
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'native-confirm-'))
 const service=owner.createContextOutputService({root,workspaceId:'w'})
 const input={operationId:'op',sessionId:'s',callId:'c',source:{sourceId:'source'}}
 let fail=false
 const scope=service.registerResultScope(input,()=>{if(fail)throw null;return true})
 const sink=await service.beginResult(scope,'code-output-manifest-v1')
 try {
  await sink.write(Buffer.from('original')); const result=await sink.finish('complete')
  if(result.kind!=='committed') throw Error('expected committed')
  const expected={...input,ref:result.ref}
  fail=true; await expect(service.confirmResultOwner(scope,result.ref)).rejects.toBe(null); fail=false
  expect(()=>owner.captureConfirmedCodeManifest(service,scope,sink,expected)).toThrow()
  const confirming=service.confirmResultOwner(scope,result.ref)
  expect(()=>owner.captureConfirmedCodeManifest(service,scope,sink,expected)).toThrow()
  await confirming
  expect(owner.readConfirmedCodeManifest(service,owner.captureConfirmedCodeManifest(service,scope,sink,expected))).toMatchObject(expected)
 } finally { fail=false; await service.close() }
})
