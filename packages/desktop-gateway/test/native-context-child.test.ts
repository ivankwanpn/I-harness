import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import {expect,it,vi} from 'vitest'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService,createDurableSessionLoader,type SessionAssembly,type SessionServiceOptions} from '@i-harness/session-executor'
import {createCodeRetrievalTools} from '@i-harness/code-retrieval'
import {createNativeContextRuntime} from '../src/context-runtime.ts'
import {createProjectScopeBroker} from '../src/project-scope.ts'
import type {LLMRequest,ModelClient} from '../../llm-seam/src/index.ts'
import {recordFixture} from './managed-fixture.ts'
import {committedFactSeqs,decodeFactBatch,managedResultRefs,semanticSeedResultRefs,type SessionView} from '@i-harness/core-session'

/** Production Gateway composition: the Task-transition coordinator owns child
 * bootstrap, the project broker owns native inheritance, and the service's task
 * child host is the runtime's real one. */
async function createChildOwners(coordinator:import('@i-harness/session-persistence').SessionCoordinator,root:string){
  const projects=createProjectScopeBroker(coordinator,root)
  let service:ReturnType<typeof createSessionService>|undefined
  const runtime=await createNativeContextRuntime({workspace:root,storageRoot:join(root,'native'),coordinator,
    projectFor:projects.nativeScopeFor,resultReadScopeFor:projects.resultReadScopeFor,
    prepareTaskChildInheritance:projects.prepareTaskChildInheritance,withBindingObservation:projects.withBindingObservation,
    retainSelectedProjectRead:projects.retainSelectedBindingRead,
    visibleRefsFor:async id=>{const view=(service?.liveSession(id)??(await coordinator.snapshot!(id)).session) as SessionView;return [...semanticSeedResultRefs(view),...view.events.flatMap(managedResultRefs),...view.events.flatMap(event=>event.type==='context/result-ref'?[event.ref]:[])]}})
  return {projects,runtime,serviceFor(options:Omit<SessionServiceOptions,'workspace'|'coordinator'|'prepareTaskChild'|'sessionFor'>){
    service=createSessionService({...options,workspace:root,coordinator,prepareTaskChild:runtime.prepareTaskChild,sessionFor:createDurableSessionLoader(coordinator)})
    return service
  }}
}
async function createChildFixture(root:string){
  const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}},taskDocumentStorageContract)
  return {coordinator,...await createChildOwners(coordinator,root)}
}

/** Retain real managed result bytes as the parent's trusted seed membership. */
async function recordManagedSeed(runtime:Awaited<ReturnType<typeof createNativeContextRuntime>>,assembly:SessionAssembly,text:string,label:string){
  const sessionId=assembly.sessionId!
  const source=await runtime.sourceFor(sessionId)
  const scope=runtime.contextOutput.registerResultScope({operationId:'seed-'+label,sessionId,callId:'seed-'+label,source},()=>true)
  const sink=await runtime.contextOutput.beginResult(scope,'text-utf8-v1');await sink.write(Buffer.from(text))
  const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Fixture result unavailable')
  return saved.ref
}
async function recordSeedTurn(assembly:SessionAssembly,ref:import('@i-harness/core-session').ManagedArtifactRef,text:string){
  await recordFixture(assembly.factOwner,{type:'turn/start'})
  await recordFixture(assembly.factOwner,{type:'user/message',text})
  await recordFixture(assembly.factOwner,{type:'tool/call',callId:'seed-read',name:'read',args:{}})
  await recordFixture(assembly.factOwner,{type:'tool/result',callId:'seed-read',name:'read',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'managed',media:[],retention:{kind:'artifact',ref}}})
  await recordFixture(assembly.factOwner,{type:'turn/end'})
}

/** Submit the Task through its original prepared leaf with a real settlement
 * source and committed call identity. A bare `tools.prepare(...sessionId)` has
 * no owned Task action, so the shipping leaf correctly refuses it. */
