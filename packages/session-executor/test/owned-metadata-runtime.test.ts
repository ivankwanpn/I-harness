import {expect,it,vi} from 'vitest'
const journalProbe=vi.hoisted(()=>({unknown:false,unknownReconcile:false,appends:0,reconciles:0,titleUnknown:false,titleHold:0}))
const captureProbe=vi.hoisted(()=>({gate:undefined as undefined|{entered:()=>void;wait:Promise<void>}}))
const sourceProbe=vi.hoisted(()=>({failClose:false}))
const titleGuardProbe=vi.hoisted(()=>({active:false}))
vi.mock('../../session-persistence/src/coordinator/settlement-source.ts',async original=>{const module=await original<typeof import('../../session-persistence/src/coordinator/settlement-source.ts')>();return {...module,createSettlementSource(...args:Parameters<typeof module.createSettlementSource>){const source=module.createSettlementSource(...args),close=source.close.bind(source);source.close=()=>{if(sourceProbe.failClose){sourceProbe.failClose=false;return Promise.reject(false)}return close()};return source}}})
vi.mock('../../session-persistence/src/coordinator/action-captures.ts',async original=>{const module=await original<typeof import('../../session-persistence/src/coordinator/action-captures.ts')>();return {...module,createActionCaptures(...args:Parameters<typeof module.createActionCaptures>){const captures=module.createActionCaptures(...args);return {...captures,captureMetadata(event:Parameters<NonNullable<typeof captures.captureMetadata>>[0],check?:()=>boolean){const guarded=event.type==='session/title'&&check?()=>{titleGuardProbe.active=true;try{return check()}finally{titleGuardProbe.active=false}}:check;const fact=captures.captureMetadata!(event,guarded);if(event.type==='session/title'&&journalProbe.titleUnknown){journalProbe.titleUnknown=false;return {async admit(){journalProbe.unknown=true;return fact.admit()},reconcile:()=>fact.reconcile(),observe:()=>fact.observe()}}if(event.type!=='goal/change'||event.operation!=='complete'||!captureProbe.gate)return fact;const gate=captureProbe.gate;captureProbe.gate=undefined;return {...fact,async admit(){gate.entered();await gate.wait;return fact.admit()}}}}}}})
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async original=>{const module=await original<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...module,createFactJournalBackend(...args:Parameters<typeof module.createFactJournalBackend>){const backend=module.createFactJournalBackend(...args);return {...backend,async appendOwnedBatch(...values:Parameters<typeof backend.appendOwnedBatch>){const result=await backend.appendOwnedBatch(...values);if(journalProbe.unknown&&result.kind==='committed'){journalProbe.unknown=false;journalProbe.appends++;return {kind:'unknown' as const,key:values[3].key}}return result},async reconcileOwnedBatch(...values:Parameters<typeof backend.reconcileOwnedBatch>){journalProbe.reconciles++;if(journalProbe.titleHold>0){journalProbe.titleHold--;return {kind:'unknown' as const,key:values[3].key}}if(journalProbe.unknownReconcile){journalProbe.unknownReconcile=false;return {kind:'unknown' as const,key:values[3].key}}return backend.reconcileOwnedBatch(...values)}}}}})
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,open:vi.fn(fs.open)}})
import {mkdtemp} from 'node:fs/promises'
import {open} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createExecutorExecutionCache} from '../src/durable-session.ts'
import {createManagedExecutionRuntime} from '../src/managed-assembly.ts'
import {createOwnedMetadataFold} from '../src/lifecycle/owned-metadata-fold.ts'
import {createOwnedMetadataContext} from '../src/lifecycle/owned-metadata-context.ts'
import {createDesktopOwnedGoalTools} from '../../desktop-gateway/src/workflow.ts'
import {actionMetadataFacts} from '../src/lifecycle/action-facts.ts'
import {committedFactSeqs} from '@i-harness/core-session'
import {applyGoalMutation} from '../../goal/src/index.ts'

