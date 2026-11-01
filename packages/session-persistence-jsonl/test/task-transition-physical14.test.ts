import { expect,it } from 'vitest'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
it('refuses a missing task file for an already physical14 parent',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'missing14-')),backend=createJsonlBackend(root)
 await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'})
 const before=await readFile(join(root,'p.jsonl')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{await expect(coordinator.loadOwned('p')).rejects.toThrow();await expect(readFile(join(root,'task-p.doc.jsonl'))).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(join(root,'p.jsonl'))).toEqual(before)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it.each([1,2])('confirms original literal task version %s for a physical14 parent',async version=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'present14-')),backend=createJsonlBackend(root)
 await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'})
 const {writeFile}=await import('node:fs/promises'),literal=`{ "notifications": [], "tasks": [], "formatVersion": ${version} }\n`;await writeFile(join(root,'task-p.doc.jsonl'),literal)
 const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{await coordinator.loadOwned('p');expect(await readFile(join(root,'task-p.doc.jsonl'),'utf8')).toBe(literal)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('refuses malformed existing task storage for a physical14 parent without rewriting it',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'invalid14-')),backend=createJsonlBackend(root)
 await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'})
 const {writeFile}=await import('node:fs/promises'),literal='{bad\n';await writeFile(join(root,'task-p.doc.jsonl'),literal)
 const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{await expect(coordinator.loadOwned('p')).rejects.toThrow();expect(await readFile(join(root,'task-p.doc.jsonl'),'utf8')).toBe(literal)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('creates a physical14 parent only with its acknowledged empty task sidecar',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'create14-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{await coordinator.create({sessionId:'p'});expect(JSON.parse((await readFile(join(root,'p.jsonl'),'utf8')).split('\n')[0]!).formatVersion).toBe(14);expect(JSON.parse(await readFile(join(root,'task-p.doc.jsonl'),'utf8'))).toEqual({formatVersion:2,tasks:[],notifications:[]})}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('refuses an orphan task before creating a physical14 header',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'orphan14-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 const {writeFile}=await import('node:fs/promises'),literal='{"formatVersion":2,"tasks":[],"notifications":[]}\n';await writeFile(join(root,'task-p.doc.jsonl'),literal)
 try{await expect(coordinator.create({sessionId:'p'})).rejects.toThrow();await expect(readFile(join(root,'p.jsonl'))).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(join(root,'task-p.doc.jsonl'),'utf8')).toBe(literal)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('refuses missing task storage before replacing an existing-empty physical14 header',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'empty14-')),backend=createJsonlBackend(root),createdAt='2026-10-23T00:00:00.000Z'
 await backend.create('p',{sessionId:'p',formatVersion:14,createdAt});const before=await readFile(join(root,'p.jsonl'))
 const {createHash}=await import('node:crypto'),{legacyPrefixDigest,EMPTY_SEMANTIC_SEED_DIGEST,EMPTY_SEMANTIC_DEPENDENCY_DIGEST}=await import('@i-harness/core-session')
 const request={invocation:{version:1 as const,operationId:'op',targetSessionId:'p',createdAt,requestDigest:'a'.repeat(64)},target:{kind:'existing-empty' as const,expectedHeaderDigest:createHash('sha256').update(before).digest('hex'),expectedPrefix:{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())}},metadata:{},lineage:{origin:'fork' as const,parentSession:'parent'},seed:{digest:EMPTY_SEMANTIC_SEED_DIGEST,dependencyDigest:EMPTY_SEMANTIC_DEPENDENCY_DIGEST,sourceObservation:{kind:'none' as const},records:[]}}
 const guards={assertCurrent(){},dependencies:{async confirm(){throw Error('unused')},async reconcile(){throw Error('unused')}}},coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{expect((await coordinator.bootstrapSemanticTarget(request,guards)).kind).not.toBe('ready');expect(await readFile(join(root,'p.jsonl'))).toEqual(before);await expect(readFile(join(root,'task-p.doc.jsonl'))).rejects.toMatchObject({code:'ENOENT'})}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('refuses an unknown future parent without mutating task storage',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'future-parent-')),backend=createJsonlBackend(root)
 await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'})
 const {writeFile}=await import('node:fs/promises'),path=join(root,'p.jsonl'),lines=(await readFile(path,'utf8')).split('\n'),header=JSON.parse(lines[0]!);header.formatVersion=15;lines[0]=JSON.stringify(header);await writeFile(path,lines.join('\n'))
 const task='{ "formatVersion": 2, "tasks": [], "notifications": [] }\n';await writeFile(join(root,'task-p.doc.jsonl'),task);const before=await readFile(path),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{await expect(coordinator.loadOwned('p')).rejects.toThrow();expect(await readFile(path)).toEqual(before);expect(await readFile(join(root,'task-p.doc.jsonl'),'utf8')).toBe(task)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('does not drain queued work into physical14 before confirming task storage',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'queued-missing14-')),backend=createJsonlBackend(root);await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'})
 const before=await readFile(join(root,'p.jsonl')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true},maxDelayMs:60000},taskDocumentStorageContract)
 try{coordinator.enqueue('p',[{type:'user/message',text:'must stay queued'}]);await expect(coordinator.loadOwned('p')).rejects.toThrow();expect(await readFile(join(root,'p.jsonl'))).toEqual(before);await expect(readFile(join(root,'task-p.doc.jsonl'))).rejects.toMatchObject({code:'ENOENT'})}finally{await coordinator.close().catch(()=>{});await rm(root,{recursive:true,force:true})}
})
it('drains queued physical14 work through its own confirmed task transition',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'queued-valid14-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true},maxDelayMs:60000},taskDocumentStorageContract)
 try{await coordinator.create({sessionId:'p'});coordinator.enqueue('p',[{type:'user/message',text:'queued'}]);expect((await coordinator.loadOwned('p')).session.events).toHaveLength(1);expect((await createJsonlBackend(root).read('p')).events).toHaveLength(1)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('does not repair a physical14 parent before its missing task is refused',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'repair-missing14-')),backend=createJsonlBackend(root);await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'});await backend.append('p',[{type:'turn/start'}])
 const before=await readFile(join(root,'p.jsonl')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{await expect(coordinator.loadOwned('p')).rejects.toThrow();expect(await readFile(join(root,'p.jsonl'))).toEqual(before);await expect(readFile(join(root,'task-p.doc.jsonl'))).rejects.toMatchObject({code:'ENOENT'});await expect(coordinator.withProcessReadObservation!('p',{documentKeys:[]},async()=>true,async value=>value)).resolves.toBe(true)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('refuses malformed task bytes before repairing a physical14 parent',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'repair-invalid14-')),backend=createJsonlBackend(root);await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'});await backend.append('p',[{type:'turn/start'}])
 const {writeFile}=await import('node:fs/promises'),literal='{bad\n';await writeFile(join(root,'task-p.doc.jsonl'),literal);const before=await readFile(join(root,'p.jsonl')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{await expect(coordinator.loadOwned('p')).rejects.toThrow();expect(await readFile(join(root,'p.jsonl'))).toEqual(before);expect(await readFile(join(root,'task-p.doc.jsonl'),'utf8')).toBe(literal)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('repairs a physical14 parent after confirming valid original task bytes',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'repair-valid14-')),backend=createJsonlBackend(root);await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'});await backend.append('p',[{type:'turn/start'}])
 const {writeFile}=await import('node:fs/promises'),literal='{ "formatVersion": 2, "tasks": [], "notifications": [] }\n';await writeFile(join(root,'task-p.doc.jsonl'),literal);const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{const loaded=await coordinator.loadOwned('p');expect(loaded.session.events.map(event=>event.type)).toEqual(['turn/start','turn/end']);expect(await readFile(join(root,'task-p.doc.jsonl'),'utf8')).toBe(literal)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
const guardedEntries=['create','loadOwned','adopt','open','ensure','append','enqueue','metadata'] as const
it.each(guardedEntries.flatMap(entry=>['missing','malformed','future-task'].map(state=>({entry,state}))))('refuses $entry before any repair for $state task storage',async({entry,state})=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'entry-matrix14-')),backend=createJsonlBackend(root);await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'});await backend.append('p',[{type:'turn/start'}])
 const {writeFile}=await import('node:fs/promises'),taskPath=join(root,'task-p.doc.jsonl'),literal=state==='malformed'?'{bad\n':'{"formatVersion":3,"tasks":[],"notifications":[]}\n';if(state!=='missing')await writeFile(taskPath,literal)
 const before=await readFile(join(root,'p.jsonl')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true},maxDelayMs:60000},taskDocumentStorageContract)
 try{
  const act=async()=>{switch(entry){case 'create':return coordinator.create({sessionId:'p'});case 'loadOwned':return coordinator.loadOwned('p');case 'adopt':return coordinator.adoptOwnership('p');case 'open':return coordinator.openManagedDocument('p');case 'ensure':return coordinator.ensureWritableFormat!('p');case 'append':return coordinator.append('p',[{type:'user/message',text:'blocked'}]);case 'enqueue':coordinator.enqueue('p',[{type:'user/message',text:'blocked'}]);return coordinator.flush('p');case 'metadata':return coordinator.updateMeta('p',{title:'blocked'})}}
  await expect(act()).rejects.toThrow();expect(await readFile(join(root,'p.jsonl'))).toEqual(before)
  if(state==='missing')await expect(readFile(taskPath)).rejects.toMatchObject({code:'ENOENT'});else expect(await readFile(taskPath,'utf8')).toBe(literal)
 }finally{await coordinator.close().catch(()=>{});await rm(root,{recursive:true,force:true})}
},30000)
it.each(['malformed','future-task'] as const)('refuses existing-empty bootstrap with %s task bytes before parent mutation',async state=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'bootstrap-invalid14-')),backend=createJsonlBackend(root),createdAt='2026-10-23T00:00:00.000Z';await backend.create('p',{sessionId:'p',formatVersion:14,createdAt})
 const {writeFile}=await import('node:fs/promises'),literal=state==='malformed'?'{bad\n':'{"formatVersion":3,"tasks":[],"notifications":[]}\n';await writeFile(join(root,'task-p.doc.jsonl'),literal)
 const before=await readFile(join(root,'p.jsonl')),{createHash}=await import('node:crypto'),{legacyPrefixDigest,EMPTY_SEMANTIC_SEED_DIGEST,EMPTY_SEMANTIC_DEPENDENCY_DIGEST}=await import('@i-harness/core-session')
 const request={invocation:{version:1 as const,operationId:'op',targetSessionId:'p',createdAt,requestDigest:'a'.repeat(64)},target:{kind:'existing-empty' as const,expectedHeaderDigest:createHash('sha256').update(before).digest('hex'),expectedPrefix:{eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())}},metadata:{},lineage:{origin:'fork' as const,parentSession:'parent'},seed:{digest:EMPTY_SEMANTIC_SEED_DIGEST,dependencyDigest:EMPTY_SEMANTIC_DEPENDENCY_DIGEST,sourceObservation:{kind:'none' as const},records:[]}},guards={assertCurrent(){},dependencies:{async confirm(){throw Error('unused')},async reconcile(){throw Error('unused')}}},coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{expect((await coordinator.bootstrapSemanticTarget(request,guards)).kind).not.toBe('ready');expect(await readFile(join(root,'p.jsonl'))).toEqual(before);expect(await readFile(join(root,'task-p.doc.jsonl'),'utf8')).toBe(literal)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
