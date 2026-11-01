import { expect,it } from 'vitest'
import { copyFile,mkdtemp,readdir,readFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { inspectColdSelectedTarget } from '../../session-persistence/src/selected-source-owner.ts'
const fixture=process.env.IH_TASK_D_PREDECESSOR_FIXTURES
it.skipIf(!fixture)('transitions the original selected13 cold entry before exposing qualification-required',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'cold-selected-')),source=join(fixture!,'selected13-result','sessions'),stageName=(await readdir(source)).find(name=>name.startsWith('target.jsonl.bootstrap-')&&name.endsWith('.stage'))!
 await copyFile(join(source,'target.jsonl'),join(root,'target.jsonl'));await copyFile(join(source,stageName),join(root,stageName))
 const stageBytes=await readFile(join(root,stageName)),stage=JSON.parse(stageBytes.toString()),route={protocol:'public-results-v1' as const,request:stage.captureReservation.request},original=await readFile(join(root,'target.jsonl'))
 const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  expect((await inspectColdSelectedTarget(coordinator,route)).kind).toBe('qualification-required')
  const current=await readFile(join(root,'target.jsonl'));expect(JSON.parse(current.subarray(0,current.indexOf(10)).toString()).formatVersion).toBe(14)
  expect(current.subarray(current.indexOf(10)+1)).toEqual(original.subarray(original.indexOf(10)+1));expect(await readFile(join(root,stageName))).toEqual(stageBytes)
  expect(JSON.parse(await readFile(join(root,'task-target.doc.jsonl'),'utf8')).formatVersion).toBe(2)
  await expect(coordinator.openManagedDocument('target')).rejects.toThrow()
  await expect(coordinator.withProcessReadObservation!('target',{documentKeys:[]},async()=>true,async value=>value)).rejects.toThrow()
  await coordinator.closeManagedDocument!('target')
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
},30000)
it.skipIf(!fixture)('refuses a missing task file for a cold physical14 selected birth',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'cold-selected-missing-')),source=join(fixture!,'selected13-result','sessions'),stageName=(await readdir(source)).find(name=>name.startsWith('target.jsonl.bootstrap-')&&name.endsWith('.stage'))!
 await copyFile(join(source,'target.jsonl'),join(root,'target.jsonl'));await copyFile(join(source,stageName),join(root,stageName))
 const stage=JSON.parse(await readFile(join(root,stageName),'utf8')),route={protocol:'public-results-v1' as const,request:stage.captureReservation.request},first=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 await first.loadOwned('target');await first.close();const {unlink}=await import('node:fs/promises');await unlink(join(root,'task-target.doc.jsonl'))
 const before=await readFile(join(root,'target.jsonl')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{expect((await inspectColdSelectedTarget(coordinator,route)).kind).toBe('blocked');await expect(readFile(join(root,'task-target.doc.jsonl'))).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(join(root,'target.jsonl'))).toEqual(before)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
},30000)
it.skipIf(!fixture)('cold selected13 confirms literal task bytes without rewriting them',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'cold-selected-present-')),source=join(fixture!,'selected13-result','sessions'),stageName=(await readdir(source)).find(name=>name.startsWith('target.jsonl.bootstrap-')&&name.endsWith('.stage'))!
 await copyFile(join(source,'target.jsonl'),join(root,'target.jsonl'));await copyFile(join(source,stageName),join(root,stageName))
 const stage=JSON.parse(await readFile(join(root,stageName),'utf8')),route={protocol:'public-results-v1' as const,request:stage.captureReservation.request},{writeFile}=await import('node:fs/promises'),literal='{ "formatVersion": 1, "tasks": [], "notifications": [] }\n';await writeFile(join(root,'task-target.doc.jsonl'),literal)
 const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{expect((await inspectColdSelectedTarget(coordinator,route)).kind).toBe('qualification-required');expect(await readFile(join(root,'task-target.doc.jsonl'),'utf8')).toBe(literal);await coordinator.closeManagedDocument!('target')}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
},30000)