it('retains the Goal primary failure when original source close also fails',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'goal-close-failure-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),metadata=createOwnedMetadataContext(entry.execution)
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 try{
  committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective:'verify',phase:'active'}}))
  captureProbe.gate={entered:entered.resolve,wait:release.promise}
  const completing=metadata.goalPort.complete({id:'g',revision:1}).then(()=>undefined,error=>error)
  await entered.promise
  committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit(applyGoalMutation(metadata.goalPort.read(),'edit',{ref:{id:'g',revision:1},objective:'revised'},2).event))
  sourceProbe.failClose=true;release.resolve()
  const error=await completing
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors[0]).toMatchObject({code:'FACT_PRECONDITION_STALE'})
  expect(error.errors[1]).toBe(false)
  await metadata.close()
 }finally{sourceProbe.failClose=false;captureProbe.gate=undefined;release.resolve();await cache.closeAll();await coordinator.close()}
},30000)

it('retains unresolved Goal capture for close to reconcile without a second write',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'goal-debt-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),metadata=createOwnedMetadataContext(entry.execution)
 try{
  committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective:'verify',phase:'active'}}))
  journalProbe.appends=0;journalProbe.reconciles=0;journalProbe.unknown=true;journalProbe.unknownReconcile=true
  await expect(metadata.goalPort.complete({id:'g',revision:1})).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
  await expect(metadata.goalPort.complete({id:'g',revision:1})).rejects.toThrow(/recovery required/i)
  await metadata.close()
  expect(journalProbe.appends).toBe(1);expect(journalProbe.reconciles).toBe(2)
  expect(metadata.goalPort.read()).toMatchObject({phase:'complete',revision:2})
  expect((await backend.read('main')).events.filter(event=>event.type==='goal/change'&&event.operation==='complete')).toHaveLength(1)
 }finally{journalProbe.unknown=false;journalProbe.unknownReconcile=false;await cache.closeAll();await coordinator.close()}
},30000)

it('rejects a retained Goal capture after a competing revision before issue',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'goal-capture-stale-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),metadata=createOwnedMetadataContext(entry.execution)
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 try{
  committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective:'verify',phase:'active'}}))
  captureProbe.gate={entered:entered.resolve,wait:release.promise}
  const completing=metadata.goalPort.complete({id:'g',revision:1}).then(()=>undefined,error=>error)
  await entered.promise
  const edit=applyGoalMutation(metadata.goalPort.read(),'edit',{ref:{id:'g',revision:1},objective:'revised'},2).event
  committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit(edit))
  release.resolve()
  expect(await completing).toMatchObject({code:'FACT_PRECONDITION_STALE'})
  expect(metadata.goalPort.read()).toMatchObject({phase:'active',revision:2})
  expect((await backend.read('main')).events.filter(event=>event.type==='goal/change'&&event.operation==='complete')).toHaveLength(0)
  await metadata.close()
 }finally{captureProbe.gate=undefined;release.resolve();await cache.closeAll();await coordinator.close()}
},30000)

it('reconciles an unknown Goal completion on the same original capture',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'goal-unknown-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),metadata=createOwnedMetadataContext(entry.execution)
 try{
  committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective:'verify',phase:'active'}}))
  journalProbe.appends=0;journalProbe.reconciles=0;journalProbe.unknown=true
  expect(await metadata.goalPort.complete({id:'g',revision:1})).toMatchObject({phase:'complete',revision:2})
  expect(journalProbe.appends).toBe(1);expect(journalProbe.reconciles).toBe(1)
  expect((await backend.read('main')).events.filter(event=>event.type==='goal/change'&&event.operation==='complete')).toHaveLength(1)
  await metadata.close()
 }finally{journalProbe.unknown=false;await cache.closeAll();await coordinator.close()}
},30000)

