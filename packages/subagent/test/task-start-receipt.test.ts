import {expect,it} from 'vitest'
import {createNondurableFactOwner,createSession} from '@i-harness/core-session'
import {createSpawnSource,inspectOriginalSpawnStart} from '../src/tools/spawn-source.ts'

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
