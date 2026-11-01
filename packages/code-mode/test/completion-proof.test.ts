import { expect, it, vi } from 'vitest'
const nativeClose=vi.hoisted(()=>({arm:false,entered:undefined as (()=>void)|undefined,gate:undefined as Promise<void>|undefined,fail:false,attempts:0}))
const worker=vi.hoisted(()=>({refuse:false,calls:0}))
vi.mock('node:worker_threads',async load=>{
 const real=await load<typeof import('node:worker_threads')>()
 return {...real,Worker:class extends real.Worker{constructor(...args:ConstructorParameters<typeof real.Worker>){worker.calls++;if(worker.refuse)throw Error('Original construction refused');super(...args)}}}
})
vi.mock('../../session-persistence/src/coordinator/settlement-source.ts',async load=>{
 const real=await load<typeof import('../../session-persistence/src/coordinator/settlement-source.ts')>()
 return {...real,createSettlementSource(...args:Parameters<typeof real.createSettlementSource>){
  if(!nativeClose.arm)return real.createSettlementSource(...args)
  nativeClose.arm=false;const drain=args[0]
  // Keep the actual original source/registration and fail BEFORE its retirement.
  args[0]=async()=>{await drain();nativeClose.attempts++;nativeClose.entered?.();await nativeClose.gate;if(nativeClose.fail){nativeClose.fail=false;throw false}}
  return real.createSettlementSource(...args)
 }}
})
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, instructionReplan } from '@i-harness/core-tools'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createCodeFinalOutputRetention } from '../../session-executor/src/lifecycle/code-final-output-retention.ts'
import { registerCodeMode, captureOriginalCodeCompletion } from '../src/register.ts'
import { observeOriginalCodeFinalOutputs,createFinalCodeOutputs } from '../src/final-output.ts'
import { createCellFinalizations,observeOriginalCellFinalizations,type OriginalCellFinalization } from '../src/finalization.ts'
import { createCodeModeRuntime } from '../src/runtime.ts'
import { createCodeOutputManifest } from '../../output-retention/src/result/code-output-manifest.ts'
import { captureOriginalCodeManifestAdapter } from '../../context-output/src/service.ts'
import { randomUUID } from 'node:crypto'

it('withholds a combined result at the original pre-Worker started acknowledgement boundary',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'held-start-')),sessions=join(root,'sessions');await mkdir(sessions)
 const coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract)
 const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),ctx=createContext(),tools=createToolRegistry(ctx)
 const service=createContextOutputService({root:join(root,'output'),workspaceId:'proof'}),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
 const begin=document.beginAction.bind(document)
 vi.spyOn(document,'beginAction').mockImplementation((...args)=>{
  const action=begin(...args),record=action.facts.code.record.bind(action.facts.code)
  vi.spyOn(action.facts.code,'record').mockImplementation(async event=>{const outcome=await record(event);if(event.type==='code/cell'&&event.state==='started'){entered.resolve();await gate.promise}return outcome})
  return action
 })
 worker.calls=0
 const mount=registerCodeMode(ctx,tools,{session:document.view,sessionId:id,factOwner:document,config:{mode:'mixed'},finalOutput:createCodeFinalOutputRetention({service,sourceFor:async()=>({sourceId:'original'})})})
 let completion!:ReturnType<typeof captureOriginalCodeCompletion>
 const off=observeOriginalCodeFinalOutputs(mount,cell=>{completion=captureOriginalCodeCompletion(mount,cell)})
 let running:Promise<unknown>|undefined,pending:ReturnType<ReturnType<typeof captureOriginalCodeCompletion>['settle']>|undefined
 try{
  running=tools.get('code_exec')!.execute({code:'store("k",1)',yield_time_ms:0},{session:document.view,sessionId:id});void running.catch(()=>{})
  await entered.promise;let done=false;pending=completion.settle().then(value=>{done=true;return value});void pending.catch(()=>{})
  await new Promise<void>(resolve=>setImmediate(resolve))
  expect(done).toBe(false);expect(worker.calls).toBe(0);expect(document.view.events.some(event=>event.type==='code/cell'&&event.state==='started')).toBe(true)
  gate.resolve();await running;expect(await pending).toMatchObject({kind:'qualified',worker:'acquired',eligible:true});expect(worker.calls).toBe(1)
 }finally{gate.resolve();off();await running;await pending;await mount.dispose();await coordinator.close();await service.close();vi.restoreAllMocks()}
},10000)

