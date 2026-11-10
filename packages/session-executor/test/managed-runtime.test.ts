import {expect,it,vi} from 'vitest'
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return {...original,createManagedSessionState(){throw Error('Private runtime opened public view')},projectConversation(){throw Error('Private runtime replayed public history')}}})
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createExecutorExecutionCache} from '../src/durable-session.ts'
import * as assembly from '../src/assembly.ts'
import {createSessionService} from '../src/service.ts'
import {createMainInstructionManager} from '../src/context/instructions/manager.ts'
import {createProjectInstructionEnvironment} from '../src/context/instructions/index.ts'
import {createExecutionRuntimeContext} from '../src/lifecycle/execution-runtime-context.ts'
import {registerApprovalAnswerer} from '@i-harness/interaction'
import {createManagedExecutionRuntime} from '../src/managed-assembly.ts'
import {controlledModel} from './controlled-model.ts'
import {completeCheckpoint} from '../../compaction/test/fixtures/checkpoint.ts'
import {committedFactSeqs} from '@i-harness/core-session'
import {createSessionManagement} from '../../desktop-gateway/src/session-management.ts'

it('inspects a held managed request without claiming a legacy assembly',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-activity-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model:controlledModel(async function*(){entered.resolve();await release.promise;yield {type:'text/chunk',text:'done'};yield {type:'end'}}),contextWindow:4096,maxOutputTokens:128})
 const turn=service.submit('main','held',new AbortController().signal)
 try{
  await entered.promise
  expect(service.hasAssembly('main')).toBe(false)
  expect(service.inspectActivity!('main')).toMatchObject({live:true,running:true,active:true})
  release.resolve();await turn
  expect(service.inspectActivity!('main')).toMatchObject({live:true,running:false,active:false})
 }finally{release.resolve();await turn.catch(()=>{});await service.close();await coordinator.close()}
},30000)

