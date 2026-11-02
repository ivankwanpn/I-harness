import { afterEach, expect, it, vi } from 'vitest'
const native=vi.hoisted(()=>({begins:0,writers:0,writes:0,reconciles:0,confirms:0,operationId:undefined as string|undefined,sink:undefined as object|undefined,
 afterBegin:undefined as (()=>void|Promise<void>)|undefined,afterWrite:undefined as (()=>void|Promise<void>)|undefined,afterFinish:undefined as (()=>void|Promise<void>)|undefined,afterConfirm:undefined as (()=>void|Promise<void>)|undefined}))
// Pass through the actual owners. Instrument before their constructor captures
// method identity; never decorate the returned service/scope/sink afterward.
vi.mock('../../context-output/src/artifact/writer.ts',async load=>{
 const real=await load<typeof import('../../context-output/src/artifact/writer.ts')>()
 return {...real,async createArtifactWriter(...args:Parameters<typeof real.createArtifactWriter>){
  const sink=await real.createArtifactWriter(...args)
  if(args[0].operation.codec==='code-output-manifest-v1'){
   native.writers++;native.operationId??=args[0].operation.owner.operationId;expect(args[0].operation.owner.operationId).toBe(native.operationId)
   native.sink??=sink;expect(sink).toBe(native.sink)
   const write=sink.write.bind(sink),reconcile=sink.reconcileWrite.bind(sink),finish=sink.finish.bind(sink)
   sink.write=async bytes=>{native.writes++;await write(bytes);await native.afterWrite?.()}
   sink.reconcileWrite=async()=>{native.reconciles++;return reconcile()}
   sink.finish=async value=>{const result=await finish(value);await native.afterFinish?.();return result}
  }
  return sink
 }}
})
vi.mock('../../context-output/src/artifact/ownership.ts',async load=>{
 const real=await load<typeof import('../../context-output/src/artifact/ownership.ts')>()
 return {...real,createArtifactOwnership(...args:Parameters<typeof real.createArtifactOwnership>){
  const owner=real.createArtifactOwnership(...args),begin=owner.beginResult.bind(owner),confirm=owner.confirmResultOwner.bind(owner)
  owner.beginResult=async(scope,codec)=>{if(codec==='code-output-manifest-v1')native.begins++;const sink=await begin(scope,codec);if(codec==='code-output-manifest-v1')await native.afterBegin?.();return sink}
  owner.confirmResultOwner=async(scope,ref)=>{await confirm(scope,ref);if(ref.codec==='code-output-manifest-v1'){native.confirms++;await native.afterConfirm?.()}}
  return owner
 }}
})
function resetNative(){Object.assign(native,{begins:0,writers:0,writes:0,reconciles:0,confirms:0,operationId:undefined,sink:undefined,afterBegin:undefined,afterWrite:undefined,afterFinish:undefined,afterConfirm:undefined})}
afterEach(()=>{resetNative();vi.restoreAllMocks()})
async function closeOwned(primary:{cause:unknown}|undefined,work:(()=>Promise<void>)[]){
 const errors:unknown[]=[]
 for(const close of work)try{await close()}catch(cause){errors.push(cause)}
 if(errors.length)throw new AggregateError([...(primary?[primary.cause]:[]),...errors],'Original connected fixture use/cleanup failed')
}
async function closeFixture(f:Awaited<ReturnType<typeof setup>>,mount:{dispose():Promise<void>}){await closeOwned(f.primary,[()=>mount.dispose(),async()=>{
 const outcomes=await Promise.allSettled(f.pending),failed=outcomes.filter((value):value is PromiseRejectedResult=>value.status==='rejected')
 if(failed.length)throw new AggregateError(failed.map(value=>value.reason),'Original fixture settlement failed')
},()=>f.coordinator.close(),()=>f.service.close()])}
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, instructionReplan } from '@i-harness/core-tools'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createCodeTextRetention } from '../../session-executor/src/lifecycle/code-text-retention.ts'
import { createCodeFinalOutputRetention } from '../../session-executor/src/lifecycle/code-final-output-retention.ts'
import { registerCodeMode, captureOriginalCodeCompletion } from '../src/register.ts'
import { captureOriginalCodeFinalOutput, observeOriginalCodeFinalOutputs } from '../src/final-output.ts'
import { observeOriginalCellFinalizations } from '../src/finalization.ts'
import { subscribe, createNondurableFactOwner, createSession, type ManagedArtifactRef } from '@i-harness/core-session'

