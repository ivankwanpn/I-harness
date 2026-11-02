import {createContextOutputService} from '@i-harness/context-output'
import * as spawnConstructor from '../../subagent/src/tools/spawn.ts'
import {createAgent} from '../../core-agent/src/index.ts'
import {createAgentModelOriginOwner} from '../../core-agent/src/tool-batch/model-origin.ts'
import {createToolRegistryWithModelOrigin} from '../../core-tools/src/model-origin.ts'
import {receivedInputsFor} from '../../session-executor/src/lifecycle/received-inputs.ts'
import {createResultObservationScope,legacyObservationFor} from '../../session-executor/src/lifecycle/result-observation.ts'
import {captureObservation,hasOriginalZeroSource,qualifyOriginalZeroSource,registerOriginalZeroSourceVerifier} from '../../context-output/src/legacy/observed-read.ts'
import {describe,it,expect,vi,beforeAll,afterAll} from 'vitest'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {committedFactSeqs} from '@i-harness/core-session'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createProjectScopeBroker} from '../src/project-scope.ts'
import {createNativeContextRuntime} from '../src/context-runtime.ts'
import {registerSubagent,SHIPPING_REPORT_POLICY} from '@i-harness/subagent'
import {registerExec} from '@i-harness/exec'
import {createGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'

describe.each(['all',1] as const)('original zero-seed source and %s child',selection=>{
 let root:string,coordinator:ReturnType<typeof createJsonlTaskTransitionCoordinator>,broker:ReturnType<typeof createProjectScopeBroker>,server:Awaited<ReturnType<typeof createLoopbackProvider>>,runtime:Awaited<ReturnType<typeof createNativeContextRuntime>>,mounted:ReturnType<typeof registerSubagent>|undefined,model:ReturnType<typeof createOpenAICompatibleClient>,first:string,spawnOverride:{mockRestore():void}
 async function spawn(parentId:string,forkTurns:'none'|'all'|number){
  const parent=await coordinator.openManagedDocument(parentId),ctx=createContext(),origins=createAgentModelOriginOwner({view:parent.view,factOwner:parent}),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{view:parent.view,factOwner:parent,context:ctx,sessionId:parentId}},origins.verifier),tools=pair.registry,modelCallOrigin=origins.bind(tools,pair.driver)
  const persist={coordinator,stateId:parentId,parentSessionId:parentId}
  mounted=registerSubagent(ctx,tools,{parentSession:parent.view,factOwner:parent,parentModel:model,exec:registerExec(ctx),resolveModel:async()=>{throw Error('unexpected resolver')},prepareTaskChild:runtime.prepareTaskChild,reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(runtime.contextOutput,runtime.sourceFor,parentId),generationFactoryFor:(owner,id,selected)=>(owned,deps)=>createGenerationLifecycle(owner.view,id,owned,{enabled:false,selectedClient:selected},deps),persist});await mounted.ready
  mounted.roles.register({name:'small',description:'s',systemPrompt:'s',tools:[]})
  if(forkTurns!=='none'){
   const agent=createAgent(ctx,{session:parent.view,factOwner:parent,tools,sessionId:parentId,systemPrompt:'',model,modelCallOrigin,generationFactory:owned=>createGenerationLifecycle(parent.view,parentId,owned,{enabled:false,selectedClient:()=>model})})
   try{await agent.run('spawn the nested child');const task=mounted.tasks.get('task-1');expect(task?.status).toBe('completed');return task!.childSessionId!}
   finally{await mounted.dispose();mounted=undefined}
  }
  await receivedInputsFor(parent,parentId).inbox.admit({inputId:'parent-input',text:'start task',intent:'user',delivery:'queue',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
  const action=parent.beginAction();committedFactSeqs(await action.facts.inputs.start({type:'agent/input/promoted',version:1,inputId:'parent-input'},{type:'user/message',text:'start task',input:{inputId:'parent-input',intent:'user'}}));const source=action.registerSettlementSource(async()=>{}),args={message:'work',task_name:'one',agent_type:'small',background:false,fork_turns:forkTurns},[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'spawn_agent',args}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  try{expect(await tools.dispatch(await tools.prepare({name:'spawn_agent',args},action.signal,{session:parent.view,sessionId:parentId,callId:'call',callEventSeq:seq!,settlementSource:source}))).toMatchObject({status:'completed'});return mounted.tasks.get('task-1')!.childSessionId!}
  finally{await source.close();action.finish();await mounted.dispose();mounted=undefined}
 }
 beforeAll(async()=>{

  root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'zero-parent-'));const workspace=join(root,'workspace');await mkdir(workspace)
  const originalSpawn=spawnConstructor.createSpawnTool;spawnOverride=vi.spyOn(spawnConstructor,'createSpawnTool').mockImplementation(deps=>{deps.maxDepth=2;return originalSpawn(deps)})
  coordinator=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract);broker=createProjectScopeBroker(coordinator,workspace)
  const response=async(res:import('node:http').ServerResponse)=>{res.end('data: '+JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}})+'\n\ndata: [DONE]\n\n')}
  const call=async(res:import('node:http').ServerResponse)=>{res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'nested-call',type:'function',function:{name:'spawn_agent',arguments:JSON.stringify({message:'nested',task_name:'one',agent_type:'small',background:false,fork_turns:selection})}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')}
  server=await createLoopbackProvider('/v1/chat/completions',[async res=>{await response(res)},async res=>{await call(res)},async res=>{await response(res)},async res=>{await response(res)}]);await coordinator.create({sessionId:'root'});await broker.configure({id:'p',name:'P',roots:[workspace],primaryRoot:workspace});await broker.bind('root','p')
  runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'native'),coordinator,projectFor:broker.nativeScopeFor,resultReadScopeFor:broker.resultReadScopeFor,prepareTaskChildInheritance:broker.prepareTaskChildInheritance,withBindingObservation:broker.withBindingObservation,retainSelectedProjectRead:broker.retainSelectedBindingRead});model=createOpenAICompatibleClient({apiKey:'loopback',model:'child',baseUrl:server.baseUrl})
  first=await spawn('root','none');const firstView=(await coordinator.snapshot!(first)).session;expect(firstView.header?.semanticSeed).toMatchObject({seedLength:0,groupCount:0})
  const originalDocument=await coordinator.openManagedDocument(first),originalSource=await runtime.sourceFor(first),scopes=createResultObservationScope(),separateService=createContextOutputService({root:join(root,'proof-service'),workspaceId:'proof-workspace'});let escaped:ReturnType<typeof legacyObservationFor>|undefined
  await coordinator.withExistingSessionBindingObservation!({sessionIds:[first,'root']},observation=>broker.withBindingObservation([first,'root'],observation,()=>scopes.run({sessionId:first,sessionIds:[first,'root'],observation,document:originalDocument,currentSource:()=>originalSource,assertHostCurrent(){observation.assertCurrent()}},async()=>{
   const original=legacyObservationFor(scopes.current(first)!);escaped=original;expect(()=>registerOriginalZeroSourceVerifier(runtime.contextOutput,()=>({document:originalDocument,view:originalDocument.view}))).toThrow();const forged={...original};qualifyOriginalZeroSource(runtime.contextOutput,forged);expect(hasOriginalZeroSource(forged)).toBe(false);qualifyOriginalZeroSource(runtime.contextOutput,original);expect(hasOriginalZeroSource(original,runtime.contextOutput)).toBe(false);registerOriginalZeroSourceVerifier(separateService,value=>value===original?{document:originalDocument,view:originalDocument.view}:undefined);qualifyOriginalZeroSource(separateService,original);expect(hasOriginalZeroSource(original,separateService)).toBe(true);expect(hasOriginalZeroSource(original,runtime.contextOutput)).toBe(false);expect(hasOriginalZeroSource(captureObservation(original,separateService),separateService)).toBe(true);expect(hasOriginalZeroSource({...original},separateService)).toBe(false);await separateService.close();original.assertCurrent();expect(()=>hasOriginalZeroSource(original,separateService)).toThrow()
  })));expect(()=>hasOriginalZeroSource(escaped!,separateService)).toThrow()
 },60_000)
 it('allows the actual accepted Task exchange',async()=>{const second=await spawn(first,selection);expect(second).toBeTruthy();expect(server.requests).toHaveLength(4);expect(server.errors).toEqual([])},60_000)
 afterAll(async()=>{spawnOverride?.mockRestore();await mounted?.dispose();await runtime?.close();await broker?.close();await coordinator?.close();await server?.close();if(root)await rm(root,{recursive:true,force:true})},60_000)
})