it('private runtime honors live automatic compaction policy',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-auto-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 let enabled=false,summaries=0
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const summarizer=controlledModel(async function*(){summaries++;yield {type:'text/chunk',text:completeCheckpoint()};yield {type:'end'}})
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model,systemPrompt:'system',tools:[],contextWindow:20000,maxOutputTokens:5000,compact:{auto:true,thresholdRatio:.15,targetRatio:.1,minTurnsBeforeRecompact:0,summarizationModel:summarizer,minSummaryChars:1},autoCompactionEnabled:()=>enabled})
  await entry.inputs.inbox.admit({inputId:'a',text:'work '.repeat(1500),delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('a')
  expect(summaries).toBe(0)
  enabled=true
  await entry.inputs.inbox.admit({inputId:'b',text:'continue',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('b')
  expect(summaries).toBe(1)
  expect((await backend.read('main')).events.some(event=>event.type==='compaction/replacement')).toBe(true)
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('private runtime atomically rebinds an idle model and its limits',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-rebind-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const firstRequests:unknown[]=[],secondRequests:{maxOutputTokens?:number;reasoningEffort?:string}[]=[]
 const first=controlledModel(async function*(request){firstRequests.push(request);yield {type:'text/chunk',text:'first'};yield {type:'end'}})
 const second=controlledModel(async function*(request){secondRequests.push(request);yield {type:'text/chunk',text:'second'};yield {type:'end'}})
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model:first,systemPrompt:'system',tools:[],contextWindow:10000,maxOutputTokens:100})
  await entry.inputs.inbox.admit({inputId:'a',text:'first',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('a')
  runtime.setModelBinding({model:second,contextWindow:20000,maxOutputTokens:200,reasoningEffort:'low'})
  await entry.inputs.inbox.admit({inputId:'b',text:'second',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('b')
  expect(firstRequests).toHaveLength(1);expect(secondRequests).toHaveLength(1)
  expect(secondRequests[0]).toMatchObject({maxOutputTokens:200,reasoningEffort:'low'})
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('private model binding rejects a busy turn and invalid limits without changing the model',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-rebind-busy-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 let original=0,replacement=0
 const first=controlledModel(async function*(){original++;entered.resolve();await release.promise;yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const second=controlledModel(async function*(){replacement++;yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model:first,systemPrompt:'system',tools:[],contextWindow:10000})
  await entry.inputs.inbox.admit({inputId:'a',text:'first',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  const turn=runtime.lane.runAdmitted('a');await entered.promise
  expect(()=>runtime.setModelBinding({model:second,contextWindow:10000})).toThrow(/busy/)
  release.resolve();await turn
  expect(()=>runtime.setModelBinding({model:second,contextWindow:10000,maxOutputTokens:0})).toThrow()
  await entry.inputs.inbox.admit({inputId:'b',text:'second',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('b')
  expect(original).toBe(2);expect(replacement).toBe(0)
  await cache.close('main')
  expect(()=>runtime.setModelBinding({model:second,contextWindow:10000})).toThrow()
  await runtime.close()
 }finally{release.resolve();await cache.closeAll();await coordinator.close()}
},30000)

it('private model binding rechecks currentness after dynamic prompt evaluation',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-rebind-retire-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 let retire=false
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model,systemPrompt:()=>{if(retire)entry.execution.revokeNewWork();return 'system'},tools:[],contextWindow:10000})
  retire=true
  expect(()=>runtime.setModelBinding({model,contextWindow:10000})).toThrow()
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('private model binding refuses runtime close during dynamic prompt evaluation',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-rebind-close-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 let originalCalls=0,replacementCalls=0,output:number|undefined
 const model=controlledModel(async function*(request){originalCalls++;output=request.maxOutputTokens;yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const replacement=controlledModel(async function*(){replacementCalls++;yield {type:'text/chunk',text:'replacement'};yield {type:'end'}})
 let trigger=false,closing:Promise<void>|undefined,runtime!:ReturnType<typeof createManagedExecutionRuntime>
 try{
  runtime=createManagedExecutionRuntime({execution:entry.execution,model,systemPrompt:()=>{if(trigger)closing=runtime.close();return 'system'},tools:[],contextWindow:10000,maxOutputTokens:100})
  trigger=true
  expect(()=>runtime.setModelBinding({model:replacement,contextWindow:20000,maxOutputTokens:200})).toThrow()
  expect(closing).toBeDefined();await closing
  trigger=false
  await entry.inputs.inbox.admit({inputId:'after',text:'probe old binding',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.agent.runAdmitted('probe old binding',undefined,undefined,'after')
  expect(originalCalls).toBe(1);expect(replacementCalls).toBe(0);expect(output).toBe(100)
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('private model binding rejects accessor-bearing input without invoking getters',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-rebind-accessors-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 let reads=0
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model,systemPrompt:'system',tools:[],contextWindow:10000})
  const binding={get model(){reads++;return model},contextWindow:10000}
  expect(()=>runtime.setModelBinding(binding)).toThrow()
  const compact={prune:{get thresholdChars(){reads++;return 100}}}
  expect(()=>runtime.setModelBinding({model,contextWindow:10000},compact)).toThrow()
  expect(reads).toBe(0)
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('private model binding refuses Date and byte objects without invoking caller hooks',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-rebind-nonplain-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 let reads=0
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model,systemPrompt:'system',tools:[],contextWindow:10000})
  const date=new Date();Object.defineProperty(date,'getTime',{get(){reads++;return Date.prototype.getTime}})
  const bytes=new Uint8Array([1,2]);Object.defineProperty(bytes,Symbol.iterator,{get(){reads++;return Uint8Array.prototype[Symbol.iterator]}})
  expect(()=>runtime.setModelBinding({model,contextWindow:10000},Object.assign({auto:false},{extra:date}))).toThrow()
  expect(()=>runtime.setModelBinding({model,contextWindow:10000},Object.assign({auto:false},{extra:bytes}))).toThrow()
  expect(reads).toBe(0)
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('private model binding refuses a turn started during prompt evaluation',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-rebind-reentry-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 let originalCalls=0,replacementCalls=0,trigger=false,turn:Promise<unknown>|undefined,runtime!:ReturnType<typeof createManagedExecutionRuntime>
 const model=controlledModel(async function*(){originalCalls++;yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const replacement=controlledModel(async function*(){replacementCalls++;yield {type:'text/chunk',text:'replacement'};yield {type:'end'}})
 try{
  runtime=createManagedExecutionRuntime({execution:entry.execution,model,systemPrompt:()=>{if(trigger){trigger=false;turn=runtime.agent.runAdmitted('original',undefined,undefined,'input')};return 'system'},tools:[],contextWindow:10000})
  await entry.inputs.inbox.admit({inputId:'input',text:'original',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  trigger=true;expect(()=>runtime.setModelBinding({model:replacement,contextWindow:10000})).toThrow(/busy/)
  expect(turn).toBeDefined();await turn
  expect(originalCalls).toBe(1);expect(replacementCalls).toBe(0)
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('private model binding uses one captured value when the prompt mutates its caller input',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-rebind-capture-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 let secondCalls=0,thirdCalls=0,output:number|undefined,trigger=false
 const first=controlledModel(async function*(){yield {type:'text/chunk',text:'first'};yield {type:'end'}})
 const second=controlledModel(async function*(request){secondCalls++;output=request.maxOutputTokens;yield {type:'text/chunk',text:'second'};yield {type:'end'}})
 const third=controlledModel(async function*(){thirdCalls++;yield {type:'text/chunk',text:'third'};yield {type:'end'}})
 const binding={model:second,contextWindow:10000,maxOutputTokens:200}
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model:first,systemPrompt:()=>{if(trigger){binding.model=third;binding.maxOutputTokens=500};return 'system'},tools:[],contextWindow:10000})
  trigger=true;runtime.setModelBinding(binding)
  await entry.inputs.inbox.admit({inputId:'input',text:'test',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input')
  expect(secondCalls).toBe(1);expect(thirdCalls).toBe(0);expect(output).toBe(200)
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('private rebinding preserves the configured summary model identity',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-rebind-summary-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 let summaries=0
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const summarizer=controlledModel(async function*(){summaries++;yield {type:'text/chunk',text:completeCheckpoint()};yield {type:'end'}})
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model,systemPrompt:'system',tools:[],contextWindow:100000})
  runtime.setModelBinding({model,contextWindow:100000},{auto:false,summarizationModel:summarizer,minSummaryChars:1})
  await entry.inputs.inbox.admit({inputId:'input',text:'original work '.repeat(300),delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input')
  await entry.inputs.inbox.admit({inputId:'next',text:'continue',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('next')
  expect((await runtime.agent.compact()).publication).toBe('committed')
  expect(summaries).toBe(1)
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('private rebinding preserves a per-model summary client in compact policy',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-rebind-policy-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 let summaries=0
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}},{providerId:'fixture',modelId:'fixture'})
 const summarizer=controlledModel(async function*(){summaries++;yield {type:'text/chunk',text:completeCheckpoint()};yield {type:'end'}})
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model,systemPrompt:'system',tools:[],contextWindow:100000})
  runtime.setModelBinding({model,contextWindow:100000,contextMetadata:{version:1,providerId:'fixture',modelId:'fixture',protocol:'openai-compatible',identityCoverage:'partial'}},{auto:false,minSummaryChars:1,modelPolicies:{'fixture/fixture':{summarizationModel:summarizer,retainTokens:0}}})
  await entry.inputs.inbox.admit({inputId:'input',text:'original work '.repeat(300),delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input')
  await entry.inputs.inbox.admit({inputId:'next',text:'continue',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('next')
  expect((await runtime.agent.compact()).publication).toBe('committed')
  expect(summaries).toBe(1)
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('private summary cannot publish after its selected conversation changes',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-summary-stale-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const summarizer=controlledModel(async function*(){entered.resolve();await release.promise;yield {type:'text/chunk',text:completeCheckpoint('STALE_SUMMARY')};yield {type:'end'}})
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model,systemPrompt:'system',tools:[],contextWindow:100000,compact:{auto:false,summarizationModel:summarizer,minSummaryChars:1}})
  await entry.inputs.inbox.admit({inputId:'input',text:'original work '.repeat(300),delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input')
  const pending=runtime.agent.compact(undefined,{maxSummaryCalls:1})
  await entered.promise
  const action=entry.execution.owner.beginAction()
  try{committedFactSeqs(await action.facts.agent.feedback({type:'user/message',text:'changed during summary',source:{kind:'plugin',plugin:'fixture'}}))}finally{action.finish()}
  release.resolve()
  await pending
  expect(JSON.stringify((await backend.read('main')).events.filter(event=>event.type==='compaction/replacement'))).not.toContain('STALE_SUMMARY')
  await runtime.close()
 }finally{release.resolve();await cache.closeAll();await coordinator.close()}
},30000)

it('private runtime binds the original summary factory to manual compaction',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-summary-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 let summaries=0
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const summarizer=controlledModel(async function*(){summaries++;yield {type:'text/chunk',text:completeCheckpoint()};yield {type:'end'}})
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model,systemPrompt:'system',tools:[],contextWindow:100000,compact:{auto:false,summarizationModel:summarizer,minSummaryChars:1}})
  await entry.inputs.inbox.admit({inputId:'input',text:'original work '.repeat(300),delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input')
  await entry.inputs.inbox.admit({inputId:'next',text:'continue',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('next')
  const result=await runtime.agent.compact()
  if(!result.compacted)throw Error(`summary result ${JSON.stringify(result)} calls ${summaries}; events ${JSON.stringify((await backend.read('main')).events.map(event=>event.type))}`)
  expect(result).toMatchObject({compacted:true,publication:'committed'})
  expect(result.publication).toBe('committed')
  expect(summaries).toBe(1)
  expect((await backend.read('main')).events.some(event=>event.type==='compaction/replacement')).toBe(true)
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('private runtime composes manual compaction over real tool output',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-compact-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'large',function:{name:'large',arguments:'{}'}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))}])
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'system',tools:[{name:'large',description:'produce output',inputSchema:{type:'object'},async execute(){return 'large-output-'.repeat(200)}}],contextWindow:16000,compact:{auto:false,retainTokens:0,prune:{thresholdChars:100,headChars:16,tailChars:16}}})
  await entry.inputs.inbox.admit({inputId:'input',text:'read',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input')
  const result=await runtime.agent.compact()
  expect(result.compacted).toBe(true)
  expect(result.publication).toBe('committed')
  expect((await backend.read('main')).events.some(event=>event.type==='compaction/prune')).toBe(true)
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close();await server.close()}
},30000)

it('private runtime reads dynamic system prompt for each actual model request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-prompt-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'prompt-update',function:{name:'prompt_update',arguments:'{}'}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 let prompt='before'
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))}])
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:()=>prompt,tools:[{name:'prompt_update',description:'update state',inputSchema:{type:'object'},async execute(){prompt='after';return 'updated'}}]})
  await entry.inputs.inbox.admit({inputId:'input',text:'update',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input')
  expect(JSON.stringify(server.requests[0]!.body)).toContain('before')
  expect(JSON.stringify(server.requests[1]!.body)).toContain('after')
  expect(JSON.stringify(server.requests[1]!.body)).toContain('updated')
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close();await server.close()}
},30000)

it('original private runtime consumes the cache admission on the genuine lane through tool body and continuation',async()=>{
 const create=Reflect.get(assembly,'createManagedExecutionRuntime')
 expect(create).toBeTypeOf('function')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'probe',function:{name:'probe',arguments:'{}'}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 let effects=0
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async(response,request)=>{expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]));response.end(wire(false))}])
 try{
  const runtime=create({execution:entry.execution,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'original system',tools:[{name:'probe',description:'controlled original body',inputSchema:{type:'object'},async execute(_args:unknown,exec:{session?:unknown}){expect(exec.session).toBeUndefined();effects++;return 'original result'}}],contextWindow:4096,maxOutputTokens:128})
  await entry.inputs.inbox.admit({inputId:'input',text:'probe then report',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input')
  expect(effects).toBe(1);expect(server.requests).toHaveLength(2)
  expect(await cache.get('main')).toBe(entry)
  expect(Object.hasOwn(runtime,'session')).toBe(false)
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close();await server.close()}
},30000)

it('custom complete Session loader is selected before private entry or model effects',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-compat-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const refusal=Error('Original complete loader refusal');let loads=0,models=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original system',tools:[]},sessionFor:async()=>{loads++;throw refusal},modelBuilder:async()=>{models++;throw Error('Unreachable')}})
 try{await expect(service.submit('main','raw',new AbortController().signal)).rejects.toBe(refusal);expect(loads).toBe(1);expect(models).toBe(0)}
 finally{await service.close();await coordinator.close()}
},30000)

it('falsey model construction failure retains its private entry until original close acknowledges cleanup',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-failed-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 let builds=0,failed=false,reason:unknown
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original system',tools:[]},modelBuilder:async()=>{builds++;throw undefined}})
 try{
  await service.submit('main','first',new AbortController().signal).catch(error=>{failed=true;reason=error})
  expect(failed).toBe(true);expect(reason).toBeUndefined();expect(builds).toBe(1)
  await expect(service.receivedInputFor('main')).rejects.toThrow('cleanup incomplete')
  expect(builds).toBe(1)
  await service.closeSession('main')
  const inbox=await service.receivedInputFor('main')
  await inbox.admit({inputId:'new',text:'new',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  expect(inbox.pending().map(input=>input.text)).toEqual(['first','new'])
 }finally{await service.close();await coordinator.close()}
},30000)

it('service close retains the original pending managed constructor and prevents late model publication',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-close-'))
 const backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 let transports=0
 const model={async *stream(){transports++;throw Error('Late transport must not issue')}}
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original system',tools:[]},modelBuilder:async()=>{entered.resolve();await release.promise;return model}})
 const turn=service.submit('main','held',new AbortController().signal)
 const observed=turn.catch(error=>error)
 try{
  await entered.promise
  let closed=false
  const closing=service.closeSession('main').then(()=>{closed=true})
  await Promise.resolve();expect(closed).toBe(false)
  release.resolve();await closing
  expect(await observed).toBeInstanceOf(Error);expect(transports).toBe(0);expect(service.liveSession('main')).toBeUndefined()
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation'||event.type==='context/action')).toEqual([])
  // Only acknowledged close releases the original cache incarnation.
  const inputs=await service.receivedInputFor('main')
  await inputs.admit({inputId:'after-close',text:'next',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  expect(inputs.pending().map(input=>input.text)).toEqual(['held','next'])
 }finally{release.resolve();await observed;await service.close();await coordinator.close()}
},30000)

it('service publishes the genuine private runtime after cache acquisition before model resolution',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-service-'))
 await writeFile(join(root,'AGENTS.md'),'OWNED_TOOL_INSTRUCTION')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 let effects=0
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'probe',function:{name:'probe',arguments:'{}'}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async(response,request)=>{expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]));response.end(wire(false))}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original system',tools:[{name:'probe',description:'controlled original body',inputSchema:{type:'object'},async execute(_args,exec){expect(exec.session).toBeUndefined();effects++;return 'original result'}}]},modelBuilder:async()=>{expect(coordinator.openManagedDocument).not.toHaveBeenCalled();return createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})},contextWindow:4096,maxOutputTokens:128})
 const opened=vi.spyOn(coordinator,'openManagedDocument').mockImplementation(async()=>{throw Error('Service opened complete public document')})
 try{await service.submit('main','probe then report',new AbortController().signal);expect(effects).toBe(1);expect(server.requests).toHaveLength(2);expect(JSON.stringify(server.requests[0]!.body)).toContain('OWNED_TOOL_INSTRUCTION');expect(JSON.stringify(server.requests[1]!.body)).toContain('OWNED_TOOL_INSTRUCTION');expect(opened).not.toHaveBeenCalled();expect(service.liveSession('main')).toBeUndefined()}
 finally{await service.close();opened.mockRestore();await coordinator.close();await server.close()}
},30000)

it('service prepares a queued human input before original model construction and adopts it once',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-prepare-'))
 const backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},modelBuilder:async()=>createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','raw',new AbortController().signal)
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation').map(event=>event.op)).toEqual(['started','completed','promoted'])
  expect(server.requests).toHaveLength(1)
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('service publishes project instructions into the original physical request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-instructions-'))
 await writeFile(join(root,'AGENTS.md'),'OWNED_PHYSICAL_INSTRUCTION')
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','read instruction',new AbortController().signal)
  expect(JSON.stringify(server.requests[0]!.body)).toContain('OWNED_PHYSICAL_INSTRUCTION')
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('service transforms the original human input once before its physical request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-transform-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 let transforms=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],prepareInput:async text=>{transforms++;return text+' TRANSFORMED_ONCE'}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','raw',new AbortController().signal)
  expect(transforms).toBe(1)
  expect(JSON.stringify(server.requests[0]!.body)).toContain('TRANSFORMED_ONCE')
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation'&&event.op==='completed')).toEqual([expect.objectContaining({observations:[expect.objectContaining({producer:'host-preparation',text:'raw TRANSFORMED_ONCE'})]})])
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('stopping a held original host preparation prevents the physical model request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-stop-prepare-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 let requests=0
 const model={async *stream(){requests++;throw Error('Unexpected physical request')}}
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],prepareInput:async text=>{entered.resolve();await release.promise;return text}},model,contextWindow:4096,maxOutputTokens:128})
 const controller=new AbortController(),turn=service.submit('main','held',controller.signal).catch(error=>error)
 try{
  await entered.promise;controller.abort();release.resolve();await turn
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(requests).toBe(0)
  expect(events.filter(event=>event.type==='agent/input/preparation').map(event=>event.op)).toEqual(['started','failed'])
 }finally{release.resolve();await turn;await service.close();await coordinator.close()}
},30000)