async function setup() {
  resetNative()
  const base=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'code-final-')), sessionRoot=join(base,'sessions')
  await mkdir(sessionRoot)
  const coordinator=createJsonlTaskTransitionCoordinator(sessionRoot,{lock:{enabled:true}},taskDocumentStorageContract)
  const {id}=await coordinator.create(),document=await coordinator.openManagedDocument(id),ctx=createContext(),tools=createToolRegistry(ctx)
  let authorized=true,reads=0,cutoff=Infinity
  const service=createContextOutputService({root:join(base,'outputs'),workspaceId:'code-fixture',authorizeResult:async()=>authorized && ++reads<=cutoff})
  const sourceFor=async()=>({sourceId:'original-fixture-source'})
  const factory:import('../src/final-output.ts').CodeFinalOutputFactory=input=>createCodeFinalOutputRetention({service,sourceFor})(input)
  return {coordinator,id,document,ctx,tools,service,factory,sourceFor,primary:undefined as {cause:unknown}|undefined,pending:[] as Promise<unknown>[],revoke(){authorized=false},revokeDuringRead(){cutoff=reads+2}}
}
it.each(['original-service','copied-service'] as const)('keeps genuine nondurable Code and its consumed cursor intact with an inactive optional manifest factory: %s',async mode=>{
  const session=createSession(),owner=createNondurableFactOwner(session),ctx=createContext(),tools=createToolRegistry(ctx)
  const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'inactive-final-')),service=createContextOutputService({root,workspaceId:'inactive'})
  const sourceFor=vi.fn(async()=>({sourceId:'must-not-be-consulted'}))
  const factory=vi.fn(createCodeFinalOutputRetention({service:mode==='copied-service'?{...service}:service,sourceFor}))
  const body=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
  tools.register({name:'boundary',description:'',inputSchema:{},execute:async()=>{entered.resolve();await body.promise;return null}})
  const mount=registerCodeMode(ctx,tools,{session,sessionId:'nondurable',factOwner:owner,config:{mode:'mixed'},finalOutput:factory})
  const observed=vi.fn(),off=observeOriginalCodeFinalOutputs(mount,observed)
  let primary:{cause:unknown}|undefined
  try{
    const first=await tools.get('code_exec')!.execute({code:'text("ordinary first");await tools.boundary({});text("ordinary second");store("key",7)',yield_time_ms:1000},{session}) as {status:string;text?:string;cell_id:string}
    await entered.promise
    expect(first).toMatchObject({status:'running',text:'ordinary first'})
    expect(await tools.get('code_wait')!.execute({cell_id:first.cell_id,yield_time_ms:0},{session})).toMatchObject({status:'running',text:''})
    body.resolve()
    expect(await tools.get('code_wait')!.execute({cell_id:first.cell_id,yield_time_ms:1000},{session})).toMatchObject({status:'completed',text:'ordinary second'})
    await expect(tools.get('code_wait')!.execute({cell_id:first.cell_id,yield_time_ms:0},{session})).rejects.toThrow(/Cell unavailable/)
    expect(session.events.filter(event=>event.type==='code/output')).toHaveLength(2)
    expect(session.events.filter(event=>event.type==='code/store')).toHaveLength(1)
    expect(()=>captureOriginalCodeFinalOutput(mount,first.cell_id)).toThrow(/unavailable/)
    expect(()=>captureOriginalCodeFinalOutput({...mount},first.cell_id)).toThrow(/unavailable/)
    expect(observed).not.toHaveBeenCalled();expect(factory).not.toHaveBeenCalled();expect(sourceFor).not.toHaveBeenCalled();expect(native.begins).toBe(0)

  }catch(cause){primary={cause};throw cause}finally{body.resolve();off();await closeOwned(primary,[()=>mount.dispose(),()=>service.close()]);vi.restoreAllMocks()}
},10000)
it('binds the original immutable committed member despite a retention alias mutation in the genuine commit observer',async()=>{
  const f=await setup(),text=createCodeTextRetention({service:f.service,sourceFor:f.sourceFor})
  let alias:ManagedArtifactRef|undefined,canonical:ManagedArtifactRef|undefined,captures=0,observed=0,output!:ReturnType<typeof captureOriginalCodeFinalOutput>
  const mount=registerCodeMode(f.ctx,f.tools,{session:f.document.view,sessionId:f.id,factOwner:f.document,config:{mode:'mixed'},finalOutput:f.factory,
    retainText:async input=>{
      const result=await text(input)
      if(!result||result.kind!=='ready'||result.envelope.retention.kind!=='artifact'||input.index)return result
      captures++;alias={...result.envelope.retention.ref}
      return {...result,envelope:{...result.envelope,retention:{kind:'artifact',ref:alias}}}
    }})
  const off=observeOriginalCodeFinalOutputs(mount,(_id,handle)=>{output=handle})
  const offFact=subscribe(f.document.view,event=>{
    if(event.type!=='code/output'||event.envelope?.retention.kind!=='artifact')return
    observed++;canonical=event.envelope.retention.ref
    expect(Object.isFrozen(canonical)).toBe(true)
    if(!alias)throw new Error('Original alias must precede capture')
    alias.id='ctxv1_'+ 'f'.repeat(64)
  })
  try{
    expect(await f.tools.get('code_exec')!.execute({code:'text("canonical original")',yield_time_ms:60000},{session:f.document.view,sessionId:f.id})).toMatchObject({status:'completed'})
    const final=await output.settle()
    if(final.kind!=='ready')throw new Error('Expected original manifest')
    const page=await f.service.readCodeOutputResult!({sessionId:f.id},{ref:final.ref})
    const item=page.items[0]!.item
    if(item.kind!=='text'||item.retention.kind!=='artifact')throw new Error('Expected retained original member')
    expect(item.retention.ref).toEqual(canonical);expect(item.retention.ref.id).not.toBe(alias!.id)
    expect(captures).toBe(1);expect(observed).toBe(1)
    expect(f.document.view.events.filter(event=>event.type==='code/output')).toHaveLength(1)
    expect(f.document.view.events.filter(event=>event.type==='code/cell'&&event.state==='started')).toHaveLength(1)
  }catch(cause){f.primary={cause};throw cause}finally{offFact();off();await closeFixture(f,mount);vi.restoreAllMocks()}
},30000)
it('connects actual committed queue members through independent managed retention and all cell ACKs to an authorized immutable final page', async()=>{
  const f=await setup(),held=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
  let manifestConfirm=0,textCaptures=0,projectionCaptures=0,cellId=''
  native.afterConfirm=async()=>{manifestConfirm++;entered.resolve();await held.promise}
  const text=createCodeTextRetention({service:f.service,sourceFor:f.sourceFor})
  const mount=registerCodeMode(f.ctx,f.tools,{session:f.document.view,sessionId:f.id,factOwner:f.document,config:{mode:'mixed'},finalOutput:f.factory,
    retainText:input=>{if(input.index)projectionCaptures++;else textCaptures++;return text(input)}})
  const off=observeOriginalCellFinalizations(mount,id=>{cellId=id})
  let output!:ReturnType<typeof captureOriginalCodeFinalOutput>,earlyCapture=false
  const stopOutput=observeOriginalCodeFinalOutputs(mount,(_id,original)=>{output=original;earlyCapture=textCaptures===0})
  try {
    const result=await f.tools.get('code_exec')!.execute({code:'text("actual first"); store("key",7); audio({type:"audio",mimeType:"audio/wav",data:"YQ=="}); text("actual last")',yield_time_ms:60000},{session:f.document.view,sessionId:f.id})
    expect(result).toMatchObject({status:'completed',text:'actual first\nactual last'})
    expect(earlyCapture).toBe(true)
    // Early output capture belongs to the actual admitted mount/cell, no DTO.
    expect(captureOriginalCodeFinalOutput(mount,cellId)).toBe(output)
    await entered.promise
    let done=false;const pending=output.settle().then(value=>{done=true;return value})
    f.pending.push(pending);void pending.catch(()=>{})
    await Promise.resolve();expect(done).toBe(false)
    held.resolve();const final=await pending
    expect(final.kind).toBe('ready')
    if(final.kind!=='ready')throw new Error('Expected managed manifest')
    const page=await f.service.readCodeOutputResult!({sessionId:f.id},{ref:final.ref,maxBytes:32768})
    expect(page.items.map(item=>item.item.kind)).toEqual(['text','audio','text'])
    expect(page.footer).toMatchObject({count:3,accepted:3,omitted:0,truncated:false,status:'completed'})
    expect(page.footer.store).not.toBeNull();expect(page.eof).toBe(true)
    expect(page.items[1]!.item).toEqual({kind:'audio',read:'current-fact-required'})
    expect(JSON.stringify(page)).not.toContain('actual first');expect(JSON.stringify(page)).not.toContain('YQ==')
    expect(textCaptures).toBe(2);expect(projectionCaptures).toBe(1);expect(manifestConfirm).toBe(1)
    expect(Object.isFrozen(final.ref)).toBe(true)
    expect(await output.settle()).toEqual(final)
    expect(()=>captureOriginalCodeFinalOutput({...mount},cellId)).toThrow()
    await expect(f.service.readCodeOutputResult!({sessionId:f.id},{ref:final.ref,cursor:{artifactId:final.ref.id,revision:final.ref.revision,cellId,sourceId:page.header.sourceId,offset:1}})).rejects.toThrow()
    await f.service.grant({sessionId:f.id},[final.ref.id],'recipient')
    expect((await f.service.readCodeOutputResult!({sessionId:'recipient'},{ref:final.ref})).items).toHaveLength(3)
    const child=page.items[0]!.item
    if(child.kind!=='text'||child.retention.kind!=='artifact')throw new Error('Expected actual original text ref')
    await expect(f.service.readResult({sessionId:'recipient'},{ref:child.retention.ref})).rejects.toThrow(/unauthorized|unavailable/)
    f.revoke();await expect(f.service.readCodeOutputResult!({sessionId:f.id},{ref:final.ref})).rejects.toThrow(/unauthorized|unavailable/)
  }catch(cause){f.primary={cause};throw cause}finally{held.resolve();off();stopOutput();await closeFixture(f,mount);vi.restoreAllMocks()}
},30000)

