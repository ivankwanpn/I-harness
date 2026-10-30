import { expect,it,vi } from 'vitest'
const fault=vi.hoisted(()=>({path:'',fail:false,links:0,upgrade:'',failRename:false,renames:0,closePath:'',failClose:0,closeHits:0}))
vi.mock('node:fs/promises',async original=>{const real=await original<typeof import('node:fs/promises')>();return {...real,async rename(...args:Parameters<typeof real.rename>){await real.rename(...args);if(String(args[1])===fault.upgrade){fault.renames++;if(fault.failRename){fault.failRename=false;throw Error('upgrade post-effect')}}},async link(...args:Parameters<typeof real.link>){await real.link(...args);if(String(args[1])===fault.path)fault.links++},async open(...args:Parameters<typeof real.open>){const handle=await real.open(...args);if(String(args[0])===fault.closePath&&args[1]==='r+'){const close=handle.close.bind(handle);handle.close=async()=>{if(fault.failClose>0){fault.failClose--;fault.closeHits++;throw Error('header close debt')}await close()}}if(String(args[0])===fault.path&&args[1]==='r+'){const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();if(fault.fail){fault.fail=false;throw Error('task sync post-effect')}}}return handle}}})
import { copyFile,mkdtemp,readdir,readFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { inspectColdSelectedTarget } from '../../session-persistence/src/selected-source-owner.ts'
const fixture=process.env.IH_TASK_D_PREDECESSOR_FIXTURES
it.skipIf(!fixture)('retains and retries the same cold selected task candidate after unknown sync',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'cold-selected-retry-')),source=join(fixture!,'selected13-result','sessions'),stageName=(await readdir(source)).find(name=>name.startsWith('target.jsonl.bootstrap-')&&name.endsWith('.stage'))!
 await copyFile(join(source,'target.jsonl'),join(root,'target.jsonl'));await copyFile(join(source,stageName),join(root,stageName))
 const stage=JSON.parse(await readFile(join(root,stageName),'utf8')),route={protocol:'public-results-v1' as const,request:stage.captureReservation.request},before=await readFile(join(root,'target.jsonl')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 fault.path=join(root,'task-target.doc.jsonl');fault.fail=true;fault.links=0
 try{
  expect((await inspectColdSelectedTarget(coordinator,route)).kind).toBe('blocked');expect(await readFile(join(root,'target.jsonl'))).toEqual(before);expect(fault.links).toBe(1)
  expect((await inspectColdSelectedTarget(coordinator,route)).kind).toBe('qualification-required');expect(fault.links).toBe(1)
  expect(JSON.parse((await readFile(join(root,'target.jsonl'),'utf8')).split('\n')[0]!).formatVersion).toBe(14);await coordinator.closeManagedDocument!('target')
 }finally{fault.path='';fault.fail=false;await coordinator.close();await rm(root,{recursive:true,force:true})}
},30000)
it.skipIf(!fixture)('reconciles the same cold selected live-header upgrade after unknown replacement',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'cold-upgrade-retry-')),source=join(fixture!,'selected13-result','sessions'),stageName=(await readdir(source)).find(name=>name.startsWith('target.jsonl.bootstrap-')&&name.endsWith('.stage'))!
 await copyFile(join(source,'target.jsonl'),join(root,'target.jsonl'));await copyFile(join(source,stageName),join(root,stageName))
 const stageBytes=await readFile(join(root,stageName)),stage=JSON.parse(stageBytes.toString()),route={protocol:'public-results-v1' as const,request:stage.captureReservation.request},coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 fault.upgrade=join(root,'target.jsonl');fault.failRename=true;fault.renames=0
 try{
  expect((await inspectColdSelectedTarget(coordinator,route)).kind).toBe('blocked');expect(fault.renames).toBe(1);expect(JSON.parse((await readFile(fault.upgrade,'utf8')).split('\n')[0]!).formatVersion).toBe(14)
  expect((await inspectColdSelectedTarget(coordinator,route)).kind).toBe('qualification-required');expect(fault.renames).toBe(1);expect(await readFile(join(root,stageName))).toEqual(stageBytes);await coordinator.closeManagedDocument!('target')
 }finally{fault.upgrade='';fault.failRename=false;await coordinator.close();await rm(root,{recursive:true,force:true})}
},30000)
it.skipIf(!fixture)('retains cold selected claim through header close debt and retries original confirmation',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'cold-header-debt-')),source=join(fixture!,'selected13-result','sessions'),stageName=(await readdir(source)).find(name=>name.startsWith('target.jsonl.bootstrap-')&&name.endsWith('.stage'))!
 await copyFile(join(source,'target.jsonl'),join(root,'target.jsonl'));await copyFile(join(source,stageName),join(root,stageName))
 const stage=JSON.parse(await readFile(join(root,stageName),'utf8')),route={protocol:'public-results-v1' as const,request:stage.captureReservation.request},coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 fault.closePath=join(root,'target.jsonl');fault.failClose=3;fault.closeHits=0
 try{
  await expect(inspectColdSelectedTarget(coordinator,route)).rejects.toThrow();expect(fault.closeHits).toBe(3);expect(coordinator.ownerOf!('target')).toBe(true);await expect(coordinator.openManagedDocument('target')).rejects.toThrow()
  expect((await inspectColdSelectedTarget(coordinator,route)).kind).toBe('qualification-required');await coordinator.closeManagedDocument!('target');expect(coordinator.ownerOf!('target')).toBe(false)
 }finally{fault.closePath='';fault.failClose=0;await coordinator.close();await rm(root,{recursive:true,force:true})}
},30000)
