import {it,expect} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createContextOutputService} from '../src/service.ts'
import {captureHost} from '../src/artifact/transfer-codec.ts'
import {createTransferClosure} from '../src/artifact/transfer-closure.ts'
import {EMPTY_SEMANTIC_DEPENDENCY_DIGEST} from '@i-harness/core-session'

const binding={operationId:'coherent-operation',manifestDigest:'a'.repeat(64),sourceSessionId:'source',targetSessionId:'target',targetDocumentId:'target'}
const target={source:{sourceId:'workspace',readonly:true},revision:'revision-1'}

it('binds selected-result roots and their digest before the first native publication',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-transfer-contract-')),owner=createContextOutputService({root,workspaceId:'workspace'})
 try{
  const refs=[]
  for(const name of ['selected','unselected']){
   const source=owner.registerResultScope({operationId:'source-'+name,sessionId:'source',callId:name},()=>true),sink=await owner.beginResult(source,'text-utf8-v1')
   await sink.write(Buffer.from(name));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Original source publication unavailable');refs.push(saved.ref)
  }
  const selectedBinding={...binding,version:2 as const,resultsDigest:'b'.repeat(64)}
  const host={kind:'coherent-observation-v1' as const,binding:selectedBinding,sourceAccess:{sessionId:'source'},observeCurrent:()=>target}
  const request={version:2 as const,resultsDigest:selectedBinding.resultsDigest,operationId:binding.operationId,targetSessionId:binding.targetSessionId,manifestDigest:binding.manifestDigest,sourceSessionId:binding.sourceSessionId,artifacts:[{ref:refs[0]!,origins:[],uses:[{kind:'result' as const}]}]}
  expect(()=>owner.registerSeedDependencyTransfer(host,'original-publication')).toThrow()
  const scope=owner.registerSeedDependencyTransfer(host,'original-publication',request)
  expect(await owner.confirmSeedDependencies(scope,{...request,resultsDigest:'c'.repeat(64)},()=>true)).toEqual({kind:'blocked',reason:'conflict'})
  expect(await owner.confirmSeedDependencies(scope,{...request,artifacts:[...request.artifacts,{ref:refs[1]!,origins:[],uses:[{kind:'result'}]}]},()=>true)).toEqual({kind:'blocked',reason:'conflict'})
  for(const ref of refs)await expect(owner.readResult({sessionId:'target'},{ref,maxBytes:1024})).rejects.toThrow()
  const result=await owner.confirmSeedDependencies(scope,request,()=>true)
  expect(result.kind).toBe('confirmed')
  expect((await owner.readResult({sessionId:'target'},{ref:refs[0]!,maxBytes:1024})).data).toEqual({kind:'text',text:'selected'})
  await expect(owner.readResult({sessionId:'target'},{ref:refs[1]!,maxBytes:1024})).rejects.toThrow()
  expect(createTransferClosure('workspace',binding).finish()).not.toBe(createTransferClosure('workspace',selectedBinding).finish())
 }finally{await owner.close();await rm(root,{recursive:true,force:true})}
},60000)

it('checks original admission and target policy for an empty V2 managed closure',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-empty-closure-')),owner=createContextOutputService({root,workspaceId:'workspace'})
 try{
  let available=false,checks=0
  const selectedBinding={...binding,version:2 as const,resultsDigest:'d'.repeat(64)}
  const host={kind:'coherent-observation-v1' as const,binding:selectedBinding,sourceAccess:{sessionId:'source'},observeCurrent(){checks++;return target}}
  const request={version:2 as const,resultsDigest:selectedBinding.resultsDigest,operationId:binding.operationId,targetSessionId:binding.targetSessionId,manifestDigest:binding.manifestDigest,sourceSessionId:binding.sourceSessionId,artifacts:[]}
  const scope=owner.registerSeedDependencyTransfer(host,'original-publication',request)
  expect((await owner.confirmSeedDependencies(scope,request,()=>available)).kind).toBe('blocked');expect(checks).toBe(0)
  available=true
  const result=await owner.confirmSeedDependencies(scope,request,()=>true)
  expect(result.kind).toBe('confirmed')
  expect(checks).toBeGreaterThan(0)
  if(result.kind==='confirmed'){expect(result.closureDigest).toBe(createTransferClosure('workspace',selectedBinding).finish());expect(result.closureDigest).not.toBe(EMPTY_SEMANTIC_DEPENDENCY_DIGEST)}
  let targetAvailable=false
  const denied=owner.registerSeedDependencyTransfer({...host,observeCurrent(){if(!targetAvailable)throw Error('Original target unavailable');return target}},'original-publication',request)
  expect((await owner.confirmSeedDependencies(denied,request,()=>true)).kind).toBe('blocked')
  targetAvailable=true
  expect((await owner.confirmSeedDependencies(denied,request,()=>true)).kind).toBe('blocked')
 }finally{await owner.close();await rm(root,{recursive:true,force:true})}
},60000)