it('a rejected original host preparation records failure and never sends a model request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-reject-prepare-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 let requests=0
 const model={async *stream(){requests++;throw Error('Unexpected physical request')}}
 const refusal=Error('host preparation rejected')
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],prepareInput:async()=>{throw refusal}},model,contextWindow:4096,maxOutputTokens:128})
 try{
  await expect(service.submit('main','raw',new AbortController().signal)).rejects.toBe(refusal)
  expect(requests).toBe(0)
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation').map(event=>event.op)).toEqual(['started','failed'])
 }finally{await service.close();await coordinator.close()}
},30000)

it('service persists original supplemental context in its prepared input and physical request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-supplemental-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','raw',new AbortController().signal,{context:'SUPPLEMENTAL_CONTEXT'})
  expect(JSON.stringify(server.requests[0]!.body)).toContain('SUPPLEMENTAL_CONTEXT')
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation'&&event.op==='completed')).toEqual([expect.objectContaining({observations:[expect.objectContaining({producer:'supplemental-context',text:'SUPPLEMENTAL_CONTEXT'})]})])
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('retries the same admitted input after one managed constructor failure',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-constructor-retry-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 let builds=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},modelBuilder:async()=>{builds++;if(builds===1)throw Error('first construction failed');return createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})},contextWindow:4096,maxOutputTokens:128})
 try{
  await expect(service.submit('main','same input',new AbortController().signal)).rejects.toThrow('first construction failed')
  await service.closeSession('main')
  const inbox=await service.receivedInputFor('main'),input=inbox.pending().find(value=>value.text==='same input')!
  expect(input).toBeDefined()
  await service.submit('main',input.text,new AbortController().signal,{admittedInputId:input.inputId})
  expect(builds).toBe(2);expect(server.requests).toHaveLength(1)
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation').map(event=>event.op)).toEqual(['started','completed','promoted'])
  expect(events.filter(event=>event.type==='context/action'&&event.op==='open')).toHaveLength(1)
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)