it('keeps a real native quota refusal known after two original acknowledged output members',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'refused-manifest-')),sessions=join(root,'sessions');await mkdir(sessions)
 const coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract)
 const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),action=document.beginAction()
 const source=action.registerSettlementSource(async()=>{})
 const service=createContextOutputService({root:join(root,'output'),workspaceId:'quota',config:{maxDiskBytes:1}})
 const port=createCodeFinalOutputRetention({service,sourceFor:async()=>({sourceId:'original'})})({sessionId:id,cellId:'cell',sourceId:randomUUID(),assertHeld:source.assertHeld.bind(source)})
 try{
  await action.facts.code.record({type:'code/cell',cellId:'cell',state:'started'})
  for(let i=0;i<2;i++){
   const capture=source.code.capture({type:'code/output',cellId:'cell',content:{type:'audio',audioUrl:'original'}}),outcome=await capture.admit()
   if(outcome.kind!=='committed')throw Error('Expected original acknowledged member')
   await port.append(capture,{kind:'output',member:{seq:outcome.seqs[0]!,receipt:outcome.receipt},item:{kind:'audio',read:'current-fact-required'}})
  }
  const terminal=await source.code.capture({type:'code/cell',cellId:'cell',state:'completed'}).admit()
  if(terminal.kind!=='committed')throw Error('Expected original terminal')
  port.seal({terminal:{seq:terminal.seqs[0]!,receipt:terminal.receipt},status:'completed',store:null,accepted:2,omitted:0,truncated:false})
  expect(await port.finish()).toEqual({kind:'unavailable',reason:'quota'})
 }finally{await source.close();action.finish();await service.close();await coordinator.close()}
})

it.each(['self','parallel-cycle','healthy-dag'] as const)('keeps exact original custom finish waits finite: %s',async kind=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'close-cycle-')),sessions=join(root,'sessions');await mkdir(sessions)
 const coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract)
 const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),ctx=createContext(),tools=createToolRegistry(ctx)
 const ready=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
 const handles:ReturnType<typeof captureOriginalCodeCompletion>[]=[],errors:unknown[]=[];let calls=0
 const mount=registerCodeMode(ctx,tools,{session:document.view,sessionId:id,factOwner:document,config:{mode:'mixed'},finalOutput:()=>{
  const ordinal=calls++
  return {async append(){},seal(){},async finish(){
   await ready.promise;entered.resolve()
   if(kind==='healthy-dag'&&ordinal===1)return {kind:'unavailable' as const,reason:'unsupported-owner' as const}
   const target=handles[kind==='self'?ordinal:1-ordinal]!
   const wait=target.settle().catch(error=>{errors.push(error)})
   await Promise.race([wait,release.promise])
   return {kind:'unavailable' as const,reason:'unsupported-owner' as const}
  }}
 }})
 const off=observeOriginalCodeFinalOutputs(mount,cell=>{handles.push(captureOriginalCodeCompletion(mount,cell));if(handles.length===(kind==='self'?1:2))ready.resolve()})
 try{
  await tools.get('code_exec')!.execute({code:'text("one")',yield_time_ms:60000},{session:document.view,sessionId:id})
  if(kind!=='self')await tools.get('code_exec')!.execute({code:'text("two")',yield_time_ms:60000},{session:document.view,sessionId:id})
  await entered.promise
  await new Promise<void>(resolve=>setImmediate(resolve))
  release.resolve() // Break the old cycle explicitly; a timeout is never proof.
  expect(await Promise.all(handles.map(handle=>handle.settle()))).toEqual(handles.map(()=>expect.objectContaining({kind:'unqualified',eligible:false})))
  if(kind==='healthy-dag')expect(errors).toEqual([])
  else{expect(errors.length).toBeGreaterThan(0);expect(errors[0]).toMatchObject({code:'FACT_RECOVERY_REQUIRED'})}
  expect(await Promise.all(handles.map(handle=>handle.settle()))).toEqual(handles.map(()=>expect.objectContaining({kind:'unqualified'})))
 }finally{ready.resolve();release.resolve();off();await mount.dispose();await coordinator.close()}
},10000)