it('refuses Goal completion while a competing write is unacknowledged',async()=>{
 const native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'goal-stale-')),path=join(root,'main.jsonl')
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),metadata=createOwnedMetadataContext(entry.execution)
 committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective:'verify',phase:'active'}}))
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let armed=true
 vi.mocked(open).mockImplementation(async (...args)=>{const handle=await native.open(...args);if(!armed||String(args[0])!==path||args[1]!=='r+')return handle;let wrote=false;return new Proxy(handle,{get(target,key){if(key==='write')return async(...values:Parameters<typeof target.write>)=>{wrote=true;return target.write(...values)};if(key==='sync')return async()=>{if(wrote&&armed){armed=false;entered.resolve();await release.promise}await target.sync()};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})})
 try{
  const edit=applyGoalMutation(metadata.goalPort.read(),'edit',{ref:{id:'g',revision:1},objective:'revised'},2).event
  const changing=actionMetadataFacts(entry.execution.owner).admit(edit)
  await entered.promise
  const completing=metadata.goalPort.complete({id:'g',revision:1}).then(()=>undefined,error=>error)
  release.resolve();committedFactSeqs(await changing)
  expect(await completing).toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
  expect(metadata.goalPort.read()).toMatchObject({phase:'active',revision:2,objective:'revised'})
  await expect(metadata.goalPort.complete({id:'g',revision:1})).rejects.toMatchObject({code:'goal-stale-ref'})
  expect((await backend.read('main')).events.filter(event=>event.type==='goal/change'&&event.operation==='complete')).toHaveLength(0)
  await metadata.close()
 }finally{release.resolve();vi.mocked(open).mockImplementation(native.open);await cache.closeAll();await coordinator.close()}
},30000)

it('retains the same guarded Goal capture while close waits for its held durable write',async()=>{
 const native=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'goal-close-')),path=join(root,'main.jsonl')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),metadata=createOwnedMetadataContext(entry.execution)
 committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective:'verify',phase:'active'}}))
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 let armed=true,writes=0
 vi.mocked(open).mockImplementation(async (...args)=>{const handle=await native.open(...args);if(String(args[0])!==path||args[1]!=='r+')return handle;let wrote=false;return new Proxy(handle,{get(target,key){if(key==='write')return async(...values:Parameters<typeof target.write>)=>{wrote=true;return target.write(...values)};if(key==='sync')return async()=>{if(wrote){writes++;if(armed){armed=false;entered.resolve();await release.promise}}await target.sync()};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})})
 try{
  const completing=metadata.goalPort.complete({id:'g',revision:1})
  await entered.promise
  let closed=false;const closing=metadata.close().then(()=>{closed=true})
  await Promise.resolve();expect(closed).toBe(false)
  release.resolve();await completing;await closing
  expect(writes).toBe(1)
  expect(metadata.goalPort.read()).toMatchObject({phase:'complete',revision:2})
 }finally{release.resolve();vi.mocked(open).mockImplementation(native.open);await cache.closeAll();await coordinator.close()}
},30000)