it('direct managed constructor uses the supplied genuine request context with workspace',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-supplied-context-'))
 await writeFile(join(root,'AGENTS.md'),'SUPPLIED_CONTEXT_RULE')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const environment=createProjectInstructionEnvironment()
 let manager!:ReturnType<typeof createMainInstructionManager>,reconciles=0
 const retained:(()=>Promise<void>)[]=[]
 const requestContext:NonNullable<import('@i-harness/core-agent').ManagedAgentHost['requestContext']>={
  async reconcile(signal){reconciles++;await manager.reconcile(signal)},capture:()=>manager.capture(),current:evidence=>manager.current(evidence),retain:evidence=>manager.retain(evidence),
  managedSucceeded:handoff=>manager.managedSucceeded(handoff),promotedHumanRequest:()=>manager.promotedHumanRequest(),close:()=>manager.close(),
 }
 const create=Reflect.get(assembly,'createManagedExecutionRuntime')
 const runtime=create({execution:entry.execution,workspace:root,requestContext,retainConstructionCleanup:(cleanup:()=>Promise<void>)=>{retained.push(cleanup)},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'system',tools:[],contextWindow:4096,maxOutputTokens:128})
 const context=createExecutionRuntimeContext(entry.execution,runtime.domain)
 manager=createMainInstructionManager({domain:runtime.domain,environment,cwd:root,authority:()=>({kind:'unbound',revision:'configured-workspace',workspaceRoot:root}),available:()=>true,publish:(signal,retain)=>context.render(signal,retain)})
 context.registerSection('instructions',()=>manager.text())
 try{
  await entry.inputs.inbox.admit({inputId:'original',text:'test',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('original')
  expect(reconciles).toBeGreaterThan(0);expect(retained).toHaveLength(0)
  expect(JSON.stringify(server.requests[0]!.body)).toContain('SUPPLIED_CONTEXT_RULE')
 }finally{await runtime.close();for(const cleanup of retained)await cleanup();await manager.close();await context.close();await environment.close();await cache.closeAll();await coordinator.close();await server.close()}
},30000)

it('owned filesystem composition runs the original read body and continues the physical request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-fs-read-'))
 await writeFile(join(root,'input.txt'),'ORIGINAL_FS_CONTENT')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'fs-read',function:{name:'read',arguments:JSON.stringify({path:'input.txt'})}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async(response,request)=>{expect(JSON.stringify(request.body.tools)).toContain('"name":"read"');response.end(wire(true))},async(response,request)=>{expect(JSON.stringify(request.body.messages)).toContain('ORIGINAL_FS_CONTENT');response.end(wire(false))}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],originalFilesystem:true},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{await service.submit('main','read the file',new AbortController().signal);expect(server.requests).toHaveLength(2)}finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('owned filesystem denies an unapproved original write before the body',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-fs-deny-'))
 const target=join(root,'denied.txt')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'fs-write',function:{name:'apply_patch',arguments:JSON.stringify({patch_content:'*** Begin Patch\n*** Add File: denied.txt\n+SHOULD_NOT_EXIST\n*** End Patch'})}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],originalFilesystem:true},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await expect(service.submit('main','write the file',new AbortController().signal)).rejects.toThrow('approval required but no answerer registered')
  expect(server.requests).toHaveLength(1)
  await expect(import('node:fs/promises').then(fs=>fs.stat(target))).rejects.toMatchObject({code:'ENOENT'})
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('owned original workspace write changes instructions before the model continuation',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-fs-write-'))
 await writeFile(join(root,'AGENTS.md'),'OLD_NATIVE_RULE')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'fs-write',function:{name:'write',arguments:JSON.stringify({path:'AGENTS.md',text:'NEW_NATIVE_RULE'})}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))}])
 let approvals=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],originalFilesystem:true,async mount(ctx){registerApprovalAnswerer(ctx,async()=>{approvals++;return {approved:true}})}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','update instructions',new AbortController().signal)
  expect(approvals).toBe(0);expect(server.requests).toHaveLength(2)
  expect(await import('node:fs/promises').then(fs=>fs.readFile(join(root,'AGENTS.md'),'utf8'))).toBe('NEW_NATIVE_RULE')
  expect(JSON.stringify(server.requests[1]!.body.messages)).toContain('NEW_NATIVE_RULE')
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('owned schedule dispatches an original timer input through the managed service lane',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-schedule-timer-'))
 const {createScheduleFoldSink}=await import('@i-harness/schedule')
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createScheduleFoldSink},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'schedule-create',function:{name:'schedule_create',arguments:JSON.stringify({prompt:'TIMER_ORIGINAL_INPUT',after_seconds:1})}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const delivered=Promise.withResolvers<void>()
 const hasReminder=(body:unknown)=>((body as {messages?:{role:string;content:unknown}[]}).messages??[]).some(message=>message.role==='user'&&typeof message.content==='string'&&message.content.includes('[SCHEDULE REMINDER]')&&message.content.includes('TIMER_ORIGINAL_INPUT'))
 const finish=async(response:import('node:http').ServerResponse,request:{body:unknown})=>{if(hasReminder(request.body))delivered.resolve();response.end(wire(false))}
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},finish,finish])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:({systemPrompt:'system',tools:[],originalSchedule:true,async mount(ctx){registerApprovalAnswerer(ctx,async()=>({approved:true}))}} as NonNullable<import('../src/service.ts').SessionServiceOptions['managedRuntime']> & {originalSchedule:boolean}),model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 let notifications=0;const off=service.onExecutionState!(()=>{notifications++})
 try{
  await service.submit('main','schedule a reminder',new AbortController().signal)
  await Promise.race([delivered.promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Scheduled original input did not reach model')),10000))])
  expect(server.requests.some(request=>hasReminder(request.body))).toBe(true)
  await vi.waitFor(()=>expect(service.inspectActivity!('main').running).toBe(false),{timeout:10000})
  await service.closeSession('main')
  const events=(await backend.read('main')).events;const dispatch=events.find(event=>event.type==='schedule/change'&&event.operation==='dispatch')
  expect(dispatch).toBeDefined();expect(events[dispatch!.seq!+1]).toMatchObject({type:'agent/input/admitted',intent:'system',provenance:{producer:'session.schedule'}});expect(notifications).toBeGreaterThan(0)
  const scheduled=events.filter(event=>event.type==='agent/input/admitted'&&event.provenance?.producer==='session.schedule')
  expect(events.filter(event=>event.type==='schedule/change'&&event.operation==='dispatch')).toHaveLength(1)
  expect(scheduled).toHaveLength(1)
  const scheduledInput=scheduled[0]
  if(scheduledInput?.type!=='agent/input/admitted')throw Error('Scheduled input missing')
  expect(events.filter(event=>event.type==='agent/input/promoted'&&event.inputId===scheduledInput.inputId)).toHaveLength(1)
  expect(server.requests.filter(request=>hasReminder(request.body))).toHaveLength(1)
 }finally{off();await service.close();await coordinator.close();await server.close()}
},75000)