it('waits for each actual original output store and terminal capture ACK without async callback replay',async()=>{
  const f=await setup(),outputGate=Promise.withResolvers<void>(),storeGate=Promise.withResolvers<void>(),terminalGate=Promise.withResolvers<void>(),outputEntered=Promise.withResolvers<void>(),storeEntered=Promise.withResolvers<void>(),terminalEntered=Promise.withResolvers<void>()
  const begin=f.document.beginAction.bind(f.document)
  let manifestOpened=0,outputCalls=0,storeCalls=0,terminalCalls=0,output!:ReturnType<typeof captureOriginalCodeFinalOutput>
  native.afterBegin=()=>{manifestOpened++}
  vi.spyOn(f.document,'beginAction').mockImplementation((...args)=>{
    const action=begin(...args),register=action.registerSettlementSource.bind(action),store=action.captureCodeStore.bind(action)
    vi.spyOn(action,'captureCodeStore').mockImplementation(event=>{const fact=store(event),admit=fact.admit.bind(fact);vi.spyOn(fact,'admit').mockImplementation(async()=>{storeCalls++;storeEntered.resolve();await storeGate.promise;return admit()});return fact})
    vi.spyOn(action,'registerSettlementSource').mockImplementation((...input)=>{
      const source=register(...input),capture=source.code.capture.bind(source.code)
      vi.spyOn(source.code,'capture').mockImplementation(event=>{
        const fact=capture(event),admit=fact.admit.bind(fact)
        if(event.type==='code/output')vi.spyOn(fact,'admit').mockImplementation(async()=>{outputCalls++;outputEntered.resolve();await outputGate.promise;return admit()})
        if(event.type==='code/cell'&&event.state==='completed')vi.spyOn(fact,'admit').mockImplementation(async()=>{terminalCalls++;terminalEntered.resolve();await terminalGate.promise;return admit()})
        return fact
      })
      return source
    })
    return action
  })
  const text=createCodeTextRetention({service:f.service,sourceFor:f.sourceFor})
  const mount=registerCodeMode(f.ctx,f.tools,{session:f.document.view,sessionId:f.id,factOwner:f.document,config:{mode:'mixed'},finalOutput:f.factory,retainText:text})
  const off=observeOriginalCodeFinalOutputs(mount,(_id,handle)=>{output=handle})
  try{
    const first=await f.tools.get('code_exec')!.execute({code:'text("original");store("key",7)',yield_time_ms:0},{session:f.document.view,sessionId:f.id}) as {cell_id:string}
    await outputEntered.promise
    let ready=false;const pending=output.settle().then(value=>{ready=true;return value})
    f.pending.push(pending);void pending.catch(()=>{})
    await Promise.resolve();expect(ready).toBe(false);expect(manifestOpened).toBe(0)
    outputGate.resolve();await storeEntered.promise
    expect(ready).toBe(false);expect(manifestOpened).toBe(1)
    storeGate.resolve();await terminalEntered.promise
    expect(ready).toBe(false)
    terminalGate.resolve();const final=await pending
    expect(final.kind).toBe('ready');if(final.kind!=='ready')throw new Error('Expected acknowledged manifest')
    const page=await f.service.readCodeOutputResult!({sessionId:f.id},{ref:final.ref})
    expect(page.footer.count).toBe(1);expect(page.footer.store?.seq).toBe(f.document.view.events.find(e=>e.type==='code/store')!.seq)
    expect([outputCalls,storeCalls,terminalCalls]).toEqual([1,1,1])
    expect(await f.tools.get('code_wait')!.execute({cell_id:first.cell_id,yield_time_ms:60000},{session:f.document.view,sessionId:f.id})).toMatchObject({status:'completed',text:'original'})
  }catch(cause){f.primary={cause};throw cause}finally{outputGate.resolve();storeGate.resolve();terminalGate.resolve();off();await closeFixture(f,mount);vi.restoreAllMocks()}
},30000)

