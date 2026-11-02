import {expect,it,vi} from 'vitest'
const driveProbe=vi.hoisted(()=>({flight:undefined as Promise<void>|undefined}))
vi.mock('../src/followup/drive.ts',async load=>{const original=await load<typeof import('../src/followup/drive.ts')>();return {...original,driveFollowups(...args:Parameters<typeof original.driveFollowups>){const flight=original.driveFollowups(...args);driveProbe.flight=flight;void flight.catch(()=>{});return flight}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {createManagedAgentModelOriginOwner} from '@i-harness/core-agent/model-origin'
import {createMockClient} from '@i-harness/llm-mock'
import {registerExec} from '@i-harness/exec'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {registerSubagent} from '../src/index.ts'
import {builtinRoles} from '../src/roles.ts'
import {fixtureGenerationFor} from './generation-fixture.ts'
import {committedFactSeqs} from '@i-harness/core-session'

it.each(['activate','dispose'] as const)('stages the original role catalog before %s',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'staged-child-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'parent'}},origin.verifier)
 let model:ReturnType<typeof createMockClient>|undefined,reads=0,ready=false
 const mounted=registerSubagent(ctx,pair.registry,{managedParent:{domain:origin.domain,execution},deferRestoredWork:true,getParentModel(){reads++;if(!model)throw Error('Model not bound');return model},exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),persist:{coordinator,stateId:'parent',parentSessionId:'parent'}})
 try{
  expect(()=>mounted.roles.register({name:'too-early',description:'',systemPrompt:'',tools:[]})).toThrow();expect(()=>mounted.tasks.list()).toThrow()
  void mounted.ready.then(()=>{ready=true},()=>{});await mounted.catalogReady;await Promise.resolve();expect(ready).toBe(false);expect(reads).toBe(0)
  mounted.roles.register({name:'plugin-role',description:'plugin',systemPrompt:'plugin',tools:[]});expect(mounted.roles.get('plugin-role')).toBeDefined()
  if(mode==='activate'){model=createMockClient([]);mounted.activateRestoredWork();await mounted.ready;expect(ready).toBe(true);expect(reads).toBe(0)}
  else {const rejection=mounted.ready.catch(error=>error);await mounted.dispose();expect(await rejection).toMatchObject({message:'Owned runtime retired before activation'});expect(reads).toBe(0);expect(()=>mounted.activateRestoredWork()).toThrow()}
 }finally{await mounted.dispose();await coordinator.close()}
},20000)

it('does not rebuild an original restored pending inbox until activation binds the model',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'staged-inbox-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});await coordinator.create({sessionId:'child',parentSession:'parent',origin:'subagent',seedLength:0});await coordinator.append('child',[{type:'turn/start'},{type:'user/message',text:'original task'},{type:'step/start'},{type:'assistant/message',text:'initial answer'},{type:'step/end'},{type:'turn/end'}]);const child=await coordinator.openManagedDocument('child'),childAction=child.beginAction()
 committedFactSeqs(await childAction.facts.delivery.record({type:'subagent/inbox',messageId:'pending',message:'follow up',provenance:{kind:'inherited',authority:'observation',scope:'turn',producer:'subagent.followup',originSessionId:'parent'}}));childAction.finish()
 const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'parent'}},origin.verifier)
 let model:ReturnType<typeof createMockClient>|undefined,reads=0
 const mounted=registerSubagent(ctx,pair.registry,{managedParent:{domain:origin.domain,execution},deferRestoredWork:true,getParentModel(){reads++;if(!model)throw Error('Model not bound');return model},generationFactoryFor:fixtureGenerationFor,exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),persist:{coordinator,stateId:'parent',parentSessionId:'parent'},restoredState:{formatVersion:1,roles:builtinRoles(),jobs:[],agentTable:[{path:'root/a',status:'waiting',sessionId:'child',roleName:'general',mailbox:[]}]}})
 try{
  await mounted.catalogReady;expect(reads).toBe(0);expect(child.view.events.some(event=>event.type==='subagent/inbox'&&event.messageId==='pending')).toBe(true);expect(mounted.agents.get('child')).toBeUndefined()
  mounted.roles.register({name:'plugin-role',description:'plugin',systemPrompt:'plugin',tools:[]});expect(mounted.roles.get('plugin-role')).toBeDefined()
  model=createMockClient([{role:'assistant',text:'followed up'}]);mounted.activateRestoredWork();await mounted.ready
  expect(driveProbe.flight).toBeDefined();await driveProbe.flight;expect(reads).toBeGreaterThan(0);expect(mounted.agents.get('child')).toBeDefined();expect(mounted.table.get('root/a')?.finalText).toBe('followed up')
 }finally{await mounted.dispose();await coordinator.close()}
},30000)