it('stopping during the original filesystem approval await prevents the native write',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-fs-stop-approval-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'patch',function:{name:'apply_patch',arguments:JSON.stringify({patch_content:'*** Begin Patch\n*** Add File: held.txt\n+MUST_NOT_WRITE\n*** End Patch'})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),controller=new AbortController()
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],originalFilesystem:true,async mount(ctx){registerApprovalAnswerer(ctx,async()=>{entered.resolve();await release.promise;return {approved:true}})}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 const turn=service.submit('main','patch',controller.signal).catch(error=>error)
 try{await entered.promise;controller.abort();release.resolve();await turn;await expect(import('node:fs/promises').then(fs=>fs.stat(join(root,'held.txt')))).rejects.toMatchObject({code:'ENOENT'});expect(server.requests).toHaveLength(1)}
 finally{release.resolve();await turn;await service.close();await coordinator.close();await server.close()}
},30000)

it('reentrant execution-state close joins the original queued turn without model work',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-queue-close-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 let requests=0,closing:Promise<void>|undefined
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model:{async *stream(){requests++;throw Error('Unexpected request')}},contextWindow:4096,maxOutputTokens:128})
 const off=service.onExecutionState!(state=>{if(state.sessionId==='main'&&!closing)closing=service.closeSession('main')})
 try{await service.submit('main','close now',new AbortController().signal);expect(closing).toBeDefined();await closing;expect(requests).toBe(0)}finally{off();await service.close();await coordinator.close()}
},30000)

