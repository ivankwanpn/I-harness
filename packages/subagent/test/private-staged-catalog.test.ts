import {expect,it} from 'vitest'
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
