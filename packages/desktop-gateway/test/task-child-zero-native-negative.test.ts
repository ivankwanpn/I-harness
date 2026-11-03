import {acquireSelectedMetadata} from '../../context-output/src/service.ts'
const nativeCount=vi.hoisted(()=>({active:false,opens:0,changed:false}))
vi.mock('../../fs-lock/src/artifact-path.ts',async()=>{
 const {createWin32ArtifactPathOwnerWithApi}=await import('../../fs-lock/src/win32-artifact-path.ts')
 const {win32ArtifactApi}=await import('../../fs-lock/src/win32-artifact-api.ts')
 return {createArtifactPathOwner(root:string){const actual=win32ArtifactApi();return createWin32ArtifactPathOwnerWithApi(root,{...actual,createFileW(...args){if(nativeCount.active)nativeCount.opens++;return Reflect.apply(actual.createFileW,actual,args)},getFileInformationByHandleEx(...args){const result=Reflect.apply(actual.getFileInformationByHandleEx,actual,args);if(nativeCount.changed&&result&&args[1]===18)args[2].writeBigUInt64LE(args[2].readBigUInt64LE(0)^1n,0);return result}})}}
})
import * as executorApi from '@i-harness/session-executor'
import {createContextOutputService} from '@i-harness/context-output'
import * as spawnConstructor from '../../subagent/src/tools/spawn.ts'
import {createAgent} from '../../core-agent/src/index.ts'
import {createAgentModelOriginOwner} from '../../core-agent/src/tool-batch/model-origin.ts'
import {createToolRegistryWithModelOrigin} from '../../core-tools/src/model-origin.ts'
import {receivedInputsFor} from '../../session-executor/src/lifecycle/received-inputs.ts'
import {createResultObservationScope,legacyObservationFor} from '../../session-executor/src/lifecycle/result-observation.ts'
import {captureObservation,hasOriginalZeroSource,qualifyOriginalZeroSource,registerOriginalZeroSourceVerifier} from '../../context-output/src/legacy/observed-read.ts'
import {describe,it,expect,vi,beforeAll,afterAll} from 'vitest'
import {mkdtemp,mkdir} from 'node:fs/promises'
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