it('captures the disjoint coherent observer without accepting mixed or asynchronous shapes',()=>{
 const host={kind:'coherent-observation-v1' as const,binding,sourceAccess:{sessionId:'source'},observeCurrent(_mode:'active'|'passive'){return target}}
 expect(captureHost(host as never)).toMatchObject({kind:'coherent-observation-v1'})
 expect(()=>captureHost({...host,targetAvailable(){return true}} as never)).toThrow()
 expect(()=>captureHost({...host,observeCurrent:async()=>target} as never)).not.toThrow()
})

it('retains real artifact publication with one fresh coherent observation per active check',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'coherent-transfer-')),owner=createContextOutputService({root,workspaceId:'workspace'})
 try{
  const source=owner.registerResultScope({operationId:'source-operation',sessionId:'source',callId:'call'},()=>true),sink=await owner.beginResult(source,'text-utf8-v1');await sink.write(Buffer.from('original'));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Fixture publication unavailable')
  const sequence:string[]=[],host={kind:'coherent-observation-v1' as const,binding,sourceAccess:{sessionId:'source'},observeCurrent(mode:'active'|'passive'){sequence.push(mode);return target}}
  const scope=owner.registerSeedDependencyTransfer(host as never),request={operationId:binding.operationId,targetSessionId:binding.targetSessionId,manifestDigest:binding.manifestDigest,sourceSessionId:binding.sourceSessionId,artifacts:[{ref:saved.ref,origins:[{origin:0,seq:1,part:'result'}],uses:[{kind:'result' as const}]}]}
  let caller=0;expect((await owner.confirmSeedDependencies(scope,request,()=>{caller++;return true})).kind).toBe('confirmed');expect(caller).toBeGreaterThan(0);expect(sequence).toHaveLength(caller);expect(sequence.every(mode=>mode==='active')).toBe(true)
 }finally{await owner.close();await rm(root,{recursive:true,force:true})}
},60_000)

it('keeps the original callback sequence for the legacy host form',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'old-transfer-')),owner=createContextOutputService({root,workspaceId:'workspace'})
 try{
  const source=owner.registerResultScope({operationId:'old-source',sessionId:'source',callId:'call'},()=>true),sink=await owner.beginResult(source,'text-utf8-v1');await sink.write(Buffer.from('original'));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Fixture publication unavailable')
  const sequence:string[]=[],host={binding,sourceAccess:{sessionId:'source'},targetAvailable(){sequence.push('targetAvailable');return true},assertTargetCurrent(){sequence.push('targetCurrent')},targetScope(){sequence.push('targetScope');return target},sourceAvailable(){sequence.push('sourceAvailable');return true},assertSourceCurrent(){sequence.push('sourceCurrent')}}
  const scope=owner.registerSeedDependencyTransfer(host),request={operationId:binding.operationId,targetSessionId:binding.targetSessionId,manifestDigest:binding.manifestDigest,sourceSessionId:binding.sourceSessionId,artifacts:[{ref:saved.ref,origins:[{origin:0,seq:1,part:'result'}],uses:[{kind:'result' as const}]}]}
  expect((await owner.confirmSeedDependencies(scope,request,()=>{sequence.push('caller');return true})).kind).toBe('confirmed')
  expect(sequence.length).toBeGreaterThan(0);expect(sequence.length%6).toBe(0)
  for(let index=0;index<sequence.length;index+=6)expect(sequence.slice(index,index+6)).toEqual(['targetAvailable','targetCurrent','targetScope','sourceAvailable','caller','sourceCurrent'])
 }finally{await owner.close();await rm(root,{recursive:true,force:true})}
},60_000)