it('withholds actual native evidence until the same original source close ACK and retains falsey retry',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'native-close-')),sessions=join(root,'sessions');await mkdir(sessions)
 const coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract)
 const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),ctx=createContext(),tools=createToolRegistry(ctx)
 const service=createContextOutputService({root:join(root,'output'),workspaceId:'proof'})
 const entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();nativeClose.entered=entered.resolve;nativeClose.gate=gate.promise;nativeClose.fail=true;nativeClose.attempts=0
 let finishes=0
 const factory=createCodeFinalOutputRetention({service,sourceFor:async()=>{finishes++;return {sourceId:'original'}}})
 const mount=registerCodeMode(ctx,tools,{session:document.view,sessionId:id,factOwner:document,config:{mode:'mixed'},finalOutput:factory})
 let completion!:ReturnType<typeof captureOriginalCodeCompletion>
 const off=observeOriginalCodeFinalOutputs(mount,cell=>{completion=captureOriginalCodeCompletion(mount,cell);nativeClose.arm=true})
 try{
  await tools.get('code_exec')!.execute({code:'store("k",1)',yield_time_ms:60000},{session:document.view,sessionId:id})
  let done=false;const first=completion.settle().then(value=>{done=true;return value});void first.catch(()=>{})
  await entered.promise;expect(done).toBe(false);expect(nativeClose.attempts).toBe(1)
  gate.resolve();const failure=await first.then(()=>undefined,error=>error)
  expect(failure).toMatchObject({code:'FACT_RECOVERY_REQUIRED',errors:[false]})
  const [final,same]=await Promise.all([completion.settle(),completion.settle()])
  expect(same).toBe(final)
  expect(final).toMatchObject({kind:'qualified',eligible:true,worker:'acquired'})
  expect(nativeClose.attempts).toBe(2);expect(finishes).toBe(1)
  expect(await completion.settle()).toBe(final)
 }finally{gate.resolve();nativeClose.arm=false;nativeClose.entered=undefined;nativeClose.gate=undefined;nativeClose.fail=false;off();await mount.dispose();await coordinator.close();await service.close()}
},10000)