it('keeps final output unavailable while the actual original nested broker producer and native manifest finish are held',async()=>{
  const f=await setup(),body=Promise.withResolvers<unknown>(),bodyEntered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>(),finishEntered=Promise.withResolvers<void>()
  f.tools.register({name:'late',description:'',inputSchema:{},isConcurrencySafe:true,execute:async()=>{bodyEntered.resolve();return body.promise}})
  f.tools.register({name:'started',description:'',inputSchema:{},isConcurrencySafe:true,execute:async()=>{await bodyEntered.promise;return null}})
  native.afterFinish=async()=>{finishEntered.resolve();await finish.promise}
  const mount=registerCodeMode(f.ctx,f.tools,{session:f.document.view,sessionId:f.id,factOwner:f.document,config:{mode:'mixed'},finalOutput:f.factory})
  let output!:ReturnType<typeof captureOriginalCodeFinalOutput>,completion!:ReturnType<typeof captureOriginalCodeCompletion>
  const off=observeOriginalCodeFinalOutputs(mount,(id,handle)=>{output=handle;completion=captureOriginalCodeCompletion(mount,id)})
  try{
    expect(await f.tools.get('code_exec')!.execute({code:'tools.late({});await tools.started({});audio({type:"audio",mimeType:"audio/wav",data:"YQ=="});',yield_time_ms:60000},{session:f.document.view,sessionId:f.id})).toMatchObject({status:'completed'})
    await bodyEntered.promise
    let ready=false,finishing=false,completed=false;void finishEntered.promise.then(()=>{finishing=true})
    const pending=output.settle().then(value=>{ready=true;return value})
    const proof=completion.settle().then(value=>{completed=true;return value});void proof.catch(()=>{})
    f.pending.push(proof)
    f.pending.push(pending);void pending.catch(()=>{})
    await Promise.resolve();await Promise.resolve();expect(ready).toBe(false);expect(finishing).toBe(false);expect(completed).toBe(false)
    body.resolve('late original broker reply');await finishEntered.promise
    expect(ready).toBe(false);expect(completed).toBe(false)
    finish.resolve();expect((await pending).kind).toBe('ready');expect((await proof).kind).toBe('qualified')
    expect(f.document.view.events.filter(e=>e.type==='code/call')).toHaveLength(2)
    expect(f.document.view.events.filter(e=>e.type==='code/result')).toHaveLength(2)
  }catch(cause){f.primary={cause};throw cause}finally{body.resolve(null);finish.resolve();off();await closeFixture(f,mount);vi.restoreAllMocks()}
},30000)