it('refuses an asynchronous coherent observation before target publication',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'async-transfer-')),owner=createContextOutputService({root,workspaceId:'workspace'})
 try{
  const source=owner.registerResultScope({operationId:'async-source',sessionId:'source',callId:'call'},()=>true),sink=await owner.beginResult(source,'text-utf8-v1');await sink.write(Buffer.from('original'));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Fixture publication unavailable')
  const host={kind:'coherent-observation-v1' as const,binding,sourceAccess:{sessionId:'source'},async observeCurrent(){return target}},scope=owner.registerSeedDependencyTransfer(host as never),request={operationId:binding.operationId,targetSessionId:binding.targetSessionId,manifestDigest:binding.manifestDigest,sourceSessionId:binding.sourceSessionId,artifacts:[{ref:saved.ref,origins:[{origin:0,seq:1,part:'result'}],uses:[{kind:'result' as const}]}]}
  expect((await owner.confirmSeedDependencies(scope,request,()=>true)).kind).toBe('blocked');await expect(owner.readResult({sessionId:'target'},{ref:saved.ref})).rejects.toThrow()
 }finally{await owner.close();await rm(root,{recursive:true,force:true})}
},60_000)

it('runs the active caller before the coherent observer and refuses its mutation',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'coherent-mutation-')),owner=createContextOutputService({root,workspaceId:'workspace'})
 try{
  const source=owner.registerResultScope({operationId:'mutation-source',sessionId:'source',callId:'call'},()=>true),sink=await owner.beginResult(source,'text-utf8-v1');await sink.write(Buffer.from('original'));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Fixture publication unavailable')
  const order:string[]=[];let current=true
  const host={kind:'coherent-observation-v1' as const,binding,sourceAccess:{sessionId:'source'},observeCurrent(_mode:'active'|'passive'){order.push('observer');if(!current)throw Error('changed');return target}},scope=owner.registerSeedDependencyTransfer(host as never),request={operationId:binding.operationId,targetSessionId:binding.targetSessionId,manifestDigest:binding.manifestDigest,sourceSessionId:binding.sourceSessionId,artifacts:[{ref:saved.ref,origins:[{origin:0,seq:1,part:'result'}],uses:[{kind:'result' as const}]}]}
  expect((await owner.confirmSeedDependencies(scope,request,()=>{order.push('caller');current=false;return true})).kind).toBe('blocked');expect(order.slice(0,2)).toEqual(['caller','observer']);await expect(owner.readResult({sessionId:'target'},{ref:saved.ref})).rejects.toThrow()
 }finally{await owner.close();await rm(root,{recursive:true,force:true})}
},60_000)

it('rechecks the captured observer identity and makes reentry sticky',()=>{
 let captured:ReturnType<typeof captureHost>,inside=false
 const host={kind:'coherent-observation-v1' as const,binding,sourceAccess:{sessionId:'source'},observeCurrent(_mode:'active'|'passive'){
  if(!inside){inside=true;try{if('kind'in captured)captured.observeCurrent('active')}catch{}finally{inside=false}}return target
 }}
 captured=captureHost(host as never);if(!('kind'in captured))throw Error('Coherent capture missing')
 expect(()=>captured.observeCurrent('active')).toThrow();expect(()=>captured.observeCurrent('active')).toThrow()
 const changed={kind:'coherent-observation-v1' as const,binding,sourceAccess:{sessionId:'source'},observeCurrent(_mode:'active'|'passive'){return target}},next=captureHost(changed as never);changed.observeCurrent=()=>target
 if(!('kind'in next))throw Error('Coherent capture missing');expect(()=>next.observeCurrent('active')).toThrow()
})