it('joins the actual mount and native manifest after original completion',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'completion-')),sessions=join(root,'sessions');await mkdir(sessions)
 const coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract)
 const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),ctx=createContext(),tools=createToolRegistry(ctx)
 tools.register({name:'stale',description:'',inputSchema:{},execute:async()=>{throw instructionReplan({code:'INSTRUCTIONS_REPLAN_REQUIRED',reason:'changed-dependency',currentFingerprint:'current'})}})
 const stopped=Promise.withResolvers<void>(),stopEntered=Promise.withResolvers<void>()
 tools.register({name:'held',description:'',inputSchema:{},execute:async(_args,exec)=>{stopEntered.resolve();exec.abortSignal?.addEventListener('abort',()=>stopped.resolve(),{once:true});await stopped.promise;return null}})
 const service=createContextOutputService({root:join(root,'output'),workspaceId:'proof'})
 const mount=registerCodeMode(ctx,tools,{session:document.view,sessionId:id,factOwner:document,config:{mode:'mixed'},finalOutput:createCodeFinalOutputRetention({service,sourceFor:async()=>({sourceId:'original'})})})
 let handle!:ReturnType<typeof captureOriginalCodeCompletion>,cell='',early!:ReturnType<ReturnType<typeof captureOriginalCodeCompletion>['settle']>
 const off=observeOriginalCodeFinalOutputs(mount,id=>{cell=id;handle=captureOriginalCodeCompletion(mount,id);early=handle.settle()})
 try{
  await tools.get('code_exec')!.execute({code:'text("original");store("k",1)',yield_time_ms:60000},{session:document.view,sessionId:id})
  expect(()=>captureOriginalCodeCompletion({...mount},cell)).toThrow()
  expect(()=>captureOriginalCodeCompletion(mount,'foreign')).toThrow()
  await expect({...handle}.settle()).rejects.toThrow(/handle required/)
  const selected=await early
  expect(selected).toMatchObject({kind:'qualified',worker:'acquired',cellId:cell,eligible:false,evidence:{unavailableTextCount:1,footer:{status:'completed'}}})
  const immutableEvidence=Reflect.get(selected,'evidence') as object,immutableFooter=Reflect.get(immutableEvidence,'footer') as object
  expect(Reflect.set(selected,'eligible',true)).toBe(false)
  expect(Reflect.set(immutableEvidence,'unavailableTextCount',0)).toBe(false)
  expect(Reflect.set(immutableFooter,'count',999)).toBe(false)
  expect(Reflect.set(Reflect.get(immutableFooter,'terminal') as object,'seq',999)).toBe(false)
  expect(await handle.settle()).toBe(selected)
  const fake={},forged=createFinalCodeOutputs(document,undefined,async()=>{}),full=createCellFinalizations('cell-finalization',document)
  forged.bind(fake);full.bind(fake);full.reserve(cell,async()=>{})
  expect(()=>captureOriginalCodeCompletion(fake,cell)).toThrow()
  await full.drain()
  const borrowedRuntime=createCodeModeRuntime({tools:()=>[],invoke:async()=>undefined});let borrowed!:OriginalCellFinalization
  const stopBorrow=observeOriginalCellFinalizations(borrowedRuntime,(_cell,original)=>{borrowed=original})
  try{
   await borrowedRuntime.exec({code:'text("other runtime")',yield_time_ms:60000});await borrowed.settle()
   expect(Reflect.set(handle,'runtimeOwner',borrowed)).toBe(false)
   await expect(handle.settle.call(borrowed)).rejects.toThrow(/handle required/)
   expect(await handle.settle()).toMatchObject({cellId:cell,kind:'qualified'})
  }finally{stopBorrow();await borrowedRuntime.dispose()}
  await tools.get('code_exec')!.execute({code:'store("empty",2)',yield_time_ms:60000},{session:document.view,sessionId:id})
  expect(await early).toMatchObject({kind:'qualified',worker:'acquired',eligible:true,evidence:{unavailableTextCount:0,footer:{count:0}}})
  await tools.get('code_exec')!.execute({code:'throw new Error("failure")',yield_time_ms:60000},{session:document.view,sessionId:id})
  expect(await early).toMatchObject({kind:'qualified',worker:'acquired',eligible:true,evidence:{footer:{status:'failed'}}})
  await expect(tools.get('code_exec')!.execute({code:'await tools.stale({})',yield_time_ms:60000},{session:document.view,sessionId:id})).rejects.toThrow('Instruction replan disposition unavailable')
  expect(await early).toMatchObject({kind:'qualified',worker:'acquired',eligible:false,evidence:{footer:{status:'replanned'}}})
  await tools.get('code_exec')!.execute({code:'await tools.held({})',yield_time_ms:0},{session:document.view,sessionId:id})
  await stopEntered.promise;await mount.terminateCell!(cell)
  expect(await early).toMatchObject({kind:'qualified',worker:'acquired',eligible:false,evidence:{footer:{status:'terminated'}}})
  worker.refuse=true
  await expect(tools.get('code_exec')!.execute({code:'text("must not run")',yield_time_ms:60000},{session:document.view,sessionId:id})).rejects.toThrow('Original construction refused')
  worker.refuse=false
  expect(await early).toMatchObject({kind:'qualified',worker:'not-acquired',eligible:false,evidence:{footer:{status:'failed',count:0}}})
 }finally{worker.refuse=false;stopped.resolve();off();await mount.dispose();await coordinator.close();await service.close()}
},30000)

