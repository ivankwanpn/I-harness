import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import type { FactOwner, FactOutcome } from '@i-harness/core-session'
import { createOutputQueue } from '../src/event-facts/queue.ts'
import { originalCodeCommit } from '../src/event-facts/commit-proof.ts'
import { callback } from '../src/event-facts/state.ts'
async function setup() {
  const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'canonical-proof-'));await mkdir(join(root,'sessions'))
  const coordinator=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract)
  const {id}=await coordinator.create(),owner=await coordinator.openManagedDocument(id),action=owner.beginAction()
  await action.facts.code.record({type:'code/cell',cellId:'original',state:'started'})
  await action.facts.code.record({type:'code/cell',cellId:'other',state:'started'})
  const source=action.registerSettlementSource(async()=>{})
  const fact=source.code.capture({type:'code/output',cellId:'original',content:{type:'text',text:'canonical'}})
  const close=async()=>{await source.close();action.finish();await coordinator.close()}
  return {owner,action,source,fact,close}
}
it.each(['original','copied-outcome','foreign-outcome','cross-cell','copied-source','copied-owner','changed-source','descriptor-source-replaced'] as const)('authenticates the original full-owner capture/member tuple: %s',async mode=>{
  const f=await setup(),descriptor=vi.fn(),completed=vi.fn()
  const owner:FactOwner=mode==='copied-owner'?{...f.owner,view:f.owner.view}:f.owner
  const queue=createOutputQueue({owner,changed(){},failed(){},hold(){},completed})
  const source=mode==='copied-source'?{...f.source}:f.source
  const record=queue.enroll({kind:'output',fact:f.fact,source,expectedMember:Object.freeze({type:'code/output',cellId:mode==='cross-cell'?'other':'original'}),expectedOwner:f.action.owner,
    attempted:false,disposed:false,cancelled:false,settled:false,commit:callback(),cancel:callback(),settle:callback(),descriptor:async()=>{if(mode==='descriptor-source-replaced')record.source={...f.source};descriptor(originalCodeCommit(record))}})
  const admit=f.fact.admit.bind(f.fact)
  let foreign:FactOutcome|undefined
  if(mode==='foreign-outcome')foreign=await f.source.code.capture({type:'code/output',cellId:'other',content:{type:'text',text:'other capture'}}).admit()
  if(['copied-outcome','foreign-outcome','changed-source'].includes(mode))vi.spyOn(f.fact,'admit').mockImplementation(async()=>{
    const native=await admit()
    if(mode==='changed-source')record.source={...f.source}
    return mode==='copied-outcome'?{...native}:mode==='foreign-outcome'?foreign!:native
  })
  try{
    const result=await queue.pump()
    if(mode==='original'){
      expect(result.kind).toBe('idle');expect(descriptor).toHaveBeenCalledTimes(1);expect(completed).toHaveBeenCalledTimes(1)
      const proof=descriptor.mock.calls[0]![0]
      expect(proof.event).toBe(f.owner.view.events[proof.outcome.seqs[0]])
      expect(Object.isFrozen(proof.event)).toBe(true)
    }else{
      expect(result.kind).toBe('blocked');expect(descriptor).not.toHaveBeenCalled();expect(completed).not.toHaveBeenCalled()
      expect(()=>originalCodeCommit(record)).toThrow(/Original .*Code/)
      await queue.pump();expect(descriptor).not.toHaveBeenCalled()
    }
  }finally{await f.close();vi.restoreAllMocks()}
})