it('reports unsupported copied/custom retention service before creating an artifact operation',async()=>{
  const f=await setup(),lookup=vi.fn(f.sourceFor)
  const unsupported=createCodeFinalOutputRetention({service:{...f.service},sourceFor:lookup})
  const mount=registerCodeMode(f.ctx,f.tools,{session:f.document.view,sessionId:f.id,factOwner:f.document,config:{mode:'mixed'},finalOutput:unsupported})
  let output!:ReturnType<typeof captureOriginalCodeFinalOutput>
  const off=observeOriginalCodeFinalOutputs(mount,(_id,handle)=>{output=handle})
  try{
    expect(await f.tools.get('code_exec')!.execute({code:'',yield_time_ms:60000},{session:f.document.view,sessionId:f.id})).toMatchObject({status:'completed'})
    expect(await output.settle()).toEqual({kind:'unavailable',reason:'unsupported-owner'})
    expect(native.begins).toBe(0);expect(lookup).not.toHaveBeenCalled()
  }catch(cause){f.primary={cause};throw cause}finally{off();await closeFixture(f,mount);vi.restoreAllMocks()}
},30000)

it.each(['stop','replan','policy'] as const)('retains the original %s disposition without upgrading it to ordinary completed output',async mode=>{
  const f=await setup(),entered=Promise.withResolvers<void>(),body=Promise.withResolvers<unknown>()
  let output!:ReturnType<typeof captureOriginalCodeFinalOutput>,cellId=''
  f.tools.register({name:'boundary',description:'',inputSchema:{},execute:async(_args,exec)=>{
    entered.resolve()
    if(mode==='replan')throw instructionReplan({code:'INSTRUCTIONS_REPLAN_REQUIRED',reason:'unseen-rules',currentFingerprint:'original'})
    if(mode==='policy')throw Object.assign(new Error('original policy refusal'),{policyRefusal:true})
    exec.abortSignal?.addEventListener('abort',()=>body.resolve(null),{once:true})
    return body.promise
  }})
  const mount=registerCodeMode(f.ctx,f.tools,{session:f.document.view,sessionId:f.id,factOwner:f.document,config:{mode:'mixed'},finalOutput:f.factory})
  const off=observeOriginalCodeFinalOutputs(mount,(id,original)=>{output=original;cellId=id})
  try{
    await f.tools.get('code_exec')!.execute({code:'audio({type:"audio",mimeType:"audio/wav",data:"YQ=="});await tools.boundary({});',yield_time_ms:0},{session:f.document.view,sessionId:f.id})
    await entered.promise
    if(mode==='stop')await mount.terminateCell!(cellId)
    const stored=await output.settle();expect(stored.kind).toBe('ready');if(stored.kind!=='ready')throw new Error('Expected historical stopped descriptor stream')
    const page=await f.service.readCodeOutputResult!({sessionId:f.id},{ref:stored.ref})
    expect(page.footer.status).toBe(mode==='stop'?'terminated':mode==='replan'?'replanned':'policy-refused')
    expect(stored.ref.completeness).toBe('capture-canceled')
  }catch(cause){f.primary={cause};throw cause}finally{body.resolve(null);off();await closeFixture(f,mount)}
},30000)

