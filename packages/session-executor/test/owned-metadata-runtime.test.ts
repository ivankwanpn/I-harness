import {expect,it,vi} from 'vitest'
const journalProbe=vi.hoisted(()=>({unknown:false,unknownReconcile:false,appends:0,reconciles:0}))
const captureProbe=vi.hoisted(()=>({gate:undefined as undefined|{entered:()=>void;wait:Promise<void>}}))
const sourceProbe=vi.hoisted(()=>({failClose:false}))
vi.mock('../../session-persistence/src/coordinator/settlement-source.ts',async original=>{const module=await original<typeof import('../../session-persistence/src/coordinator/settlement-source.ts')>();return {...module,createSettlementSource(...args:Parameters<typeof module.createSettlementSource>){const source=module.createSettlementSource(...args),close=source.close.bind(source);source.close=()=>{if(sourceProbe.failClose){sourceProbe.failClose=false;return Promise.reject(false)}return close()};return source}}})
vi.mock('../../session-persistence/src/coordinator/action-captures.ts',async original=>{const module=await original<typeof import('../../session-persistence/src/coordinator/action-captures.ts')>();return {...module,createActionCaptures(...args:Parameters<typeof module.createActionCaptures>){const captures=module.createActionCaptures(...args);return {...captures,captureMetadata(event:Parameters<NonNullable<typeof captures.captureMetadata>>[0],check?:()=>boolean){const fact=captures.captureMetadata!(event,check);if(event.type!=='goal/change'||event.operation!=='complete'||!captureProbe.gate)return fact;const gate=captureProbe.gate;captureProbe.gate=undefined;return {...fact,async admit(){gate.entered();await gate.wait;return fact.admit()}}}}}}})
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async original=>{const module=await original<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...module,createFactJournalBackend(...args:Parameters<typeof module.createFactJournalBackend>){const backend=module.createFactJournalBackend(...args);return {...backend,async appendOwnedBatch(...values:Parameters<typeof backend.appendOwnedBatch>){const result=await backend.appendOwnedBatch(...values);if(journalProbe.unknown&&result.kind==='committed'){journalProbe.unknown=false;journalProbe.appends++;return {kind:'unknown' as const,key:values[3].key}}return result},async reconcileOwnedBatch(...values:Parameters<typeof backend.reconcileOwnedBatch>){journalProbe.reconciles++;if(journalProbe.unknownReconcile){journalProbe.unknownReconcile=false;return {kind:'unknown' as const,key:values[3].key}}return backend.reconcileOwnedBatch(...values)}}}}})
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