it('a throwing request telemetry observer does not orphan or hide the original turn',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-queue-telemetry-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const telemetry:import('@i-harness/telemetry').Telemetry={emit(event){if(event.type==='session/request')throw Error('observer failed')},close(){}}
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},telemetry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{await service.submit('main','run',new AbortController().signal);expect(server.requests).toHaveLength(1);await service.closeSession('main')}finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('owned schedule timer wakes an idle archived service once at its original deadline',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-schedule-idle-'))
 const {createScheduleFoldSink}=await import('@i-harness/schedule')
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createScheduleFoldSink},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'schedule-idle',function:{name:'schedule_create',arguments:JSON.stringify({prompt:'IDLE_TIMER_ORIGINAL',after_seconds:25})}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const delivered=Promise.withResolvers<void>(),settled=Promise.withResolvers<void>();let idle=false,firstAt=0,received=false
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{firstAt=Date.now();response.end(wire(true))},async response=>{response.end(wire(false))},async(response,request)=>{expect(Date.now()-firstAt).toBeGreaterThanOrEqual(25000);expect(idle).toBe(true);const messages=request.body.messages as {role:string;content:unknown}[];expect(messages.some(message=>message.role==='user'&&typeof message.content==='string'&&message.content.includes('[SCHEDULE REMINDER]')&&message.content.includes('IDLE_TIMER_ORIGINAL'))).toBe(true);received=true;delivered.resolve();response.end(wire(false))}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],originalSchedule:true,async mount(ctx){registerApprovalAnswerer(ctx,async()=>({approved:true}))}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 const off=service.onExecutionState!(state=>{if(received&&!state.running&&state.queued===0)settled.resolve()})
 try{
  await service.submit('main','schedule an idle reminder',new AbortController().signal);idle=true
  expect(service.hasAssembly('main')).toBe(false)
  expect(service.inspectActivity!('main')).toMatchObject({live:true,running:false,active:true})
  const management=createSessionManagement(coordinator,service,async()=>true)
  await management.mutate('main','archive')
  expect((await coordinator.profile('main')).meta.archived).toBe(true)
  expect(service.inspectActivity!('main')).toMatchObject({live:true,running:false,active:true})
  expect(server.requests).toHaveLength(2)
  expect(Date.now()-firstAt).toBeLessThan(25000)
  await Promise.race([delivered.promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Idle timer did not reach model')),45000))])
  expect(server.requests).toHaveLength(3);await settled.promise
  await management.mutate('main','restore')
  expect((await coordinator.profile('main')).meta.archived).toBe(false)
  await service.closeSession('main')
  const events=(await backend.read('main')).events,dispatch=events.find(event=>event.type==='schedule/change'&&event.operation==='dispatch')
  expect(dispatch).toBeDefined();const admitted=events[dispatch!.seq!+1];expect(admitted).toMatchObject({type:'agent/input/admitted',intent:'system',provenance:{producer:'session.schedule'}})
  expect(events.filter(event=>event.type==='schedule/change'&&event.operation==='dispatch')).toHaveLength(1)
  if(!admitted||admitted.type!=='agent/input/admitted')throw Error('Original scheduled admission missing')
  expect(events.some(event=>event.type==='agent/input/promoted'&&event.inputId===admitted.inputId)).toBe(true)
 }finally{off();await service.close();await coordinator.close();await server.close()}
},75000)