it('seals real empty output and rechecks authorization after awaited managed range IO',async()=>{
  const f=await setup(),mount=registerCodeMode(f.ctx,f.tools,{session:f.document.view,sessionId:f.id,factOwner:f.document,config:{mode:'mixed'},finalOutput:f.factory})
  let output!:ReturnType<typeof captureOriginalCodeFinalOutput>
  const off=observeOriginalCodeFinalOutputs(mount,(_id,handle)=>{output=handle})
  try{
    expect(await f.tools.get('code_exec')!.execute({code:'',yield_time_ms:60000},{session:f.document.view,sessionId:f.id})).toMatchObject({status:'completed'})
    const stored=await output.settle();expect(stored.kind).toBe('ready');if(stored.kind!=='ready')throw new Error('Expected empty manifest')
    expect(await f.service.readCodeOutputResult!({sessionId:f.id},{ref:stored.ref})).toMatchObject({items:[],eof:true,footer:{count:0,accepted:0,omitted:0,store:null}})
    f.revokeDuringRead()
    await expect(f.service.readCodeOutputResult!({sessionId:f.id},{ref:stored.ref})).rejects.toThrow(/unauthorized|unavailable/)
    expect(await output.settle()).toEqual(stored) // Historical identity is immutable.
  }catch(cause){f.primary={cause};throw cause}finally{off();await closeFixture(f,mount)}
},30000)