it.each(['unavailable','ready','quota'] as const)('keeps unavailable or custom output observable without native qualification: %s',async disposition=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'custom-completion-')),sessions=join(root,'sessions');await mkdir(sessions)
 const coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract)
 const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),ctx=createContext(),tools=createToolRegistry(ctx)
 const service=disposition==='quota'?createContextOutputService({root:join(root,'output'),workspaceId:'proof',config:{maxDiskBytes:1}}):undefined
 const mount=registerCodeMode(ctx,tools,{session:document.view,sessionId:id,factOwner:document,config:{mode:'mixed'},finalOutput:service?createCodeFinalOutputRetention({service,sourceFor:async()=>({sourceId:'original'})}):()=>({async append(){},seal(){},async finish(){return disposition==='unavailable'?{kind:'unavailable',reason:'unsupported-owner'}:{kind:'ready',ref:{version:1,id:'ctxv1_'+'a'.repeat(64),revision:'b'.repeat(64),codec:'code-output-manifest-v1',encodedBytes:0,contentDigest:'c'.repeat(64),completeness:'complete'}}}})})
 let completion!:ReturnType<typeof captureOriginalCodeCompletion>
 const off=observeOriginalCodeFinalOutputs(mount,id=>{completion=captureOriginalCodeCompletion(mount,id)})
 try{
  expect(await tools.get('code_exec')!.execute({code:'text("custom");text("second")',yield_time_ms:60000},{session:document.view,sessionId:id})).toMatchObject({status:'completed',text:'custom\nsecond'})
  expect(await completion.settle()).toMatchObject({kind:'unqualified',worker:'acquired',eligible:false})
 }finally{off();await mount.dispose();await coordinator.close();await service?.close()}
},30000)

it.each(['cell','operation','native-bytes'] as const)('rejects a genuine native manifest with mismatched canonical %s',async mismatch=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'foreign-completion-')),sessions=join(root,'sessions');await mkdir(sessions)
 const coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract)
 const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),ctx=createContext(),tools=createToolRegistry(ctx)
 const service=createContextOutputService({root:join(root,'output'),workspaceId:'proof'})
 const original=createCodeFinalOutputRetention({service,sourceFor:async()=>({sourceId:'original'})})
 const mount=registerCodeMode(ctx,tools,{session:document.view,sessionId:id,factOwner:document,config:{mode:'mixed'},finalOutput:input=>{
  if(mismatch!=='native-bytes')return original({...input,...mismatch==='cell'?{cellId:'foreign-cell'}:{sourceId:'foreign-operation'}})
  const scope=service.registerResultScope({operationId:input.sourceId,sessionId:input.sessionId,callId:input.cellId,source:{sourceId:'original'}},()=>{input.assertHeld();return true})
  const adapter=captureOriginalCodeManifestAdapter(service,scope)
  return createCodeOutputManifest({version:1,kind:'code-output',sessionId:input.sessionId,cellId:input.cellId,sourceId:input.sourceId},{
   async open(){const sink=await service.beginResult(scope,'code-output-manifest-v1');await sink.write(Buffer.from('original native prefix outside the canonical manifest'));return sink},
   confirm:ref=>service.confirmResultOwner(scope,ref),nativeAdapter:()=>({adapter,sourceId:'original'})})
 }})
 let completion!:ReturnType<typeof captureOriginalCodeCompletion>
 const off=observeOriginalCodeFinalOutputs(mount,id=>{completion=captureOriginalCodeCompletion(mount,id)})
 try{
  await tools.get('code_exec')!.execute({code:'store("k",1)',yield_time_ms:60000},{session:document.view,sessionId:id})
  await expect(completion.settle()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
 }finally{
  off();const errors:{owner:string;cause:unknown}[]=[]
  for(const [owner,close] of [['mount',()=>mount.dispose()],['coordinator',()=>coordinator.close()],['service',()=>service.close()]] as const)try{await close()}catch(cause){errors.push({owner,cause})}
  expect(errors.map(error=>error.owner)).toEqual(['mount','coordinator'])
  expect(errors[0]!.cause).toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
  expect(errors[1]!.cause).toBeInstanceOf(AggregateError)
 }
},30000)