it('deleting an owned schedule cancels its original deadline timer',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-schedule-cancel-')),{createScheduleFoldSink}=await import('@i-harness/schedule')
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createScheduleFoldSink},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(name?:string,args?:unknown)=>`data: ${JSON.stringify({choices:[{delta:name?{tool_calls:[{index:0,id:name,function:{name,arguments:JSON.stringify(args)}}]}:{content:'done'},finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 let deadline=0
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire('schedule_create',{prompt:'CANCELLED_TIMER',after_seconds:25}))},async(response,request)=>{const messages=request.body.messages as {role:string;content:string}[];const result=messages.find(message=>message.role==='tool'&&message.content.includes('schedule-1'));if(!result)throw Error('Original schedule creation result missing');deadline=Date.parse(JSON.parse(result.content).scheduledAt);response.end(wire('schedule_delete',{id:'schedule-1'}))},async response=>{response.end(wire())}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],originalSchedule:true,async mount(ctx){registerApprovalAnswerer(ctx,async()=>({approved:true}))}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','create then delete reminder',new AbortController().signal)
  expect(deadline).toBeGreaterThan(Date.now())
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,deadline-Date.now()+1000)))
  expect(server.requests).toHaveLength(3)
  await service.closeSession('main');const events=(await backend.read('main')).events
  expect(events.some(event=>event.type==='schedule/change'&&event.operation==='delete')).toBe(true)
  expect(events.some(event=>event.type==='schedule/change'&&event.operation==='dispatch')).toBe(false)
 }finally{await service.close();await coordinator.close();await server.close()}
},75000)

it('closing an owned schedule stops its original deadline timer',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-schedule-stop-')),{createScheduleFoldSink}=await import('@i-harness/schedule')
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createScheduleFoldSink},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'schedule-stop',function:{name:'schedule_create',arguments:JSON.stringify({prompt:'STOPPED_TIMER',after_seconds:25})}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 let deadline=0
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async(response,request)=>{const messages=request.body.messages as {role:string;content:string}[];const result=messages.find(message=>message.role==='tool'&&message.content.includes('schedule-1'));if(!result)throw Error('Original schedule creation result missing');deadline=Date.parse(JSON.parse(result.content).scheduledAt);response.end(wire(false))}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],originalSchedule:true,async mount(ctx){registerApprovalAnswerer(ctx,async()=>({approved:true}))}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','schedule then stop',new AbortController().signal);expect(deadline).toBeGreaterThan(Date.now())
  await service.closeSession('main');await new Promise(resolve=>setTimeout(resolve,Math.max(0,deadline-Date.now()+1000)))
  expect(server.requests).toHaveLength(2);const events=(await backend.read('main')).events
  expect(events.some(event=>event.type==='schedule/change'&&event.operation==='dispatch')).toBe(false)
 }finally{await service.close();await coordinator.close();await server.close()}
},75000)