it('streams more than256 small committed media descriptors across consumed windows without lifetime bodies or observer cursor movement',async()=>{
  const f=await setup(),gates=Array.from({length:3},()=>Promise.withResolvers<void>()),entered=Array.from({length:3},()=>Promise.withResolvers<void>()),appended=Array.from({length:3},()=>Promise.withResolvers<void>())
  let count=0,calls=0,output!:ReturnType<typeof captureOriginalCodeFinalOutput>
  f.tools.register({name:'window',description:'',inputSchema:{},execute:async args=>{const index=(args as {index:number}).index;calls++;entered[index]!.resolve();await gates[index]!.promise;return null}})
  const mount=registerCodeMode(f.ctx,f.tools,{session:f.document.view,sessionId:f.id,factOwner:f.document,config:{mode:'mixed'},finalOutput:input=>{
    const original=f.factory(input)
    return {...original,async append(record,descriptor){await original.append(record,descriptor);count++;if(count%90===0)appended[count/90-1]!.resolve()}}
  }})
  const off=observeOriginalCodeFinalOutputs(mount,(_id,handle)=>{output=handle})
  try{
    const first=await f.tools.get('code_exec')!.execute({code:'for(let batch=0;batch<3;batch++){for(let i=0;i<90;i++)audio({type:"audio",mimeType:"audio/wav",data:"YQ=="});await tools.window({index:batch});}',yield_time_ms:0},{session:f.document.view,sessionId:f.id}) as {cell_id:string}
    for(let i=0;i<3;i++){
      await entered[i]!.promise;await appended[i]!.promise
      expect(await f.tools.get('code_wait')!.execute({cell_id:first.cell_id,yield_time_ms:0,max_tokens:1},{session:f.document.view,sessionId:f.id})).toMatchObject({status:'running'})
      gates[i]!.resolve()
    }
    const final=await output.settle()
    expect(final.kind).toBe('ready');if(final.kind!=='ready')throw new Error('Expected original manifest')
    let cursor:import('@i-harness/core-session').CodeOutputCursor|undefined,ordinal=0,pages=0
    do{
      const page=await f.service.readCodeOutputResult!({sessionId:f.id},{ref:final.ref,cursor,maxBytes:32768})
      for(const descriptor of page.items){expect(descriptor.ordinal).toBe(ordinal++);expect(descriptor.item).toEqual({kind:'audio',read:'current-fact-required'})}
      expect(page.footer).toMatchObject({count:270,accepted:270,omitted:0,truncated:false})
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768)
      cursor=page.nextCursor??undefined;pages++
    }while(cursor)
    expect(ordinal).toBe(270);expect(pages).toBeGreaterThan(1);expect(calls).toBe(3)
    expect(await output.settle()).toEqual(final)
    // Manifest reads/settlement did not consume the original observation.
    expect(await f.tools.get('code_wait')!.execute({cell_id:first.cell_id,yield_time_ms:60000},{session:f.document.view,sessionId:f.id})).toMatchObject({status:'completed'})
  }catch(cause){f.primary={cause};throw cause}finally{for(const gate of gates)gate.resolve();off();await closeFixture(f,mount)}
},60000)