it('passive reconciliation observes only the target and ignores the original source signal',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'coherent-passive-')),owner=createContextOutputService({root,workspaceId:'workspace'})
 try{
  const source=owner.registerResultScope({operationId:'passive-source',sessionId:'source',callId:'call'},()=>true),sink=await owner.beginResult(source,'text-utf8-v1');await sink.write(Buffer.from('original'));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Fixture publication unavailable')
  const abort=new AbortController(),modes:string[]=[],host={kind:'coherent-observation-v1' as const,binding,sourceAccess:{sessionId:'source',signal:abort.signal},observeCurrent(mode:'active'|'passive'){modes.push(mode);return target}},scope=owner.registerSeedDependencyTransfer(host as never),request={operationId:binding.operationId,targetSessionId:binding.targetSessionId,manifestDigest:binding.manifestDigest,sourceSessionId:binding.sourceSessionId,artifacts:[{ref:saved.ref,origins:[{origin:0,seq:1,part:'result'}],uses:[{kind:'result' as const}]}]}
  expect((await owner.confirmSeedDependencies(scope,request,()=>true)).kind).toBe('confirmed');modes.length=0;abort.abort();expect((await owner.reconcileSeedDependencies(scope,request)).kind).toBe('confirmed');expect(modes.length).toBeGreaterThan(0);expect(modes.every(mode=>mode==='passive')).toBe(true)
 }finally{await owner.close();await rm(root,{recursive:true,force:true})}
},60_000)

it('refuses a changed coherent target snapshot across an actual transfer await',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'coherent-target-change-')),owner=createContextOutputService({root,workspaceId:'workspace'})
 try{
  const source=owner.registerResultScope({operationId:'changed-source',sessionId:'source',callId:'call'},()=>true),sink=await owner.beginResult(source,'text-utf8-v1');await sink.write(Buffer.from('original'));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Fixture publication unavailable')
  let observations=0;const host={kind:'coherent-observation-v1' as const,binding,sourceAccess:{sessionId:'source'},observeCurrent(_mode:'active'|'passive'){observations++;return observations===1?target:{...target,revision:'changed'}}},scope=owner.registerSeedDependencyTransfer(host as never),request={operationId:binding.operationId,targetSessionId:binding.targetSessionId,manifestDigest:binding.manifestDigest,sourceSessionId:binding.sourceSessionId,artifacts:[{ref:saved.ref,origins:[{origin:0,seq:1,part:'result'}],uses:[{kind:'result' as const}]}]}
  expect((await owner.confirmSeedDependencies(scope,request,()=>true)).kind).toBe('blocked');expect(observations).toBeGreaterThan(1);await expect(owner.readResult({sessionId:'target'},{ref:saved.ref})).rejects.toThrow()
 }finally{await owner.close();await rm(root,{recursive:true,force:true})}
},60_000)

it('revokes a coherent transfer when its observer reenters the same original scope',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'coherent-reentry-')),owner=createContextOutputService({root,workspaceId:'workspace'})
 try{
  const source=owner.registerResultScope({operationId:'reentry-source',sessionId:'source',callId:'call'},()=>true),sink=await owner.beginResult(source,'text-utf8-v1');await sink.write(Buffer.from('original'));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Fixture publication unavailable')
  const request={operationId:binding.operationId,targetSessionId:binding.targetSessionId,manifestDigest:binding.manifestDigest,sourceSessionId:binding.sourceSessionId,artifacts:[{ref:saved.ref,origins:[{origin:0,seq:1,part:'result'}],uses:[{kind:'result' as const}]}]};let scope:ReturnType<typeof owner.registerSeedDependencyTransfer>,nested:Promise<import('@i-harness/core-session').BootstrapDependencyOutcome>|undefined
  const host={kind:'coherent-observation-v1' as const,binding,sourceAccess:{sessionId:'source'},observeCurrent(_mode:'active'|'passive'){nested??=owner.confirmSeedDependencies(scope,request,()=>true);return target}}
  scope=owner.registerSeedDependencyTransfer(host as never);expect((await owner.confirmSeedDependencies(scope,request,()=>true)).kind).toBe('blocked');expect((await nested!).kind).toBe('blocked');await expect(owner.readResult({sessionId:'target'},{ref:saved.ref})).rejects.toThrow()
 }finally{await owner.close();await rm(root,{recursive:true,force:true})}
},60_000)

it('refuses changed original coherent binding and access containers',()=>{
 const mutableBinding={...binding},access={sessionId:'source'},host={kind:'coherent-observation-v1' as const,binding:mutableBinding,sourceAccess:access,observeCurrent(_mode:'active'|'passive'){return target}},captured=captureHost(host as never)
 if(!('kind'in captured))throw Error('Coherent capture missing')
 mutableBinding.sourceSessionId='foreign';expect(()=>captured.observeCurrent('active')).toThrow();mutableBinding.sourceSessionId='source'
 access.sessionId='foreign';expect(()=>captured.observeCurrent('active')).toThrow()
})
