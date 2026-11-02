import {expect,it} from 'vitest'
import {createNondurableFactOwner,createSession} from '@i-harness/core-session'
import {createSpawnSource,inspectOriginalSpawnStart,inspectManagedSpawnStart} from '../src/tools/spawn-source.ts'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'

it('accepts only the original acknowledged spawn start and its owner',async()=>{
 const owner=createNondurableFactOwner(createSession()),foreign=createNondurableFactOwner(createSession())
 const source=createSpawnSource(owner)
 try{
  const receipt=await source.start({type:'subagent/start',version:1,taskId:'task-1',parentSessionId:'parent',agentPath:'root/a',role:'general',description:'work'})
  expect(inspectOriginalSpawnStart(receipt,owner).event.taskId).toBe('task-1')
  expect(()=>inspectOriginalSpawnStart({...receipt},owner)).toThrow('Original spawn start required')
  expect(()=>inspectOriginalSpawnStart(receipt,foreign)).toThrow('Original spawn start required')
 }finally{await source.releaseUnused();source.finish()}
})

it('retains the acknowledged private spawn start without a parent view',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'spawn-start-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 const {id}=await coordinator.create(),execution=await acquireManagedExecution(coordinator,id)
 const domain=createManagedExecutionDomain(execution.identity,execution.owner,createContext())
 expect(Object.hasOwn(execution.owner,'view')).toBe(false)
 const source=createSpawnSource(execution.owner,undefined,undefined,true,undefined,undefined,undefined,domain)
 try{
  const receipt=await source.start({type:'subagent/start',version:1,taskId:'private-task',parentSessionId:id,agentPath:'root/a',role:'general',description:'work'})
  const original=inspectOriginalSpawnStart(receipt,execution.owner)
  expect(inspectManagedSpawnStart(receipt,domain).members).toEqual(original.events)
  expect(()=>inspectManagedSpawnStart({...receipt},domain)).toThrow()
  expect(original.events).toEqual([expect.objectContaining({type:'subagent/start',taskId:'private-task',seq:original.seqs[0]})])
  expect(()=>inspectOriginalSpawnStart({...receipt},execution.owner)).toThrow()
 }finally{await source.releaseUnused();source.finish();await coordinator.close()}
})
