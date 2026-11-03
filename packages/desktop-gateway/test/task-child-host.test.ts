import {it,expect,vi} from 'vitest'
const io=vi.hoisted(()=>({writes:0,readPath:'',entered:undefined as undefined|(()=>void),gate:undefined as Promise<void>|undefined}))
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,async writeFile(...args:Parameters<typeof fs.writeFile>){io.writes++;return fs.writeFile(...args)},async rename(...args:Parameters<typeof fs.rename>){io.writes++;return fs.rename(...args)},async readFile(...args:Parameters<typeof fs.readFile>){const value=await fs.readFile(...args);if(String(args[0])===io.readPath){io.entered?.();await io.gate}return value}}})
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistry} from '@i-harness/core-tools'
import {committedFactSeqs} from '@i-harness/core-session'
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

it.each(['none','all'] as const)('original Gateway Task child host prepares real project binding and retained result without seed dependency reads: %s',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-task-')),workspace=join(root,'workspace');await mkdir(workspace)
 const coordinator=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract)
 const broker=createProjectScopeBroker(coordinator,workspace)
 let runtime:Awaited<ReturnType<typeof createNativeContextRuntime>>|undefined,mounted:ReturnType<typeof registerSubagent>|undefined,action:ReturnType<Awaited<ReturnType<typeof coordinator.openManagedDocument>>['beginAction']>|undefined,cold:typeof coordinator|undefined
 let server:Awaited<ReturnType<typeof createLoopbackProvider>>|undefined
 try{
  if(mode==='all')server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end('data: '+JSON.stringify({choices:[{delta:{content:'Gateway child done'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:2}})+'\n\ndata: [DONE]\n\n')}])
  await coordinator.create({sessionId:'parent'});await broker.configure({id:'original-project',name:'Original',roots:[workspace],primaryRoot:workspace});await broker.bind('parent','original-project')
  const prepare=vi.spyOn(broker,'prepareTaskChildInheritance')
  runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'native'),coordinator,projectFor:broker.nativeScopeFor,resultReadScopeFor:broker.resultReadScopeFor,prepareTaskChildInheritance:broker.prepareTaskChildInheritance})
  const script=mode==='all'?[]:[{role:'assistant' as const,text:'Gateway child done'}],parent=await coordinator.openManagedDocument('parent'),ctx=createContext(),tools=createToolRegistry(ctx,{executionOwner:{view:parent.view,factOwner:parent,context:ctx,sessionId:'parent'}}),child=mode==='all'?createOpenAICompatibleClient({apiKey:'loopback',model:'original-child',baseUrl:server!.baseUrl}):createMockClient(script)
  const dependency=vi.spyOn(runtime.contextOutput,'confirmSeedDependencies')
  mounted=registerSubagent(ctx,tools,{parentSession:parent.view,factOwner:parent,parentModel:child,exec:registerExec(ctx),resolveModel:async()=>{throw Error('Inherited child cannot resolve model')},prepareTaskChild:runtime.prepareTaskChild,reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(runtime.contextOutput,runtime.sourceFor,'parent'),generationFactoryFor:(owner,id,selected)=>(owned,deps)=>createGenerationLifecycle(owner.view,id,owned,{enabled:mode==='none',selectedClient:selected},deps),persist:{coordinator,stateId:'parent',parentSessionId:'parent'}});await mounted.ready
  mounted.roles.register({name:'small',description:'s',systemPrompt:'s',tools:[]})
  if(mode==='all')await receivedInputsFor(parent,'parent').inbox.admit({inputId:'parent-input',text:'original safe parent context',intent:'user',delivery:'queue',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
  action=parent.beginAction();if(mode==='all')committedFactSeqs(await action.facts.inputs.start({type:'agent/input/promoted',version:1,inputId:'parent-input'},{type:'user/message',text:'original safe parent context',input:{inputId:'parent-input',intent:'user'}}));const source=action.registerSettlementSource(async()=>{}),args={message:'work',task_name:'one',agent_type:'small',background:false,...(mode==='all'?{fork_turns:'all' as const}:{})},[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'spawn_agent',args}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  const result=await tools.dispatch(await tools.prepare({name:'spawn_agent',args},action.signal,{session:parent.view,sessionId:'parent',callId:'call',callEventSeq:seq!,settlementSource:source}));expect(result).toMatchObject({task_id:'task-1',status:'completed'})
  const task=mounted.tasks.get('task-1')!,childId=task.childSessionId!
  expect(task.childBirth!.request.requestIntent.project).toEqual({kind:'project',projectId:'original-project'})
  expect(await coordinator.getDocument('desktop-session-project-'+createHash('sha256').update(childId).digest('hex'))).toEqual({version:1,projectId:'original-project'})
  expect((await broker.nativeScopeFor(childId)).projectId).toBe('original-project');expect(task.result).toMatchObject({kind:'retained',envelope:{retention:{kind:'artifact'}}});expect(dependency).not.toHaveBeenCalled();expect(prepare).toHaveBeenCalledTimes(1);expect(script).toHaveLength(0);if(mode==='all'){expect(server!.requests).toHaveLength(1);expect(server!.requests[0]!.body.model).toBe('original-child');expect(JSON.stringify(server!.requests[0]!.body.messages)).toContain('original safe parent context');expect(server!.errors).toEqual([]);expect(task.childBirth!.request.core.history.selection).toEqual({kind:'all'});expect(mounted.table.get('root/one')!.session.header?.seedLength).toBeGreaterThan(0)};expect(mounted.table.get('root/one')!.session.events.filter(event=>event.type==='model/exchange-accepted')).toHaveLength(1)
  const request=task.childBirth!.request
  await source.close();await mounted.dispose();mounted=undefined;await runtime.close();runtime=undefined;await broker.close();await coordinator.close()
  cold=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract);await cold.openManagedDocument(childId)
  const writes=io.writes
  expect((await cold.inspectChildBootstrap!(request)).kind).toBe('ready');expect((await cold.inspectBootstrap(request.invocation)).kind).toBe('conflict')
  await expect(cold.inspectChildBootstrap!({...request,version:2} as never)).rejects.toThrow()
  await expect(cold.inspectChildBootstrap!({...request,requestIntent:{...request.requestIntent,kind:'public'}} as never)).rejects.toThrow()
  const core={...request.core,execution:{...request.core.execution,roleName:'foreign'}},intent=createChildBootstrapRequestIntent(core,request.requestIntent.project),foreign=captureChildBootstrapCaptureRequest({...request,core,invocation:{...request.invocation,requestDigest:intent.requestDigest},requestIntent:intent.intent})
  expect((await cold.inspectChildBootstrap!(foreign)).kind).toBe('conflict');expect(io.writes).toBe(writes)
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();io.readPath=join(root,'sessions',childId+'.jsonl');io.entered=entered.resolve;io.gate=release.promise
  const observed=cold.inspectChildBootstrap!(request);await entered.promise;cold.revokeManagedDocumentNewWork(childId);release.resolve();expect((await observed).kind).toBe('unavailable');expect(io.writes).toBe(writes)
  io.readPath='';io.gate=undefined;io.entered=undefined
  await source.close()
 }finally{action?.finish();await mounted?.dispose();await runtime?.close();await broker.close();await coordinator.close();await cold?.close();await server?.close();await rm(root,{recursive:true,force:true})}
},20_000)