describe.each(['all'] as const)('original zero-source controlled native identity mismatch %s',selection=>{
 let rCount=0,measured=-1,measuredAfter=-1,firstOpens=0,secondOpens=0,nativeDenied=false,cleanupFailure:unknown,runFailure:{cause:unknown}|undefined;const stop=Object.freeze({kind:'count-stop'})
 let root:string,coordinator:ReturnType<typeof createJsonlTaskTransitionCoordinator>,broker:ReturnType<typeof createProjectScopeBroker>,server:Awaited<ReturnType<typeof createLoopbackProvider>>,runtime:Awaited<ReturnType<typeof createNativeContextRuntime>>,mounted:ReturnType<typeof registerSubagent>|undefined,model:ReturnType<typeof createOpenAICompatibleClient>,first:string,spawnOverride:{mockRestore():void}
 async function spawn(parentId:string,forkTurns:'none'|'all'|number){
  const parent=await coordinator.openManagedDocument(parentId),ctx=createContext(),origins=createAgentModelOriginOwner({view:parent.view,factOwner:parent}),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{view:parent.view,factOwner:parent,context:ctx,sessionId:parentId}},origins.verifier),tools=pair.registry,modelCallOrigin=origins.bind(tools,pair.driver)
  const persist={coordinator,stateId:parentId,parentSessionId:parentId}
  mounted=registerSubagent(ctx,tools,{parentSession:parent.view,factOwner:parent,parentModel:model,exec:registerExec(ctx),resolveModel:async()=>{throw Error('unexpected resolver')},prepareTaskChild:async input=>{const host=await runtime.prepareTaskChild(input);if(parentId==='root')return host;return {...host,prepare(request){const transfer=host.prepare(request);return {...transfer,run(_work){return transfer.run(async guards=>{rCount=0;nativeCount.opens=0;nativeCount.active=true;try{guards.assertCurrent()}finally{nativeCount.active=false}measured=rCount;firstOpens=nativeCount.opens;await new Promise<void>(resolve=>setImmediate(resolve));rCount=0;nativeCount.opens=0;nativeCount.active=true;nativeCount.changed=true;let effects=0;try{expect(()=>{guards.assertCurrent();effects++}).toThrow();expect(effects).toBe(0);nativeDenied=true;console.info('original native identity mismatch denied before effect')}finally{nativeCount.changed=false;nativeCount.active=false}measuredAfter=rCount;secondOpens=nativeCount.opens;throw stop})}}}}},reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(runtime.contextOutput,runtime.sourceFor,parentId),generationFactoryFor:(owner,id,selected)=>(owned,deps)=>createGenerationLifecycle(owner.view,id,owned,{enabled:false,selectedClient:selected},deps),persist});await mounted.ready
  mounted.roles.register({name:'small',description:'s',systemPrompt:'s',tools:[]})
  if(forkTurns!=='none'){
   const agent=createAgent(ctx,{session:parent.view,factOwner:parent,tools,sessionId:parentId,systemPrompt:'',model,modelCallOrigin,generationFactory:owned=>createGenerationLifecycle(parent.view,parentId,owned,{enabled:false,selectedClient:()=>model})})
   try{await agent.run('spawn the nested child');return 'counted'}catch(error){runFailure={cause:error};return 'failed'}
   finally{try{await mounted.dispose()}catch(error){cleanupFailure=error}}
  }
  await receivedInputsFor(parent,parentId).inbox.admit({inputId:'parent-input',text:'start task',intent:'user',delivery:'queue',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
  const action=parent.beginAction();committedFactSeqs(await action.facts.inputs.start({type:'agent/input/promoted',version:1,inputId:'parent-input'},{type:'user/message',text:'start task',input:{inputId:'parent-input',intent:'user'}}));const source=action.registerSettlementSource(async()=>{}),args={message:'work',task_name:'one',agent_type:'small',background:false,fork_turns:forkTurns},[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'spawn_agent',args}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  try{expect(await tools.dispatch(await tools.prepare({name:'spawn_agent',args},action.signal,{session:parent.view,sessionId:parentId,callId:'call',callEventSeq:seq!,settlementSource:source}))).toMatchObject({status:'completed'});return mounted.tasks.get('task-1')!.childSessionId!}
  finally{await source.close();action.finish();await mounted.dispose();mounted=undefined}
 }
 beforeAll(async()=>{

  const originalScope=executorApi.createResultObservationScope;vi.spyOn(executorApi,'createResultObservationScope').mockImplementation(()=>{const scope=originalScope();return {...scope,retainSelected(capture){return scope.retainSelected({...capture,assertHostCurrent(){rCount++;capture.assertHostCurrent()}})}}})
  root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'zero-parent-'));const workspace=join(root,'workspace');await mkdir(workspace)
  const originalSpawn=spawnConstructor.createSpawnTool;spawnOverride=vi.spyOn(spawnConstructor,'createSpawnTool').mockImplementation(deps=>{deps.maxDepth=2;return originalSpawn(deps)})
  coordinator=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract);broker=createProjectScopeBroker(coordinator,workspace)
  const response=async(res:import('node:http').ServerResponse)=>{res.end('data: '+JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}})+'\n\ndata: [DONE]\n\n')}
  const call=async(res:import('node:http').ServerResponse)=>{res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'nested-call',type:'function',function:{name:'spawn_agent',arguments:JSON.stringify({message:'nested',task_name:'one',agent_type:'small',background:false,fork_turns:selection})}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')}
  server=await createLoopbackProvider('/v1/chat/completions',[async res=>{await response(res)},async res=>{await call(res)},async res=>{await response(res)}]);await coordinator.create({sessionId:'root'});await broker.configure({id:'p',name:'P',roots:[workspace],primaryRoot:workspace});await broker.bind('root','p')
  runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'native'),coordinator,projectFor:broker.nativeScopeFor,resultReadScopeFor:broker.resultReadScopeFor,prepareTaskChildInheritance:broker.prepareTaskChildInheritance,withBindingObservation:broker.withBindingObservation,retainSelectedProjectRead:broker.retainSelectedBindingRead});model=createOpenAICompatibleClient({apiKey:'loopback',model:'child',baseUrl:server.baseUrl})
  first=await spawn('root','none');const firstView=(await coordinator.snapshot!(first)).session;expect(firstView.header?.semanticSeed).toMatchObject({seedLength:0,groupCount:0})
  const originalDocument=await coordinator.openManagedDocument(first),originalSource=await runtime.sourceFor(first),scopes=createResultObservationScope(),separateService=createContextOutputService({root:join(root,'proof-service'),workspaceId:'proof-workspace'});let escaped:ReturnType<typeof legacyObservationFor>|undefined
  await coordinator.withExistingSessionBindingObservation!({sessionIds:[first,'root']},observation=>broker.withBindingObservation([first,'root'],observation,()=>scopes.run({sessionId:first,sessionIds:[first,'root'],observation,document:originalDocument,currentSource:()=>originalSource,assertHostCurrent(){observation.assertCurrent()}},async()=>{
   const original=legacyObservationFor(scopes.current(first)!);escaped=original;expect(()=>registerOriginalZeroSourceVerifier(runtime.contextOutput,()=>({document:originalDocument,view:originalDocument.view}))).toThrow();const forged={...original};qualifyOriginalZeroSource(runtime.contextOutput,forged);expect(hasOriginalZeroSource(forged)).toBe(false);qualifyOriginalZeroSource(runtime.contextOutput,original);expect(hasOriginalZeroSource(original,runtime.contextOutput)).toBe(false);let mutateVerifier=false;registerOriginalZeroSourceVerifier(separateService,value=>{if(value!==original)return;if(mutateVerifier)original.sourceId='foreign';return {document:originalDocument,view:originalDocument.view}});qualifyOriginalZeroSource(separateService,original);expect(hasOriginalZeroSource(original,separateService)).toBe(true);expect(hasOriginalZeroSource(original,runtime.contextOutput)).toBe(false);const copied=captureObservation(original,separateService);expect(hasOriginalZeroSource(copied,separateService)).toBe(true);expect(hasOriginalZeroSource({...original},separateService)).toBe(false)
   await new Promise<void>(resolve=>setImmediate(resolve));const method=original.assertCurrent;original.assertCurrent=()=>{};expect(()=>hasOriginalZeroSource(original,separateService)).toThrow();original.assertCurrent=method
   const copyMethod=copied.assertCurrent;copied.assertCurrent=()=>{};expect(()=>hasOriginalZeroSource(copied,separateService)).toThrow();copied.assertCurrent=copyMethod
   const digest=original.bootstrap!.invocation.requestDigest;original.bootstrap!.invocation.requestDigest='f'.repeat(64);expect(()=>hasOriginalZeroSource(original,separateService)).toThrow();original.bootstrap!.invocation.requestDigest=digest
   const sourceId=original.sourceId;mutateVerifier=true;expect(()=>hasOriginalZeroSource(original,separateService)).toThrow();mutateVerifier=false;original.sourceId=sourceId
   expect(Reflect.set(originalDocument.view.events[0]!,'operationId','foreign')).toBe(false)
   const metadata=await acquireSelectedMetadata(separateService,original),iterator=metadata.reader.legacy()[Symbol.asyncIterator]();expect((await iterator.next()).done).toBe(true);metadata.revoke();expect(()=>metadata.assertCurrent()).toThrow();original.assertCurrent();await metadata.close()
   await separateService.close();original.assertCurrent();expect(()=>hasOriginalZeroSource(original,separateService)).toThrow()
  })));expect(()=>hasOriginalZeroSource(escaped!,separateService)).toThrow()
 },60_000)
 it('retains original cleanup debt after controlled native identity mismatch',async()=>{await spawn(first,selection);expect(nativeDenied).toBe(true);expect(runFailure?.cause).toMatchObject({code:'FACT_RECOVERY_REQUIRED'});expect(measured).toBe(1);expect(measuredAfter).toBeLessThanOrEqual(1);expect(firstOpens).toBeGreaterThan(0);expect(secondOpens).toBeGreaterThan(0);expect(cleanupFailure).toBeInstanceOf(AggregateError);expect(mounted).toBeDefined();await expect(mounted!.dispose()).rejects.toThrow('Subagent settlement requires recovery');expect(server.requests).toHaveLength(2);expect(server.errors).toEqual([])},60_000)
 afterAll(async()=>{spawnOverride?.mockRestore();vi.restoreAllMocks();const failures:unknown[]=[];for(const close of [()=>mounted?.dispose(),()=>runtime?.close(),()=>broker?.close(),()=>coordinator?.close(),()=>server?.close()])try{await close()}catch(error){failures.push(error)}expect(failures.length).toBeGreaterThan(0);console.info('original native-loss cleanup debt retained',failures.length)},60_000)
})
