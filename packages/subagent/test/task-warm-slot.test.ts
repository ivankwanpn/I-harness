const publicationFault=vi.hoisted(()=>({target:'',armed:false}))
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,async rename(...args:Parameters<typeof fs.rename>){await fs.rename(...args);if(publicationFault.armed&&String(args[1])===publicationFault.target){publicationFault.armed=false;throw undefined}}}})
import * as spawnSources from '../src/tools/spawn-source.ts'
import { expect,it,vi } from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistry} from '@i-harness/core-tools'
import {committedFactSeqs} from '@i-harness/core-session'
import {createMockClient} from '@i-harness/llm-mock'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {registerSubagent} from '../src/index.ts'
import {registerExec} from '@i-harness/exec'
import {receivedInputsFor} from '../../session-executor/src/lifecycle/received-inputs.ts'
import * as slots from '../src/task/launch-slots.ts'
import {TaskPersistence} from '../src/task/persistence.ts'
it.each([false,undefined])('mounted Boolean-disabled declared model refuses before task effects (%s)',async policy=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'slot-model-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 let mounted:ReturnType<typeof registerSubagent>|undefined,action:ReturnType<Awaited<ReturnType<typeof coordinator.openManagedDocument>>['beginAction']>|undefined,port:slots.TaskLaunchPort|undefined
 const sourceSpy=vi.spyOn(spawnSources,'createSpawnSource'),make=slots.createTaskLaunchPort,portSpy=vi.spyOn(slots,'createTaskLaunchPort').mockImplementation((...args)=>{port=make(...args);return port})
 let saveSpy:ReturnType<typeof vi.spyOn>|undefined
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent'),ctx=createContext(),registry=createToolRegistry(ctx,{executionOwner:{view:document.view,factOwner:document,context:ctx,sessionId:'parent'}})
  mounted=registerSubagent(ctx,registry,{parentSession:document.view,factOwner:document,parentModel:createMockClient([]),exec:registerExec(ctx),resolveModel:async()=>{throw Error('unexpected resolver')},allowSubagentModelSelection:policy,persist:{coordinator,stateId:'parent',parentSessionId:'parent'}});await mounted.ready
  mounted.roles.register({name:'configured',description:'configured',systemPrompt:'work',tools:[],model:{provider:'unused',model:'unused'}})
  await mounted.flushPersistence()
  action=document.beginAction();const source=action.registerSettlementSource(async()=>{}),args={message:'work',task_name:'one',agent_type:'configured'},[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'spawn_agent',args}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  const prepared=await registry.prepare({name:'spawn_agent',args},action.signal,{session:document.view,sessionId:'parent',callId:'call',callEventSeq:seq!,settlementSource:source})
  saveSpy=vi.spyOn(TaskPersistence.prototype,'save')
  const dispatch=registry.dispatch(prepared),retain=vi.spyOn(prepared.exec,'retainOutcome')
  await expect(dispatch).rejects.toThrow(/plugins\.subagentModel/)
  expect(mounted.tasks.list()).toEqual([]);expect(port!.inspect('task-1')).toBeUndefined();expect(saveSpy).not.toHaveBeenCalled();expect(sourceSpy).not.toHaveBeenCalled();expect(retain).not.toHaveBeenCalled();expect(mounted.agents.entries().size).toBe(0);expect(mounted.table.entries().size).toBe(0)
  expect(document.view.events.filter(event=>event.type==='subagent/start')).toEqual([])
  await source.close()
 }finally{saveSpy?.mockRestore();portSpy.mockRestore();sourceSpy.mockRestore();action?.finish();await mounted?.dispose();await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it.each([undefined,null])('mounted partial source retains original close debt after falsey beforeRead (%s)',async cause=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'slot-partial-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
 let mounted:ReturnType<typeof registerSubagent>|undefined,action:ReturnType<Awaited<ReturnType<typeof coordinator.openManagedDocument>>['beginAction']>|undefined,port:slots.TaskLaunchPort|undefined,acquired:ReturnType<NonNullable<typeof action>['registerSettlementSource']>|undefined
 let closeFault=true,closed=0,closeAttempts=0,retains=0,beforeReads=0
 const sourceSpy=vi.spyOn(spawnSources,'createSpawnSource'),make=slots.createTaskLaunchPort,portSpy=vi.spyOn(slots,'createTaskLaunchPort').mockImplementation((...args)=>{port=make(...args);return port})
 let saveSpy:ReturnType<typeof vi.spyOn>|undefined,beginSpy:{mockRestore():void}|undefined
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent'),ctx=createContext(),registry=createToolRegistry(ctx,{executionOwner:{view:document.view,factOwner:document,context:ctx,sessionId:'parent'}})
  mounted=registerSubagent(ctx,registry,{parentSession:document.view,factOwner:document,parentModel:createMockClient([]),exec:registerExec(ctx),resolveModel:async()=>{throw Error('unexpected resolver')},persist:{coordinator,stateId:'parent',parentSessionId:'parent'}});await mounted.ready
  action=document.beginAction();const source=action.registerSettlementSource(async()=>{}),args={message:'work',task_name:'one'},[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'spawn_agent',args}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  const begin=document.beginAction.bind(document)
  beginSpy=vi.spyOn(document,'beginAction').mockImplementation((...args)=>{const actual=begin(...args),register=actual.registerSettlementSource.bind(actual);vi.spyOn(actual,'registerSettlementSource').mockImplementation((...args)=>{acquired=register(...args);const close=acquired.close.bind(acquired);vi.spyOn(acquired,'close').mockImplementation(async()=>{closeAttempts++;if(closeFault)throw false;await close();closed++});return acquired});return actual})
  const save=TaskPersistence.prototype.save
  saveSpy=vi.spyOn(TaskPersistence.prototype,'save').mockImplementation(function(this:TaskPersistence){entered.resolve();return gate.promise.then(()=>save.call(this))})
  const prepared=await registry.prepare({name:'spawn_agent',args},action.signal,{session:document.view,sessionId:'parent',callId:'call',callEventSeq:seq!,settlementSource:source}),dispatch=registry.dispatch(prepared);void dispatch.catch(()=>{});await entered.promise
  const retainingExec=prepared.exec as typeof prepared.exec & {retainOutcome:NonNullable<typeof prepared.exec.retainOutcome>},retain=retainingExec.retainOutcome
  vi.spyOn(retainingExec,'retainOutcome').mockImplementation(()=>{retains++;const sink=retain();vi.spyOn(sink,'beforeRead').mockImplementation(()=>{beforeReads++;expect(acquired).toBeDefined();throw cause});return sink})
  const original=port!.inspect('task-1')!;gate.resolve();await expect(dispatch).rejects.toBe(cause)
  expect(sourceSpy).toHaveBeenCalledTimes(1);expect(retains).toBe(1);expect(beforeReads).toBe(1);expect(port!.inspect('task-1')!.flight).toBe(original.flight);await expect(original.flight).rejects.toBe(cause)
  await expect(mounted.dispose()).rejects.toThrow();expect(closeAttempts).toBeGreaterThan(0);expect(closed).toBe(0);expect(()=>acquired!.assertHeld()).not.toThrow()
  closeFault=false;await mounted.dispose();expect(closed).toBe(1);expect(()=>acquired!.assertHeld()).toThrow();expect(port!.inspect('task-1')!.flight).toBe(original.flight);await expect(original.flight).rejects.toBe(cause)
  expect(sourceSpy).toHaveBeenCalledTimes(1);expect(mounted.agents.entries().size).toBe(0);expect(mounted.table.entries().size).toBe(0)
  await source.close();action.finish();await coordinator.close()
 }finally{gate.resolve();closeFault=false;beginSpy?.mockRestore();saveSpy?.mockRestore();await acquired?.close().catch(()=>{});portSpy.mockRestore();sourceSpy.mockRestore();action?.finish();await mounted?.dispose().catch(()=>{});await coordinator.close().catch(()=>{});await rm(root,{recursive:true,force:true})}
},15_000)
it.each([{consumer:undefined,mode:'new'},{consumer:'code' as const,mode:'new'},{consumer:undefined,mode:'selection'},{consumer:undefined,mode:'cold'},{consumer:undefined,mode:'conflict'},{consumer:undefined,mode:'capacity'},{consumer:undefined,mode:'shaped'}])('original mounted slot admission $mode for $consumer',async ({consumer,mode})=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'warm-slot-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 const gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),sourceSpy=vi.spyOn(spawnSources,'createSpawnSource');let port:slots.TaskLaunchPort|undefined
 const make=slots.createTaskLaunchPort,spy=vi.spyOn(slots,'createTaskLaunchPort').mockImplementation((...args)=>{port=make(...args);return port})
 let mounted:ReturnType<typeof registerSubagent>|undefined,action:ReturnType<Awaited<ReturnType<typeof coordinator.openManagedDocument>>['beginAction']>|undefined
 let saveSpy:ReturnType<typeof vi.spyOn>|undefined,selections=0,policies=0
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent'),ctx=createContext(),registry=createToolRegistry(ctx,{executionOwner:{view:document.view,factOwner:document,context:ctx,sessionId:'parent'}})
  mounted=registerSubagent(ctx,registry,{parentSession:document.view,factOwner:document,maxConcurrency:mode==='capacity'?0:undefined,parentModel:createMockClient([]),exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),...(mode==='selection'?{roleSelectionFor(){selections++;expect(port!.inspect('task-1')).toBeDefined();expect(mounted!.tasks.list()).toHaveLength(1);return {provider:'unused',model:'unused'}},allowSubagentModelSelection(){policies++;expect(port!.inspect('task-1')).toBeDefined();return true}}:{}),persist:{coordinator,stateId:'parent',parentSessionId:'parent'}});await mounted.ready
  await receivedInputsFor(document,'parent').inbox.admit({inputId:'human',text:'work',intent:'user',delivery:'queue',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
  action=document.beginAction();const source=action.registerSettlementSource(async()=>{}),args={message:'work',task_name:'one',background:false},[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'spawn_agent',args}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  const prepare=()=>registry.prepare({name:'spawn_agent',args},action!.signal,{session:document.view,sessionId:'parent',callId:'call',callEventSeq:seq!,settlementSource:source,...consumer?{resultConsumer:consumer}:{}})
  if(mode==='cold'||mode==='conflict'){mounted.tasks.submit({identity:{parentSessionId:'parent',callEventSeq:seq!,toolCallId:'call'},agentPath:'root/one',description:'one',prompt:mode==='conflict'?'different':'work',agent:'general',delivery:'tool'});await mounted.tasks.flushPersistence()}
  if(mode==='shaped'){await expect(registry.get('spawn_agent')!.execute(args,{session:document.view,sessionId:'parent',callId:'call',callEventSeq:seq!} as never)).rejects.toThrow('prepared');expect(port!.inspect('task-1')).toBeUndefined();await source.close();return}
  const original=TaskPersistence.prototype.save;let saves=0
  saveSpy=vi.spyOn(TaskPersistence.prototype,'save').mockImplementation(function(this:TaskPersistence){saves++;entered.resolve();return gate.promise.then(()=>original.call(this))})
  const prepared=await prepare();const first=registry.dispatch(prepared);void first.catch(()=>{});
  if(mode!=='new'&&mode!=='selection'){await expect(first).rejects.toThrow();expect(saves).toBe(0);expect(sourceSpy).not.toHaveBeenCalled();expect(port!.inspect('task-1')).toBeUndefined();await source.close();return}
  await entered.promise
  const retain=vi.spyOn(prepared.exec,'retainOutcome')
  const status=port!.inspect('task-1')!;expect(status).toBeDefined();expect(mounted.tasks.list()).toHaveLength(1)
  mounted.tasks.get('task-1')!.delivery='parent';const duplicate=registry.dispatch(await prepare());void duplicate.catch(()=>{});await Promise.resolve();expect(port!.inspect('task-1')!.flight).toBe(status.flight);expect(saves).toBe(1);expect(sourceSpy).not.toHaveBeenCalled();expect(retain).not.toHaveBeenCalled();expect(selections).toBe(0);expect(policies).toBe(0)
  gate.resolve();await expect(first).rejects.toMatchObject({code:'TASK_LAUNCH_NOT_CONNECTED'});await expect(duplicate).rejects.toMatchObject({code:'TASK_LAUNCH_NOT_CONNECTED'})
  expect(sourceSpy).toHaveBeenCalledTimes(1);expect(retain).toHaveBeenCalledTimes(1);expect(mounted.agents.entries().size).toBe(0);expect(mounted.table.entries().size).toBe(0);expect(mounted.tasks.list()).toHaveLength(1);expect(selections).toBe(mode==='selection'?1:0);expect(policies).toBe(mode==='selection'?1:0)
  await source.close()
 }finally{gate.resolve();saveSpy?.mockRestore();spy.mockRestore();sourceSpy.mockRestore();action?.finish();await mounted?.dispose();await coordinator.close();await rm(root,{recursive:true,force:true})}
})
import {bindPreparedTaskLaunchLeaf} from '@i-harness/core-tools/internal/task-caller'
import {createTaskRegistry} from '../src/task/registry.ts'
import {captureOwnedTaskContext} from '../src/task/owned-context.ts'
import {childInitialCommitment,compileSemanticSeed,createChildBootstrapRequestIntent,captureChildBootstrapCaptureRequest} from '@i-harness/session-persistence'
it.each(['stop','parent','dispose','unknown'] as const)('original slot binding retires its held consumer on %s without launch revival',async cut=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'slot-binding-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),release=Promise.withResolvers<void>(),bound=Promise.withResolvers<void>()
 let taskOwner:ReturnType<typeof createTaskRegistry>|undefined,action:ReturnType<Awaited<ReturnType<typeof coordinator.openManagedDocument>>['beginAction']>|undefined
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent'),ctx=createContext(),registry=createToolRegistry(ctx,{executionOwner:{view:document.view,factOwner:document,context:ctx,sessionId:'parent'}}),owned=captureOwnedTaskContext(coordinator,document,document.view,'parent')!
  taskOwner=createTaskRegistry({coordinator,stateId:'parent',ownedTask:owned,launchContext:{view:document.view,factOwner:document,context:ctx,sessionId:'parent'}});await taskOwner.ready
  action=document.beginAction();const source=action.registerSettlementSource(async()=>{}),args={message:'work',task_name:'one',agent_type:'a',background:false},[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'call',name:'spawn_agent',args}));committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  let slot:slots.TaskLaunchSlot|undefined,entry:ReturnType<typeof bindPreparedTaskLaunchLeaf>
  const tool={name:'spawn_agent',description:'',inputSchema:{},async execute(_args:unknown,exec:import('@i-harness/core-tools').ToolExec){const caller=entry.enter(exec)!;slot=slots.taskLaunchPortFor(taskOwner!).admit(caller,{name:'a',description:'',systemPrompt:'a',tools:[]}).slot;await slot.accepted
   const initial={inputId:'initial',text:'work',startedAt:1,expiresAt:11,parentSessionId:'parent'},lineage={origin:'subagent' as const,subagentProtocolVersion:1 as const,parentSession:'parent'},payload={invocation:{version:1 as const,operationId:'op',targetSessionId:'child',createdAt:'2026-11-01T00:00:00.000Z',requestDigest:'a'.repeat(64)},target:{kind:'new' as const},metadata:{},lineage,seed:compileSemanticSeed({kind:'none'}),initial},core={version:1 as const,kind:'child-bootstrap-core' as const,caller:{kind:'task' as const,taskId:slot.task.id,parentSessionId:'parent',callEventSeq:seq!,toolCallId:'call'},history:{selection:{kind:'none' as const}},metadata:{},lineage,initial:childInitialCommitment(payload),execution:{roleName:'a',roleDigest:'b'.repeat(64),toolNames:[],model:{kind:'inherit-parent' as const},approval:'ordinary' as const}},intent=createChildBootstrapRequestIntent(core,{kind:'unmanaged'}),request=captureChildBootstrapCaptureRequest({version:1,kind:'child-bootstrap-capture-request',invocation:{...payload.invocation,requestDigest:intent.requestDigest},core,requestIntent:intent.intent})
   if(cut==='unknown'){publicationFault.target=join(root,'task-parent.doc.jsonl');publicationFault.armed=true;await expect(slot.bind({version:1,kind:'task-child-birth',request})).rejects.toThrow()}else{await slot.bind({version:1,kind:'task-child-birth',request});slot.assertBinding()}bound.resolve();await release.promise;return 'done'}}
  entry=bindPreparedTaskLaunchLeaf(tool,tool.execute);registry.register(tool)
  const dispatch=registry.dispatch(await registry.prepare({name:'spawn_agent',args},action.signal,{session:document.view,sessionId:'parent',callId:'call',callEventSeq:seq!,settlementSource:source}));void dispatch.catch(()=>{});await bound.promise
  expect((await coordinator.getDocument('task-parent') as {formatVersion:number}).formatVersion).toBe(3)
  if(cut==='stop')action.stop();else if(cut==='parent')document.revokeNewWork();else if(cut==='dispose')taskOwner.retireOwnedLoad()
  if(cut==='unknown'){await expect(taskOwner.closeOwnedLoad()).rejects.toThrow();await slot!.retryBinding()}
  await taskOwner.closeOwnedLoad();expect(()=>slot!.assertBinding()).toThrow();await slot!.retryBinding();expect(()=>slot!.consumeBinding()).toThrow()
  release.resolve();await dispatch.catch(()=>{});await source.close()
 }finally{release.resolve();action?.finish();await taskOwner?.closeOwnedLoad().catch(()=>{});await coordinator.close();await rm(root,{recursive:true,force:true})}
})
import {createCodeModeBroker} from '../../code-mode/src/broker.ts'
it.each([false,true])('real Code Mode broker task caller with foreign view=%s',async foreign=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'warm-broker-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),sourceSpy=vi.spyOn(spawnSources,'createSpawnSource')
 let mounted:ReturnType<typeof registerSubagent>|undefined,broker:ReturnType<typeof createCodeModeBroker>|undefined
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent'),ctx=createContext(),registry=createToolRegistry(ctx,{executionOwner:{view:document.view,factOwner:document,context:ctx,sessionId:'parent'}})
  mounted=registerSubagent(ctx,registry,{parentSession:document.view,factOwner:document,parentModel:createMockClient([]),exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),persist:{coordinator,stateId:'parent',parentSessionId:'parent'}});await mounted.ready
  if(foreign)await coordinator.create({sessionId:'foreign'});const executing=foreign?await coordinator.openManagedDocument('foreign'):document,id=foreign?'foreign':'parent'
  broker=createCodeModeBroker(ctx,registry,{session:executing.view,sessionId:id,factOwner:executing});broker.startCell('cell')
  registry.register({name:'workflow',description:'',inputSchema:{},async execute(){return broker!.invoke({cellId:'cell',invocationId:'code-call',name:'spawn_agent',args:{message:'work',task_name:'nested',background:false},origin:{sessionId:id,callId:'outer'},signal:new AbortController().signal})}})
  const action=document.beginAction(),source=action.registerSettlementSource(async()=>{}),[seq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'outer',name:'workflow',args:{}}));committedFactSeqs(await action.facts.tools.dispatch('outer',{kind:'prior',seq:seq!,expectedType:'tool/call'}))
  const result=registry.dispatch(await registry.prepare({name:'workflow',args:{}},action.signal,{session:document.view,sessionId:'parent',callId:'outer',callEventSeq:seq!,settlementSource:source}))
  await expect(result).rejects.toThrow(foreign?'Foreign':'connected B2')
  expect(mounted.tasks.list()).toHaveLength(foreign?0:1);expect(sourceSpy).toHaveBeenCalledTimes(foreign?0:1);expect(mounted.agents.entries().size).toBe(0)
  await source.close();action.finish()
 }finally{await broker?.dispose();sourceSpy.mockRestore();await mounted?.dispose();await coordinator.close();await rm(root,{recursive:true,force:true})}
})
