import { expect,it } from 'vitest'
import { copyFile,mkdtemp,readFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
const fixture=process.env.IH_TASK_D_PREDECESSOR_FIXTURES
const predecessor=it.skipIf(!fixture)
predecessor.each([{dir:'',id:'ordinary13',task:false},{dir:'task13-v1',id:'parent',task:true},{dir:'task13-v2',id:'parent',task:true}])('upgrades genuine original13 $dir with immutable body and task bytes',async row=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'predecessor-')),old=join(fixture!,row.dir),path=join(root,`${row.id}.jsonl`),task=join(root,`task-${row.id}.doc.jsonl`)
 await copyFile(join(old,`${row.id}.jsonl`),path);if(row.task)await copyFile(join(old,`task-${row.id}.doc.jsonl`),task)
 const original=await readFile(path),priorTask=row.task?await readFile(task):undefined,coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  expect(JSON.parse(original.subarray(0,original.indexOf(10)).toString()).formatVersion).toBe(13)
  await coordinator.loadOwned(row.id)
  const upgraded=await readFile(path);expect(JSON.parse(upgraded.subarray(0,upgraded.indexOf(10)).toString()).formatVersion).toBe(14)
  expect(upgraded.subarray(upgraded.indexOf(10)+1)).toEqual(original.subarray(original.indexOf(10)+1))
  if(priorTask)expect(await readFile(task)).toEqual(priorTask);else expect(JSON.parse(await readFile(task,'utf8')).formatVersion).toBe(2)
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
predecessor.each(['selected13','selected13-result'])('upgrades original selected predecessor %s without changing stage or body',async name=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-predecessor-')),source=join(fixture!,name,'sessions'),{readdir}=await import('node:fs/promises')
 const stageName=(await readdir(source)).find(name=>name.startsWith('target.jsonl.bootstrap-')&&name.endsWith('.stage'));if(!stageName)throw Error('original stage absent')
 await copyFile(join(source,'target.jsonl'),join(root,'target.jsonl'));await copyFile(join(source,stageName),join(root,stageName))
 const path=join(root,'target.jsonl'),original=await readFile(path),stage=await readFile(join(root,stageName)),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  await coordinator.loadOwned('target');const live=await readFile(path)
  expect(JSON.parse(live.subarray(0,live.indexOf(10)).toString()).formatVersion).toBe(14)
  expect(live.subarray(live.indexOf(10)+1)).toEqual(original.subarray(original.indexOf(10)+1));expect(await readFile(join(root,stageName))).toEqual(stage)
  expect(JSON.parse(await readFile(join(root,'task-target.doc.jsonl'),'utf8')).formatVersion).toBe(2)
  await coordinator.append('target',[{type:'user/message',text:'new suffix'}])
  const extended=await readFile(path);expect(extended.subarray(extended.indexOf(10)+1).subarray(0,original.length-original.indexOf(10)-1)).toEqual(original.subarray(original.indexOf(10)+1))
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
predecessor.each(['bootstrap13-public','bootstrap13-child'])('upgrades original %s birth preserving its original stage and initial tuple',async name=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'bootstrap-predecessor-')),source=join(fixture!,name),{readdir}=await import('node:fs/promises')
 const artifacts=(await readdir(source)).filter(name=>name.startsWith('target.jsonl.bootstrap-'));for(const artifact of artifacts)await copyFile(join(source,artifact),join(root,artifact))
 const path=join(root,'target.jsonl');await copyFile(join(source,'target.jsonl'),path);const original=await readFile(path),stages=await Promise.all(artifacts.map(name=>readFile(join(root,name)))),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  await coordinator.loadOwned('target');const live=await readFile(path),header=JSON.parse(live.subarray(0,live.indexOf(10)).toString());expect(header.formatVersion).toBe(14)
  expect(live.subarray(live.indexOf(10)+1)).toEqual(original.subarray(original.indexOf(10)+1));expect(await Promise.all(artifacts.map(name=>readFile(join(root,name))))).toEqual(stages)
  if(name==='bootstrap13-child')expect(header.semanticSeed.initialInputId).toBe('input')
  expect(JSON.parse(await readFile(join(root,'task-target.doc.jsonl'),'utf8')).formatVersion).toBe(2)
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
predecessor('finishes an actual original13 interrupted birth before transitioning its live header',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'incomplete-predecessor-')),source=join(fixture!,'incomplete13-public'),{readdir}=await import('node:fs/promises')
 const stageName=(await readdir(source)).find(name=>name.startsWith('target.jsonl.bootstrap-')&&name.endsWith('.stage'))!;await copyFile(join(source,'target.jsonl'),join(root,'target.jsonl'));await copyFile(join(source,stageName),join(root,stageName))
 const before=await readFile(join(root,'target.jsonl')),stage=await readFile(join(root,stageName)),core=await import('@i-harness/core-session')
 const payload={invocation:{version:1 as const,operationId:'public',targetSessionId:'target',createdAt:'2026-10-23T00:00:00.000Z',requestDigest:'a'.repeat(64)},target:{kind:'new' as const},metadata:{},lineage:{origin:'fork' as const,parentSession:'parent'},seed:{digest:core.EMPTY_SEMANTIC_SEED_DIGEST,dependencyDigest:core.EMPTY_SEMANTIC_DEPENDENCY_DIGEST,sourceObservation:{kind:'none' as const},records:[]}},guards={assertCurrent(){},dependencies:{async confirm(){throw Error('unused')},async reconcile(){throw Error('unused')}}}
 const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{const result=await coordinator.resumeSemanticTarget(payload.invocation,guards,payload);expect(result.kind).toBe('ready');const live=await readFile(join(root,'target.jsonl'));expect(JSON.parse(live.subarray(0,live.indexOf(10)).toString()).formatVersion).toBe(14);expect(await readFile(join(root,stageName))).toEqual(stage);expect(JSON.parse(before.toString()).formatVersion).toBe(13);expect(JSON.parse(await readFile(join(root,'task-target.doc.jsonl'),'utf8')).formatVersion).toBe(2)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
},30000)
predecessor('reconciles a cached original child13 birth after its live header upgrades',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'cached-child13-')),source=join(fixture!,'bootstrap13-child'),{readdir}=await import('node:fs/promises')
 for(const name of (await readdir(source)).filter(name=>name==='target.jsonl'||name.startsWith('target.jsonl.bootstrap-')))await copyFile(join(source,name),join(root,name))
 const {pair,guards}=await import('../../session-persistence/test/child-bootstrap-fixture.ts'),{request,payload}=pair(),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{const doc=await coordinator.openManagedDocument('target'),result=await coordinator.resumeChildTarget!(request,guards,payload);expect(result.kind).toBe('already-ready');if(result.kind==='already-ready')expect(result.document).toBe(doc)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
},30000)
