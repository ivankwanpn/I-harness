import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {recordFixture} from './managed-fixture.ts'
import {it,expect,vi} from 'vitest'
const io=vi.hoisted(()=>({writes:0,readPath:'',entered:undefined as undefined|(()=>void),gate:undefined as Promise<void>|undefined}))
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,async writeFile(...args:Parameters<typeof fs.writeFile>){io.writes++;return fs.writeFile(...args)},async rename(...args:Parameters<typeof fs.rename>){io.writes++;return fs.rename(...args)},async readFile(...args:Parameters<typeof fs.readFile>){const value=await fs.readFile(...args);if(String(args[0])===io.readPath){io.entered?.();await io.gate}return value}}})
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistry} from '@i-harness/core-tools'
import {committedFactSeqs,semanticSeedResultRefs,managedResultRefs} from '@i-harness/core-session'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createProjectScopeBroker} from '../src/project-scope.ts'
import {createNativeContextRuntime} from '../src/context-runtime.ts'
import {registerSubagent,SHIPPING_REPORT_POLICY} from '@i-harness/subagent'
import {registerExec} from '@i-harness/exec'
import {createMockClient} from '../../llm-mock/src/index.ts'
import {createGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {createHash} from 'node:crypto'
import {captureChildBootstrapCaptureRequest,createChildBootstrapRequestIntent} from '@i-harness/session-persistence'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {receivedInputsFor} from '../../session-executor/src/lifecycle/received-inputs.ts'

it.each(['none','all','managed','copied-preparation','bad-closure','unrelated','close-held','close-fail','unmanaged-ref'] as const)('bounded functional Gateway Task managed transfer: %s',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-task-')),workspace=join(root,'workspace');await mkdir(workspace)
 const coordinator=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract)
 const broker=createProjectScopeBroker(coordinator,workspace)
 let runtime:Awaited<ReturnType<typeof createNativeContextRuntime>>|undefined,mounted:ReturnType<typeof registerSubagent>|undefined,action:ReturnType<Awaited<ReturnType<typeof coordinator.openManagedDocument>>['beginAction']>|undefined,cold:typeof coordinator|undefined
 let server:Awaited<ReturnType<typeof createLoopbackProvider>>|undefined
 let dispatch:Promise<unknown>|undefined,dispatchDone:Promise<void>|undefined,inspectDone:Promise<void>|undefined,releaseInspect:(()=>void)|undefined
 let failed=false,primary:unknown
 const closeGate=Promise.withResolvers<void>(),closeEntered=Promise.withResolvers<void>();let closeAttempts=0
 try{
  if(mode!=='none')server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end('data: '+JSON.stringify({choices:[{delta:{content:'Gateway child done'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:2}})+'\n\ndata: [DONE]\n\n')}])
  await coordinator.create({sessionId:'parent'});await broker.configure({id:'original-project',name:'Original',roots:[workspace],primaryRoot:workspace});await broker.bind('parent','original-project')
  const bootstrapOwner=coordinator as typeof coordinator&{bootstrapChildTargetWithCapture:NonNullable<typeof coordinator.bootstrapChildTargetWithCapture>},originalB2=bootstrapOwner.bootstrapChildTargetWithCapture.bind(coordinator);const b2Spy=vi.spyOn(bootstrapOwner,'bootstrapChildTargetWithCapture').mockImplementation(async(...args)=>{const result=await originalB2(...args);if(mode==='bad-closure'&&(result.kind==='ready'||result.kind==='already-ready'))return {...result,receipt:{...result.receipt,dependencyClosureDigest:'f'.repeat(64)}};return result})
  const prepare=vi.spyOn(broker,'prepareTaskChildInheritance')
  runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'native'),coordinator,projectFor:broker.nativeScopeFor,resultReadScopeFor:broker.resultReadScopeFor,prepareTaskChildInheritance:broker.prepareTaskChildInheritance,withBindingObservation:broker.withBindingObservation,retainSelectedProjectRead:async(...args)=>{const held=await broker.retainSelectedBindingRead(...args);return {...held,async close(){closeAttempts++;if(mode==='close-held'){closeEntered.resolve();await closeGate.promise}if(mode==='close-fail'&&closeAttempts===1)throw undefined;return held.close()}}},visibleRefsFor:async id=>{const session=(await coordinator.snapshot!(id)).session;return [...semanticSeedResultRefs(session),...session.events.flatMap(managedResultRefs)]}})
  let managedRef:import('@i-harness/core-session').ManagedArtifactRef|undefined
  if(mode==='managed'||mode==='copied-preparation'||mode==='bad-closure'||mode==='unrelated'||mode==='close-held'||mode==='close-fail'||mode==='unmanaged-ref'){
   const owner=runtime.contextOutput,source=await runtime.sourceFor('parent'),scope=owner.registerResultScope({operationId:'original-result',sessionId:'parent',callId:'observe',source},()=>true)
   const sink=await owner.beginResult(scope,'text-utf8-v1');await sink.write(Buffer.from('ORIGINAL MANAGED RESULT'));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Fixture result unavailable');managedRef=saved.ref
   await coordinator.append('parent',[{type:'turn/start'},{type:'user/message',text:'earlier turn'},{type:'step/start'},{type:'tool/call',callId:'observe',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'observe',name:'read',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'managed',media:[],retention:{kind:'artifact',ref:managedRef}}},{type:'step/end'},{type:'turn/end'}])
  }
  const script=mode!=='none'?[]:[{role:'assistant' as const,text:'Gateway child done'}],parent=await coordinator.openManagedDocument('parent'),ctx=createContext(),tools=createToolRegistry(ctx,{executionOwner:{view:parent.view,factOwner:parent,context:ctx,sessionId:'parent'}}),child=mode!=='none'?createOpenAICompatibleClient({apiKey:'loopback',model:'original-child',baseUrl:server!.baseUrl}):createMockClient(script)
  const dependency=vi.spyOn(runtime.contextOutput,'confirmSeedDependencies')
  mounted=registerSubagent(ctx,tools,{parentNotify:{async prepareTaskDelivery(input){expect(input.sessionId).toBe('parent');const result=await receivedInputsFor(parent,'parent').delivery.prepareLaunch(input.namespace,input.taskId,input.callSeq);return mode==='copied-preparation'?{...result}:result},async admit(){throw Error('unexpected admission')},wake(){}},parentSession:parent.view,factOwner:parent,parentModel:child,exec:registerExec(ctx),resolveModel:async()=>{throw Error('Inherited child cannot resolve model')},prepareTaskChild:mode==='unmanaged-ref'?createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}):mode==='unrelated'?async input=>{const host=await runtime!.prepareTaskChild(input);return {...host,prepare(request){const transfer=host.prepare(request);return {...transfer,async run(work){await recordFixture(parent,{type:'session/title',title:'unrelated',messageSeqs:[],source:'user'});return transfer.run(work)}}}}}:runtime.prepareTaskChild,reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(runtime.contextOutput,runtime.sourceFor,'parent'),generationFactoryFor:(owner,id,selected)=>(owned,deps)=>createGenerationLifecycle(owner.view,id,owned,{enabled:mode==='none',selectedClient:selected},deps),persist:{coordinator,stateId:'parent',parentSessionId:'parent'}});await mounted.ready
  mounted.roles.register({name:'small',description:'s',systemPrompt:'s',tools:[]})
  if(mode!=='none')await receivedInputsFor(parent,'parent').inbox.admit({inputId:'parent-input',text:'original safe parent context',intent:'user',delivery:'queue',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
  action=parent.beginAction();if(mode!=='none')committedFactSeqs(await action.facts.inputs.start({type:'agent/input/promoted',version:1,inputId:'parent-input'},{type:'user/message',text:'original safe parent context',input:{inputId:'parent-input',intent:'user'}}));const source=action.registerSettlementSource(async()=>{}),args={message:'work',task_name:'one',agent_type:'small',background:false,...(mode!=='none'?{fork_turns:'all' as const}:{})},[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'spawn_agent',args}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  dispatch=tools.dispatch(await tools.prepare({name:'spawn_agent',args},action.signal,{session:parent.view,sessionId:'parent',callId:'call',callEventSeq:seq!,settlementSource:source}))
  // Observe the original flight immediately; its body/close-cut race still propagates failure.
  dispatchDone=dispatch.then(()=>{},()=>{})
  if(String(mode)==='copied-preparation'){await expect(dispatch).rejects.toThrow('Original task history suffix changed');expect(server!.requests).toHaveLength(0);expect(b2Spy).not.toHaveBeenCalled();return}
  if(mode==='unmanaged-ref'){await expect(dispatch).rejects.toThrow('Unsupported unmanaged task semantic history dependencies');expect(parent.view.events.some(event=>event.type==='subagent/start')).toBe(false);expect(server!.requests).toHaveLength(0);expect((await coordinator.list()).filter(id=>id.startsWith('child-'))).toEqual([]);return}
  if(mode==='close-held'){
   await Promise.race([closeEntered.promise,dispatch.then(
    ()=>{throw Error('Original Task completed before its retained source close cut')},
    error=>{throw error})])
   expect(server!.requests).toHaveLength(0);expect(mounted.tasks.get('task-1')!.childSessionId).toBeUndefined();expect(b2Spy).toHaveBeenCalledTimes(1);closeGate.resolve()}
  if(mode==='close-fail'){await expect(dispatch).rejects.toBeUndefined();expect(server!.requests).toHaveLength(0);expect(mounted.tasks.get('task-1')!.childSessionId).toBeUndefined();expect(b2Spy).toHaveBeenCalledTimes(1);expect(closeAttempts).toBeGreaterThanOrEqual(2);return}
  if(mode==='unrelated'){await expect(dispatch).rejects.toThrow('Original task history suffix changed');expect(server!.requests).toHaveLength(0);return}
  if(mode==='bad-closure'){
   // The forged closure receipt disagrees with the original committed bootstrap event.
   await expect(dispatch).rejects.toThrow('Original B2 initial event mismatch');expect(server!.requests).toHaveLength(0);expect(b2Spy).toHaveBeenCalledTimes(1);return
  }const result=await dispatch;expect(parent.view.events.filter(event=>event.type==='agent/delivery-generation'&&event.op==='open')).toHaveLength(mode==='none'?0:1);expect(result).toMatchObject({task_id:'task-1',status:'completed'})
  const task=mounted.tasks.get('task-1')!,childId=task.childSessionId!
  expect(task.childBirth!.request.requestIntent.project).toEqual({kind:'project',projectId:'original-project'})
  expect(await coordinator.getDocument('desktop-session-project-'+createHash('sha256').update(childId).digest('hex'))).toEqual({version:1,projectId:'original-project'})
  expect((await broker.nativeScopeFor(childId)).projectId).toBe('original-project');expect(task.result).toMatchObject({kind:'retained',envelope:{retention:{kind:'artifact'}}});if(mode==='managed'||mode==='close-held')expect(dependency).toHaveBeenCalled();else expect(dependency).not.toHaveBeenCalled();expect(prepare).toHaveBeenCalledTimes(1);expect(script).toHaveLength(0);if(mode!=='none'){expect(server!.requests).toHaveLength(1);expect(server!.requests[0]!.body.model).toBe('original-child');expect(JSON.stringify(server!.requests[0]!.body.messages)).toContain('original safe parent context');expect(server!.errors).toEqual([]);expect(task.childBirth!.request.core.history.selection).toEqual({kind:'all'});expect(mounted.table.get('root/one')!.session.header?.seedLength).toBeGreaterThan(0)};expect(mounted.table.get('root/one')!.session.events.filter(event=>event.type==='model/exchange-accepted')).toHaveLength(1)
  const request=task.childBirth!.request
  await source.close();await mounted.dispose();mounted=undefined;if(mode==='managed'){action.finish();action=undefined;await coordinator.closeManagedDocument('parent');expect(await runtime.contextOutput.readResult({sessionId:childId},{ref:managedRef!})).toMatchObject({data:{text:'ORIGINAL MANAGED RESULT'}})}await runtime.close();runtime=undefined;await broker.close();await coordinator.close()
  cold=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract);await cold.openManagedDocument(childId)
  const writes=io.writes
  expect((await cold.inspectChildBootstrap!(request)).kind).toBe('ready');expect((await cold.inspectBootstrap(request.invocation)).kind).toBe('conflict')
  await expect(cold.inspectChildBootstrap!({...request,version:2} as never)).rejects.toThrow()
  await expect(cold.inspectChildBootstrap!({...request,requestIntent:{...request.requestIntent,kind:'public'}} as never)).rejects.toThrow()
  const core={...request.core,execution:{...request.core.execution,roleName:'foreign'}},intent=createChildBootstrapRequestIntent(core,request.requestIntent.project),foreign=captureChildBootstrapCaptureRequest({...request,core,invocation:{...request.invocation,requestDigest:intent.requestDigest},requestIntent:intent.intent})
  expect((await cold.inspectChildBootstrap!(foreign)).kind).toBe('conflict');expect(io.writes).toBe(writes)
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();releaseInspect=release.resolve;io.readPath=join(root,'sessions',childId+'.jsonl');io.entered=entered.resolve;io.gate=release.promise
  const observed=cold.inspectChildBootstrap!(request);inspectDone=observed.then(()=>{},()=>{});
  await Promise.race([entered.promise,observed.then(()=>{throw Error('Original child inspection completed before its controlled read cut')})]);cold.revokeManagedDocumentNewWork(childId);release.resolve();expect((await observed).kind).toBe('unavailable');expect(io.writes).toBe(writes)
  io.readPath='';io.gate=undefined;io.entered=undefined
  await source.close()
 }catch(error){failed=true;primary=error}finally{
  closeGate.resolve();releaseInspect?.();action?.finish()
  const errors:unknown[]=[]
  for(const cleanup of [
   async()=>{try{await mounted?.dispose()}finally{await dispatchDone}},
   ()=>runtime?.close(),()=>broker.close(),()=>coordinator.close(),
   ()=>cold?.close(),()=>inspectDone,()=>server?.close(),
  ])try{await cleanup()}catch(error){errors.push(error)}
  vi.restoreAllMocks()
  if(errors.length)throw new AggregateError([...(failed?[primary]:[]),...errors],'Original Gateway Task cleanup failed',{cause:primary})
  await rm(root,{recursive:true,force:true})
  if(failed)throw primary
 }
},60_000)
