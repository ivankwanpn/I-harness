import {inspect} from 'node:util'
import {performance} from 'node:perf_hooks'
import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext,captureExecutionHookChannel} from '@i-harness/core-plugin'
import {semanticSeedResultRefs,managedResultRefs} from '@i-harness/core-session'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {createManagedAgent} from '../../core-agent/src/index.ts'
import {createManagedAgentModelOriginOwner} from '../../core-agent/src/tool-batch/model-origin.ts'
import {createProjectScopeBroker} from '../src/project-scope.ts'
import {createNativeContextRuntime} from '../src/context-runtime.ts'
import {mkdir} from 'node:fs/promises'
import {registerExec} from '@i-harness/exec'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createExecutionGenerationLifecycle,createGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {registerSubagent,SHIPPING_REPORT_POLICY} from '@i-harness/subagent'

it('transfers selected native artifacts from a private Task source',async()=>{
 const started=performance.now(),cpu=process.cpuUsage(),elu=performance.eventLoopUtilization();const mark=(phase:string)=>console.info('NATIVE_FIXTURE',phase,'wallMs',Math.round(performance.now()-started),'cpu',process.cpuUsage(cpu),'elu',performance.eventLoopUtilization(elu))
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-task-child-'))
 const backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 mark('coordinator')
 const workspace=join(root,'workspace');await mkdir(workspace);await coordinator.create({sessionId:'parent'});const broker=createProjectScopeBroker(coordinator,workspace);await broker.configure({id:'p',name:'P',roots:[workspace],primaryRoot:workspace});await broker.bind('parent','p')
 mark('runtime')
 const runtime=await createNativeContextRuntime({workspace,storageRoot:join(root,'native'),coordinator,projectFor:broker.nativeScopeFor,resultReadScopeFor:broker.resultReadScopeFor,prepareTaskChildInheritance:broker.prepareTaskChildInheritance,withBindingObservation:broker.withBindingObservation,retainSelectedProjectRead:broker.retainSelectedBindingRead,visibleRefsFor:async id=>{const view=(await coordinator.snapshot!(id)).session;return [...semanticSeedResultRefs(view),...view.events.flatMap(managedResultRefs)]}})
 mark('artifact')
 const output=runtime.contextOutput, source=await runtime.sourceFor('parent'), scope=output.registerResultScope({operationId:'task-history-fixture',sessionId:'parent',callId:'prior',source},()=>true), sink=await output.beginResult(scope,'text-utf8-v1');await sink.write(Buffer.from('original private artifact'));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('artifact publication failed');const ref=saved.ref
 mark('append')
 await coordinator.append('parent',[{type:'turn/start'},{type:'user/message',text:'prior original context'},{type:'step/start'},{type:'tool/call',callId:'prior',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'prior',name:'read',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'artifact',media:[],retention:{kind:'artifact',ref}}},{type:'step/end'},{type:'turn/end'}])
 mark('execution')
 const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution)
 const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'parent'}},origin.verifier)
 let childReads=0
 pair.registry.register({name:'read',description:'controlled child read',inputSchema:{type:'object'},async execute(){childReads++;return 'child tool result'}})
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'task-call',function:{name:'spawn_agent',arguments:JSON.stringify({message:'do work',task_name:'child',background:false,fork_turns:'all'})}}]}:{content:'parent continued'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const childWire=`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'child-read',function:{name:'read',arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const childServer=await createLoopbackProvider('/v1/chat/completions',[async(response,request)=>{mark('child-first');expect(JSON.stringify(request.body.messages)).toContain('prior original context');response.end(childWire)},async(response,request)=>{mark('model-continuation');expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]));response.end(wire(false))}])
 const child=createOpenAICompatibleClient({apiKey:'loopback',model:'child',baseUrl:childServer.baseUrl})
 mark('mount')
 const mounted=registerSubagent(ctx,pair.registry,{managedParent:{domain:origin.domain,execution},parentModel:child,exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),prepareTaskChild:runtime.prepareTaskChild,generationFactoryFor:(owner,id,selected)=>(owned,dependencies)=>createGenerationLifecycle(owner.view,id,owned,{enabled:false,selectedClient:selected},dependencies),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(output,runtime.sourceFor,'parent'),persist:{coordinator,stateId:'parent',parentSessionId:'parent'}})
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{mark('parent-first');response.end(wire(true))},async(response,request)=>{expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]));response.end(wire(false))}])
 let primary:unknown,failed=false,mountedClosed=false,ticks=0;const heartbeat=setInterval(()=>mark('heartbeat-'+(++ticks)),10000)
 try{
 mark('mount-ready')
  await mounted.ready
  const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'system',budget:{contextWindow:32000},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,'parent',action,undefined,deps)})
 mark('run')
  const timeout=AbortSignal.timeout(120000);const result=await Promise.race([agent.run('delegate work',timeout),new Promise<never>((_,reject)=>timeout.addEventListener('abort',()=>reject(Error('agent run stalled')),{once:true}))])
 mark('run-done')
  expect(result.finalText).toBe('parent continued')
  expect(mounted.tasks.list()).toEqual(expect.arrayContaining([expect.objectContaining({status:'completed'})]))
  expect(childReads).toBe(1)
  expect(Object.hasOwn(execution.owner,'view')).toBe(false)
  const target=mounted.tasks.list()[0]!.childSessionId!;await mounted.dispose();mountedClosed=true
 mark('target-read')
  expect(await output.readResult({sessionId:target},{ref})).toMatchObject({data:{text:'original private artifact'}})
 }catch(error){primary=error;failed=true;console.error('NATIVE_FIXTURE primary',inspect(error,{depth:10}));console.error('NATIVE_FIXTURE tasks',inspect(mounted.tasks.list(),{depth:10}))}finally{
  clearInterval(heartbeat);const errors:unknown[]=[];for(const [name,close] of [['mounted',()=>mountedClosed?Promise.resolve():mounted.dispose()],['runtime',()=>runtime.close()],['broker',()=>broker.close()],['coordinator',()=>coordinator.close()],['parent server',()=>server.close()],['child server',()=>childServer.close()]] as const){try{await close()}catch(error){console.error('NATIVE_FIXTURE cleanup',name,inspect(error,{depth:10}));errors.push(error)}}
  if(errors.length)throw new AggregateError([...(failed?[primary]:[]),...errors],'fixture primary or cleanup failed');if(failed)throw primary
 }
},150000)