it('uses original owned goal tools and observes completion in the next request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'goal-runtime-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),metadata=createOwnedMetadataContext(entry.execution)
 committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective:'verify work',phase:'active'}}))
 const wire=(name?:string)=>`data: ${JSON.stringify({choices:[{delta:name?{tool_calls:[{index:0,id:name,function:{name,arguments:name==='goal_read'?'{}':JSON.stringify({id:'g',revision:1})}}]}:{content:'done'},finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('goal_read'))},async r=>{r.end(wire('goal_complete'))},async r=>{r.end(wire())}])
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:()=>metadata.prompt('system'),tools:createDesktopOwnedGoalTools(metadata.goalPort,()=>{})})
  await entry.inputs.inbox.admit({inputId:'input',text:'verify',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input')
  expect(JSON.stringify(server.requests[0]!.body)).toContain('Current goal (active, id g, revision 1)')
  expect(JSON.stringify(server.requests[2]!.body)).toContain('Current goal (complete, id g, revision 2)')
  expect(metadata.goalPort.read()).toMatchObject({phase:'complete',revision:2})
  await metadata.close()
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close();await server.close()}
},30000)

it('projects a real Todo tool write into the next actual request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'metadata-runtime-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),metadata=createOwnedMetadataContext(entry.execution)
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'todo',function:{name:'todo_write',arguments:JSON.stringify({todos:[{content:'real work',status:'pending'}]})}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))}])
 try{
  const runtime=createManagedExecutionRuntime({execution:entry.execution,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:()=>metadata.prompt('system'),tools:[metadata.todoTool]})
  await entry.inputs.inbox.admit({inputId:'input',text:'plan',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input')
  expect(JSON.stringify(server.requests[0]!.body)).not.toContain('Authoritative Todo state')
  expect(JSON.stringify(server.requests[1]!.body)).toContain('Authoritative Todo state')
  expect(JSON.stringify(server.requests[1]!.body)).toContain('real work')
  expect(server.requests[1]!.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]))
  await metadata.close()
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close();await server.close()}
},30000)

it('runs owned title through an original action and persists its generation and title',async()=>{
 const {runOwnedPostTurn}=await import('../src/service/owned-post-turn.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'title-real-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const input=entry.execution.owner.beginAction()
 try{committedFactSeqs(await input.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text:'Build a queue',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}},()=>true).admit())}finally{input.finish()}
 let requestBody:unknown
 const server=await createLoopbackProvider('/v1/chat/completions',[async (response,request)=>{requestBody=request.body;response.end(`data: ${JSON.stringify({choices:[{delta:{content:'Queue builder'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}`+`\n\ndata: [DONE]\n\n`)}])
 try{
  const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
  await runOwnedPostTurn({execution:entry.execution,sessionId:'main',signal:new AbortController().signal,model,selectedClient:()=>model,localTestEnabled:true,titleMaxOutputTokens:32,assertCurrent(){},retainCleanup(){return ()=>{}}})
  const events=(await backend.read('main')).events
  expect(entry.execution.observe().metadata.title).toMatchObject({kind:'available',snapshot:{candidate:expect.anything()}})
  expect(events).toContainEqual(expect.objectContaining({type:'context/action',op:'open',purpose:'title',origin:{kind:'input',seq:1}}))
  expect(requestBody).toMatchObject({model:'fixture',max_tokens:32})
  expect(events.filter(e=>e.type==='session/title')).toMatchObject([{title:'Queue builder',source:'provider'}])
 }finally{await server.close();await cache.closeAll();await coordinator.close()}
},30000)

it('owned title rejects a competing eligible source during held transport',async()=>{
 const {runOwnedPostTurn}=await import('../src/service/owned-post-turn.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'title-stale-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const add=async(text:string)=>{const action=entry.execution.owner.beginAction();try{return committedFactSeqs(await action.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text,provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}},()=>true).admit())}finally{action.finish()}}
 await add('first')
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{entered.resolve();await release.promise;response.end(`data: ${JSON.stringify({choices:[{delta:{content:'Old title'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)}])
 try{
  const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
  const running=runOwnedPostTurn({execution:entry.execution,sessionId:'main',signal:new AbortController().signal,model,selectedClient:()=>model,assertCurrent(){},retainCleanup(){return ()=>{}}}).then(()=>null,error=>error)
  await entered.promise;await add('competing');release.resolve()
  expect(await running).toBeTruthy()
  expect((await backend.read('main')).events.filter(e=>e.type==='session/title')).toHaveLength(0)
 }finally{release.resolve();await server.close();await cache.closeAll();await coordinator.close()}
},30000)

it('owned title issues no request for no message or an explicit empty title',async()=>{
 const {runOwnedPostTurn}=await import('../src/service/owned-post-turn.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'title-empty-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 let calls=0
 const model={async *stream(){calls++;yield {type:'end' as const}}}
 const options={execution:entry.execution,sessionId:'main',signal:new AbortController().signal,model,selectedClient:()=>model,assertCurrent(){},retainCleanup(){return ()=>{}}}
 try{
  await runOwnedPostTurn(options)
  const action=entry.execution.owner.beginAction()
  try{committedFactSeqs(await action.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text:'work',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}},()=>true).admit())}finally{action.finish()}
  committedFactSeqs(await actionMetadataFacts(entry.execution.owner).admit({type:'session/title',title:'',source:'user',messageSeqs:[]}))
  await runOwnedPostTurn(options)
  expect(calls).toBe(0)
  expect((await backend.read('main')).events.filter(e=>e.type==='session/title')).toHaveLength(1)
 }finally{await cache.closeAll();await coordinator.close()}
},30000)

it('owned title reconciles the same guarded metadata capture after an unknown acknowledgement',async()=>{
 const {runOwnedPostTurn}=await import('../src/service/owned-post-turn.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'title-ack-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const action=entry.execution.owner.beginAction()
 try{committedFactSeqs(await action.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text:'work',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}},()=>true).admit())}finally{action.finish()}
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(`data: ${JSON.stringify({choices:[{delta:{content:'Work'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)}])
 try{
  const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
  journalProbe.appends=0;journalProbe.reconciles=0;journalProbe.titleUnknown=true
  await runOwnedPostTurn({execution:entry.execution,sessionId:'main',signal:new AbortController().signal,model,selectedClient:()=>model,assertCurrent(){},retainCleanup(){return ()=>{}}})
  expect(journalProbe.appends).toBe(1);expect(journalProbe.reconciles).toBe(1)
  expect((await backend.read('main')).events.filter(e=>e.type==='session/title')).toHaveLength(1)
 }finally{journalProbe.titleUnknown=false;journalProbe.unknown=false;await server.close();await cache.closeAll();await coordinator.close()}
},30000)

it('owned title retains unresolved metadata cleanup until the same capture reconciles',async()=>{
 const {createOwnedPostTurnLifetime}=await import('../src/service/owned-post-turn.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'title-debt-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const action=entry.execution.owner.beginAction()
 try{committedFactSeqs(await action.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text:'work',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}},()=>true).admit())}finally{action.finish()}
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(`data: ${JSON.stringify({choices:[{delta:{content:'Work'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)}])
 const lifetime=createOwnedPostTurnLifetime()
 try{
  const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
  journalProbe.appends=0;journalProbe.reconciles=0;journalProbe.titleUnknown=true;journalProbe.titleHold=2
  await expect(lifetime.run({execution:entry.execution,sessionId:'main',signal:new AbortController().signal,model,selectedClient:()=>model,assertCurrent(){}})).rejects.toBeDefined()
  await lifetime.close()
  expect(journalProbe.appends).toBe(1);expect(journalProbe.reconciles).toBeGreaterThanOrEqual(2)
  expect((await backend.read('main')).events.filter(e=>e.type==='session/title')).toHaveLength(1)
 }finally{journalProbe.titleUnknown=false;journalProbe.unknown=false;journalProbe.unknownReconcile=false;journalProbe.titleHold=0;await server.close();await cache.closeAll();await coordinator.close()}
},30000)

it('owned title denies publication when its original task is stopped during transport',async()=>{
 const {runOwnedPostTurn}=await import('../src/service/owned-post-turn.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'title-stop-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const action=entry.execution.owner.beginAction()
 try{committedFactSeqs(await action.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text:'work',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}},()=>true).admit())}finally{action.finish()}
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),controller=new AbortController()
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{entered.resolve();await release.promise;response.end(`data: ${JSON.stringify({choices:[{delta:{content:'old'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)}])
 try{
  const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
  const running=runOwnedPostTurn({execution:entry.execution,sessionId:'main',signal:controller.signal,model,selectedClient:()=>model,assertCurrent(){},retainCleanup(){return ()=>{}}}).then(()=>null,error=>error)
  await entered.promise;controller.abort();release.resolve()
  expect(await running).toBeTruthy();expect((await backend.read('main')).events.filter(e=>e.type==='session/title')).toHaveLength(0)
 }finally{release.resolve();await server.close();await cache.closeAll();await coordinator.close()}
},30000)

it('owned title preserves a falsey primary when required generation cleanup fails',async()=>{
 const {runOwnedPostTurn}=await import('../src/service/owned-post-turn.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'title-cleanup-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const action=entry.execution.owner.beginAction()
 try{committedFactSeqs(await action.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text:'work',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}},()=>true).admit())}finally{action.finish()}
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{entered.resolve();await release.promise;response.end(`data: ${JSON.stringify({choices:[{delta:{content:'old'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)}])
 let active=true,retained:(()=>Promise<void>)|undefined
 try{
  const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
  const running=runOwnedPostTurn({execution:entry.execution,sessionId:'main',signal:new AbortController().signal,model,selectedClient:()=>model,assertCurrent(){if(!active)throw false},retainCleanup(fn){retained=fn;return ()=>{retained=undefined}}}).then(()=>null,error=>error)
  await entered.promise;active=false;sourceProbe.failClose=true;release.resolve()
  const error=await running;expect(error).toBeInstanceOf(AggregateError);expect(error.errors[0]).toBe(false);expect(error.errors[1]).toBe(false)
  await retained!()
 }finally{sourceProbe.failClose=false;release.resolve();await server.close();await cache.closeAll();await coordinator.close()}
},30000)

it('owned title lifetime close fences publication while transport is held',async()=>{
 const {createOwnedPostTurnLifetime}=await import('../src/service/owned-post-turn.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'title-close-race-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const action=entry.execution.owner.beginAction()
 try{committedFactSeqs(await action.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text:'work',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}},()=>true).admit())}finally{action.finish()}
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),lifetime=createOwnedPostTurnLifetime(),controller=new AbortController()
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{entered.resolve();await release.promise;response.end(`data: ${JSON.stringify({choices:[{delta:{content:'Late title'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)}])
 try{
  const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
  const running=lifetime.run({execution:entry.execution,sessionId:'main',signal:controller.signal,model,selectedClient:()=>model,assertCurrent(){}}).then(()=>null,error=>error)
  await entered.promise
  const closing=lifetime.close();release.resolve()
  await closing
  expect(controller.signal.aborted).toBe(false)
  expect(await running).toBeTruthy()
  expect((await backend.read('main')).events.filter(e=>e.type==='session/title')).toHaveLength(0)
 }finally{release.resolve();await server.close();await cache.closeAll();await coordinator.close()}
},30000)

it('owned title denies its final metadata capture when currency callback closes lifetime reentrantly',async()=>{
 const {createOwnedPostTurnLifetime}=await import('../src/service/owned-post-turn.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'title-reentrant-close-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const action=entry.execution.owner.beginAction()
 try{committedFactSeqs(await action.captureInputPromotion({kind:'input-start',turn:{type:'turn/start'},message:{type:'user/message',text:'work',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}},()=>true).admit())}finally{action.finish()}
 const lifetime=createOwnedPostTurnLifetime(),controller=new AbortController()
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(`data: ${JSON.stringify({choices:[{delta:{content:'Late'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)}])
 let closing:Promise<void>|undefined,guardCalls=0
 try{
  const model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
  const error=await lifetime.run({execution:entry.execution,sessionId:'main',signal:controller.signal,model,selectedClient:()=>model,assertCurrent(){if(titleGuardProbe.active&&++guardCalls===3)closing=lifetime.close()}}).then(()=>null,error=>error)
  expect(guardCalls).toBe(3);expect(closing).toBeDefined();await closing
  expect(controller.signal.aborted).toBe(false)
  expect(error).toBeTruthy()
  expect((await backend.read('main')).events.filter(e=>e.type==='session/title')).toHaveLength(0)
 }finally{await server.close();await cache.closeAll();await coordinator.close()}
},30000)

it('owned title lifetime preserves a falsey callback error when callback also closes it',async()=>{
 const {createOwnedPostTurnLifetime}=await import('../src/service/owned-post-turn.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'title-reentrant-falsey-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),lifetime=createOwnedPostTurnLifetime()
 const model={async *stream(){yield {type:'end' as const}}}
 let closing:Promise<void>|undefined
 try{
  const error=await lifetime.run({execution:entry.execution,sessionId:'main',signal:new AbortController().signal,model,selectedClient:()=>model,assertCurrent(){closing=lifetime.close();throw false}}).then(()=>null,error=>error)
  expect(error).toBe(false);await closing
 }finally{await cache.closeAll();await coordinator.close()}
},30000)
