import { expect, it, vi } from 'vitest'
const native=vi.hoisted(()=>({root:'',bodyOpens:0,bodyWrites:0,bodyCloses:0,confirmRead:false,confirmAcks:0,acquires:0,releases:0,reads:0,afterAck:0,failAt:0,failed:false,gate:undefined as Promise<void>|undefined,entered:undefined as (()=>void)|undefined}))
vi.mock('node:fs/promises',async load=>{
 const real=await load<typeof import('node:fs/promises')>()
 return {...real,async open(...args:Parameters<typeof real.open>){
  const handle=await real.open(...args),path=String(args[0]).replaceAll('\\','/')
  if(native.root&&path.startsWith(native.root.replaceAll('\\','/'))){
   if(path.endsWith('/body')&&args[1]==='wx+'){
    native.bodyOpens++;const close=handle.close.bind(handle)
    handle.write=new Proxy(handle.write,{apply(target,receiver,input){native.bodyWrites++;return Reflect.apply(target,receiver,input)}})
    handle.close=async()=>{native.bodyCloses++;await close()}
   }
   if(path.endsWith('/operation.json')&&args[1]==='r'&&native.bodyCloses){native.confirmRead=true;native.reads++}
  }
  return handle
 }}
})
vi.mock('../../fs-lock/src/index.ts',async load=>{
 const real=await load<typeof import('../../fs-lock/src/index.ts')>()
 return {...real,async acquireSessionLock(...args:Parameters<typeof real.acquireSessionLock>){
  native.acquires++;const lease=await real.acquireSessionLock(...args),release=lease.release.bind(lease)
  lease.release=async()=>{native.releases++;const confirmation=native.confirmRead;native.confirmRead=false;await release();if(confirmation){native.confirmAcks++;native.entered?.();await native.gate;native.afterAck=0}}
  return lease
 }}
})
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { captureOriginalCodeManifestAdapter,readCodeManifestConfirmationHistory } from '../../context-output/src/service.ts'
import { createCodeOutputManifest,inspectCodeOutputManifestReceipt,inspectCodeOutputManifest } from '../../output-retention/src/result/code-output-manifest.ts'
import { createCodeFinalOutputRetention } from '../src/lifecycle/code-final-output-retention.ts'
import type { CodeOutputMember } from '@i-harness/core-session'
const member=(seq:number):CodeOutputMember=>({seq,receipt:{owner:{sessionId:'actor',incarnation:'original'},key:{batchId:'b',firstSeq:seq,count:1,previousPrefixDigest:'a'.repeat(64),batchDigest:'b'.repeat(64)},lastSeq:seq,prefixDigest:'c'.repeat(64)}})
const footer=()=>({terminal:member(1),status:'completed' as const,store:null,accepted:0,omitted:0,truncated:false})
async function setup(){
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'native-connection-'));Object.assign(native,{root,bodyOpens:0,bodyWrites:0,bodyCloses:0,confirmRead:false,confirmAcks:0,acquires:0,releases:0,reads:0,afterAck:0,failAt:0,failed:false,gate:undefined,entered:undefined})
 const service=createContextOutputService({root,workspaceId:'w'});return {service}
}
it('captures genuine confirmation history from the original companion',async()=>{
 const {service}=await setup();let held=true
 const port=createCodeFinalOutputRetention({service,sourceFor:async()=>({sourceId:'actual-source'})})({sessionId:'actor',cellId:'cell',sourceId:'operation',assertHeld(){if(!held)throw Error('expired')}})
 try{port.seal(footer());expect((await port.finish()).kind).toBe('ready');const receipt=inspectCodeOutputManifestReceipt(port)!
  expect(readCodeManifestConfirmationHistory(receipt)).toMatchObject({operationId:'operation',sessionId:'actor',callId:'cell',source:{sourceId:'actual-source'}})
  held=false;expect(readCodeManifestConfirmationHistory(receipt)).toMatchObject({operationId:'operation'})
 }finally{await service.close();native.root=''}
})
it.each(['held-ack','lost-outer-reply','capture-rejection'] as const)('retains the real companion native frontier and retries the same port: %s',async kind=>{
 const {service}=await setup(),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>()
 let sourceCalls=0
 native.failAt=kind==='lost-outer-reply'?2:kind==='capture-rejection'?3:0
 native.gate=gate.promise;native.entered=entered.resolve
 const port=createCodeFinalOutputRetention({service,sourceFor:async()=>{sourceCalls++;return {sourceId:'actual-source'}}})({sessionId:'actor',cellId:'cell',sourceId:'operation',assertHeld(){if(native.confirmAcks){native.afterAck++;if(native.failAt===native.afterAck&&!native.failed){native.failed=true;throw false}}}})
 try{
  port.seal(footer());let done=false
  const first=port.finish().then(value=>{done=true;return value});void first.catch(()=>{})
  await Promise.race([entered.promise,first.then(()=>{throw Error('Companion finished before owned confirmation gate '+JSON.stringify({opens:native.bodyOpens,writes:native.bodyWrites,closes:native.bodyCloses,acks:native.confirmAcks,acquires:native.acquires,releases:native.releases,reads:native.reads,marked:native.confirmRead}))},cause=>{throw new AggregateError([cause,{opens:native.bodyOpens,writes:native.bodyWrites,closes:native.bodyCloses,acks:native.confirmAcks,acquires:native.acquires,releases:native.releases,reads:native.reads,marked:native.confirmRead}],'Companion failed before owned confirmation gate')})])
  expect(done).toBe(false);expect(inspectCodeOutputManifestReceipt(port)).toBeUndefined()
  expect([native.bodyOpens,native.bodyWrites,native.bodyCloses]).toEqual([1,2,1])
  gate.resolve()
  if(kind==='held-ack')expect((await first).kind).toBe('ready')
  else{
   if(kind==='lost-outer-reply')await expect(first).rejects.toBe(false)
   else await expect(first).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED',cause:false})
   expect(inspectCodeOutputManifestReceipt(port)).toBeUndefined()
   expect((await port.finish()).kind).toBe('ready')
  }
  const receipt=inspectCodeOutputManifestReceipt(port)!,history=readCodeManifestConfirmationHistory(receipt),metadata=inspectCodeOutputManifest(port)!
  expect(history).toMatchObject({operationId:'operation',sessionId:'actor',callId:'cell',source:{sourceId:'actual-source'},ref:{codec:'code-output-manifest-v1',contentDigest:metadata.artifactDigest,encodedBytes:metadata.encodedBytes}})
  expect(sourceCalls).toBe(1);expect([native.bodyOpens,native.bodyWrites,native.bodyCloses]).toEqual([1,2,1])
  expect(native.confirmAcks).toBe(kind==='held-ack'?1:2)
  const acks=native.confirmAcks;await port.finish();expect(native.confirmAcks).toBe(acks);expect(inspectCodeOutputManifestReceipt(port)).toBe(receipt)
 }finally{gate.resolve();native.gate=undefined;native.entered=undefined;await service.close();native.root=''}
},10000)
it('refuses a genuine foreign scope/sink adapter and retains its copied transport selection',async()=>{
 const {service}=await setup()
 const scope=service.registerResultScope({operationId:'operation',sessionId:'actor',callId:'cell',source:{sourceId:'actual-source'}},()=>true)
 const other=service.registerResultScope({operationId:'foreign',sessionId:'actor',callId:'cell',source:{sourceId:'actual-source'}},()=>true)
 const own=captureOriginalCodeManifestAdapter(service,scope),foreign=captureOriginalCodeManifestAdapter(service,other)
 const transport={adapter:foreign,sourceId:'actual-source'};let callbacks=0
 const port=createCodeOutputManifest({version:1,kind:'code-output',sessionId:'actor',cellId:'cell',sourceId:'operation'},{open:()=>service.beginResult(scope,'code-output-manifest-v1'),confirm:ref=>service.confirmResultOwner(scope,ref),nativeAdapter(){callbacks++;return transport}})
 try{
  port.seal(footer());await expect(port.finish()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'});expect(inspectCodeOutputManifestReceipt(port)).toBeUndefined()
  transport.adapter=own // Cannot substitute a different scope after selected transport failed.
  await expect(port.finish()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'});expect(inspectCodeOutputManifestReceipt(port)).toBeUndefined()
  expect(callbacks).toBe(1);expect([native.bodyOpens,native.bodyWrites,native.bodyCloses]).toEqual([1,2,1])
 }finally{await service.close();native.root=''}
})
it('keeps actual generic ready presentation without manufacturing native qualification',async()=>{
 const {service}=await setup(),scope=service.registerResultScope({operationId:'operation',sessionId:'actor',callId:'cell',source:{sourceId:'actual-source'}},()=>true)
 const port=createCodeOutputManifest({version:1,kind:'code-output',sessionId:'actor',cellId:'cell',sourceId:'operation'},{open:()=>service.beginResult(scope,'code-output-manifest-v1'),confirm:ref=>service.confirmResultOwner(scope,ref)})
 try{port.seal(footer());expect((await port.finish()).kind).toBe('ready');expect(inspectCodeOutputManifestReceipt(port)).toBeUndefined()}finally{await service.close();native.root=''}
})