it.each(['initialization','header-write','descriptor-write','finish','confirmation'] as const)('reconciles the same original managed manifest after lost %s reply without guest/fact/text replay',async mode=>{
  const f=await setup(),injected=Promise.withResolvers<void>()
  let lost=false,textCaptures=0,output!:ReturnType<typeof captureOriginalCodeFinalOutput>
  const lose=()=>{lost=true;injected.resolve();throw false}
  native.afterBegin=()=>{if(!lost&&mode==='initialization')lose()}
  native.afterWrite=()=>{if(!lost&&(mode==='header-write'&&native.writes===1||mode==='descriptor-write'&&native.writes===2))lose()}
  native.afterFinish=()=>{if(!lost&&mode==='finish')lose()}
  native.afterConfirm=()=>{if(!lost&&mode==='confirmation')lose()}
  const text=createCodeTextRetention({service:f.service,sourceFor:f.sourceFor})
  const mount=registerCodeMode(f.ctx,f.tools,{session:f.document.view,sessionId:f.id,factOwner:f.document,config:{mode:'mixed'},finalOutput:f.factory,retainText:input=>{if(!input.index)textCaptures++;return text(input)}})
  const off=observeOriginalCodeFinalOutputs(mount,(_id,original)=>{output=original})
  try{
    await f.tools.get('code_exec')!.execute({code:'text("one original")',yield_time_ms:0},{session:f.document.view,sessionId:f.id})
    await injected.promise
    // An explicit owner settle drives only the original resumable queue/frontier.
    let result:Awaited<ReturnType<typeof output.settle>>|undefined
    for(let attempt=0;attempt<3&&!result;attempt++){try{result=await output.settle()}catch(error){expect((error as {code?:string}).code).toBe('FACT_RECOVERY_REQUIRED')}}
    expect(result?.kind).toBe('ready');if(result?.kind!=='ready')throw new Error('Expected reconciled original')
    const page=await f.service.readCodeOutputResult!({sessionId:f.id},{ref:result.ref})
    expect(page.footer.count).toBe(1);expect(page.items[0]!.ordinal).toBe(0)
    expect(textCaptures).toBe(1);expect(f.document.view.events.filter(e=>e.type==='code/output')).toHaveLength(1)
    expect(native.writes).toBe(3);expect(native.writers).toBe(1);expect(native.operationId).toBeDefined();expect(native.sink).toBeDefined()
    if(mode.endsWith('write'))expect(native.reconciles).toBe(1)
  }catch(cause){f.primary={cause};throw cause}finally{off();await closeFixture(f,mount);vi.restoreAllMocks()}
},30000)