async function prepareOwnedSpawn(assembly:SessionAssembly,args:Record<string,unknown>,callId:string){
  const action=assembly.factOwner.beginAction()
  try{
    const [seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId,name:'spawn_agent',args}))
    if(seq===undefined)throw new Error('Original spawn call fact did not commit')
    committedFactSeqs(await action.facts.tools.dispatch(callId,{kind:'prior',seq,expectedType:'tool/call'}))
    const source=action.registerSettlementSource(async()=>{})
    const prepared=await assembly.tools.prepare({name:'spawn_agent',args},action.signal,{session:assembly.session,sessionId:assembly.sessionId,callId,callEventSeq:seq,settlementSource:source})
    return {prepared,async close(){try{await source.close()}catch{}action.finish()}}
  }catch(error){action.finish();throw error}
}

// Composed Task-transition coordinator + project broker + real child model turns:
// measured 16-24s per case on this host, so each case keeps headroom beyond the
// old 15s budget for a loaded full-suite run.
it('live enabling lets a real explore child capture and search native refs through its role-limited broker',async()=>{
  const base=resolve('build/native-child-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'child-'))
  const f=await createChildFixture(root),{coordinator,runtime}=f;await coordinator.create({sessionId:'parent'})
  await f.projects.configure({id:'native-child',name:'Native child',roots:[root],primaryRoot:root});await f.projects.bind('parent','native-child')
  let calls=0;const requests:LLMRequest[]=[]
  const model:ModelClient=controlledModel(request => ({async *stream(request){requests.push(request);calls++
    // The marker leads the retained body: managed search reads a bounded prefix
    // of each artifact, so a marker after the padding could not be found.
    if(calls===1)yield{type:'tool_call',call:{name:'code_exec',args:{code:'text(ALL_TOOLS.map(t=>t.name));text("CHILD_RETAINED"+"a".repeat(20000)+"b".repeat(20000));',max_output_tokens:16}}}
    else if(calls===2)yield{type:'tool_call',call:{name:'code_exec',args:{code:'const found=await tools.context_output_search({query:"CHILD_RETAINED"});text(JSON.stringify(found.hits.map(hit=>({id:hit.ref.id,offset:hit.offset}))));text(await tools.context_output_read({refId:found.hits[0].ref.id,offset:found.hits[0].offset,maxBytes:1024}));'}}}
    else yield{type:'text/chunk',text:'Child finished.'}
    yield{type:'end'}
  }} as import('@i-harness/llm-seam').ModelClient).stream(request))
  const service=f.serviceFor({model,sandbox:'danger-full-access',approveAll:true,codeMode:{mode:'only'},contextOutput:runtime.contextOutput,contextOutputSourceFor:runtime.sourceFor,additionalTools:createCodeRetrievalTools(runtime.codeRetrieval)})
  try {
    const assembly=await service.assemblyFor('parent')
    await runtime.contextOutput.configure({enabled:true})
    const owned=await prepareOwnedSpawn(assembly,{message:'Inspect native text',task_name:'native',agent_type:'explore',fork_turns:'none',background:false},'spawn')
    let result:unknown
    try{result=await assembly.tools.dispatch(owned.prepared)}finally{await owned.close()}
    expect(JSON.stringify(result)).toContain('Child finished.')
    expect(requests).toHaveLength(3)
    const profiles=await Promise.all((await coordinator.list()).map(id=>coordinator.profile(id)));const child=profiles.find(profile=>profile.meta.parentSession==='parent')!.meta
    expect(child).toBeDefined()
    const childSession=(await coordinator.snapshot!(child.sessionId)).session
    const catalog=JSON.stringify(childSession.events.find(event=>event.type==='code/output'))
    expect(catalog).toContain('context_output_read');expect(catalog).not.toContain('code_context_index')
    // A3 cutover: emitted Code Mode text is a managed artifact in the child's own
    // scope, never a legacy context/result-ref or a parent grant.
    const emitted=childSession.events.flatMap(event=>event.type==='code/output'&&event.envelope?.retention.kind==='artifact'?[event.envelope.retention.ref]:[])
    expect(emitted.length).toBeGreaterThanOrEqual(2)
    const captured=childSession.events.flatMap(managedResultRefs)
    const search=childSession.events.find(event=>event.type==='code/result'&&event.name==='context_output_search')
    if(search?.type!=='code/result'||search.envelope?.retention.kind!=='inline')throw Error('Child search result unavailable')
    const hits=(search.envelope.retention.value as {hits:{ref:{id:string};offset:number}[]}).hits
    expect(hits).toHaveLength(1)
    const hit=hits[0]!
    expect(emitted.map(ref=>ref.id)).toContain(hit.ref.id)
    expect(captured.map(ref=>ref.id)).toContain(hit.ref.id)
    expect(JSON.stringify(childSession.events.filter(event=>event.type==='code/result'&&event.name==='context_output_read'))).toContain('CHILD_RETAINED')
    // The child's captured result is its own authority; the parent may not read
    // the child's private artifact without an explicit retained transfer.
    const artifact=emitted.find(ref=>ref.id===hit.ref.id)!
    await expect(runtime.contextOutput.readResult({sessionId:'parent'},{ref:artifact})).rejects.toThrow()
    // Clearing the parent's own scope releases nothing the child captured.
    await runtime.contextOutput.clear('parent')
    expect((await runtime.contextOutput.search({sessionId:child.sessionId},{query:'CHILD_RETAINED'})).hits.map(value=>value.ref.id)).toContain(hit.ref.id)
  } finally {await service.close();await runtime.close();await f.projects.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
},60000)

it.each(['release','reject'] as const)('persists the trusted fork seed before entering the child model (%s)',async outcome=>{
  const base=resolve('build/native-child-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'barrier-'))
  // Fault injection goes through the constructor seam: the canonical-path guard
  // snapshots backend descriptors at construction, so a later assignment would
  // be rejected as PROCESS_READ_UNAVAILABLE before the held write is reached.
  let injectedAppend:((...args:any[])=>Promise<unknown>)|undefined
  const backend=createJsonlBackend(join(root,'sessions'),{wrapOwnedBatch:append=>async(...args:any[])=>{
    const replaced=injectedAppend?await injectedAppend(...args):undefined
    return (replaced??await (append as (...values:any[])=>Promise<unknown>)(...args)) as never
  }}),coordinator=composeJsonlTaskTransitionCoordinator(backend,{maxDelayMs:60000,lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'parent'})
  const owners=await createChildOwners(coordinator,root),runtime=owners.runtime
  await owners.projects.configure({id:'native-child',name:'Native child',roots:[root],primaryRoot:root});await owners.projects.bind('parent','native-child')
  let transports=0,childId=''
  const model:ModelClient=controlledModel(request => ({async *stream(){transports++;yield{type:'text/chunk',text:'child complete'};yield{type:'end'}}} as import('@i-harness/llm-seam').ModelClient).stream(request))
  const service=owners.serviceFor({model,sandbox:'danger-full-access',approveAll:true,contextOutput:runtime.contextOutput,contextOutputSourceFor:runtime.sourceFor})
  const dependency=vi.spyOn(runtime.contextOutput,'confirmSeedDependencies')
  let release!:()=>void,entered!:()=>void
  const held=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
  let owned:{prepared:import('@i-harness/core-tools').PreparedCall;close():Promise<void>}|undefined
  try{
    await runtime.contextOutput.configure({enabled:true})
    const assembly=await service.assemblyFor('parent')
    const ref=await recordManagedSeed(runtime,assembly,'TRUSTED_SEED','barrier')
    await recordSeedTurn(assembly,ref,'seed')
    await coordinator.flush('parent')
    injectedAppend=async(...args)=>{
      // Hold only the child's managed seed frame, whose manifest names the
      // trusted parent artifact this Task inherits.
      const events=decodeFactBatch(args[3].bytes).events
      if(String(args[0]).startsWith('child-')&&events.some(event=>event.type==='conversation/seed-manifest')){
        childId=args[0];entered();await held
        if(outcome==='reject')return{kind:'not-issued',code:'FACT_RECOVERY_REQUIRED'}
      }
      return undefined
    }
    owned=await prepareOwnedSpawn(assembly,{message:'Use trusted seed',task_name:'barrier',agent_type:'explore',fork_turns:'all',background:false},'spawn')
    const spawned=assembly.tools.dispatch(owned.prepared)
    await Promise.race([started,spawned.then(()=>{throw new Error('spawn completed before seed barrier')})])
    await new Promise<void>(resolve=>setImmediate(resolve))
    // The seed closure is validated before the child's seed bytes are issued, so
    // the confirmation exists but no child model, seed event or readable child
    // view exists while that exact write is held.
    expect(dependency).toHaveBeenCalledTimes(1)
    expect(transports).toBe(0)
    await expect(coordinator.openManagedDocument(childId)).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
    await expect(coordinator.snapshot!(childId)).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
    release()
    if(outcome==='reject'){
      await expect(spawned).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
      // The refused native write is resumed once, which re-validates the same
      // closure before the refusal is final; no child model ever enters.
      expect(transports).toBe(0);expect(dependency).toHaveBeenCalled()
    }else{
      const result=await spawned
      expect(JSON.stringify(result)).toContain('child complete')
      expect(transports).toBe(1);expect(dependency).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(await coordinator.snapshot!(childId))).toContain(ref.id)
    }
  }finally{release();injectedAppend=undefined;await owned?.close();dependency.mockRestore();await service.close();await runtime.close();await owners.projects.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
},60000)

it.each([false,true])('a real child owns its inherited native references before its first model request (disabled=%s)',async disabled=>{
  const base=resolve('build/native-child-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'seed-'))
  const f=await createChildFixture(root),{coordinator,runtime}=f;await coordinator.create({sessionId:'parent'})
  await f.projects.configure({id:'native-child',name:'Native child',roots:[root],primaryRoot:root});await f.projects.bind('parent','native-child')
  let calls=0,seedRef:import('@i-harness/core-session').ManagedArtifactRef|undefined
  const model:ModelClient=controlledModel(request => ({async *stream(){calls++
    // A managed dependency is read by its complete immutable ref; a bare
    // refId names only legacy Context Mode output and cannot resolve the
    // child's inherited artifact.
    if(calls===1){await runtime.contextOutput.configure({enabled:true});yield{type:'tool_call',call:{name:'context_output_read',args:{ref:seedRef}}}}
    else yield{type:'text/chunk',text:'Seed read completed.'}
    yield{type:'end'}
  }} as import('@i-harness/llm-seam').ModelClient).stream(request))
  const service=f.serviceFor({model,sandbox:'danger-full-access',approveAll:true,contextOutput:runtime.contextOutput,contextOutputSourceFor:runtime.sourceFor,additionalTools:createCodeRetrievalTools(runtime.codeRetrieval)})
  try{
    await runtime.contextOutput.configure({enabled:true})
    const assembly=await service.assemblyFor('parent')
    const ref=await recordManagedSeed(runtime,assembly,'INHERITED_NATIVE','inherited');seedRef=ref
    await recordSeedTurn(assembly,ref,'seed')
    await coordinator.flush('parent')
    if(disabled)await runtime.contextOutput.configure({enabled:false})
    const owned=await prepareOwnedSpawn(assembly,{message:'Read inherited ref',task_name:'seed',agent_type:'explore',fork_turns:'all',background:false},'spawn')
    try{await assembly.tools.dispatch(owned.prepared)}finally{await owned.close()}
    const child=(await Promise.all((await coordinator.list()).map(id=>coordinator.profile(id)))).find(profile=>profile.meta.parentSession==='parent')!.meta
    const log=(await coordinator.snapshot!(child.sessionId)).session
    expect(log.events.find(event=>event.type==='conversation/seed-manifest')).toMatchObject({artifacts:[expect.objectContaining({ref:expect.objectContaining({id:ref.id})})]})
    expect(log.events.find(event=>event.type==='tool/result'&&event.name==='context_output_read')).toMatchObject({envelope:{retention:{kind:'inline',value:{data:{kind:'text',text:'INHERITED_NATIVE'}}}}})
  }finally{await service.close();await runtime.close();await f.projects.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
},60000)
