import { expect,it,vi } from 'vitest'
const access=vi.hoisted(()=>({path:'',opens:0}))
vi.mock('node:fs/promises',async original=>{const real=await original<typeof import('node:fs/promises')>();return {...real,async open(...args:Parameters<typeof real.open>){if(String(args[0])===access.path)access.opens++;return real.open(...args)}}})
import { mkdtemp,readFile,writeFile,appendFile,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
it.each(['open','torn'].flatMap(tail=>['missing','malformed','future','inconsistent','unavailable'].map(state=>({tail,state}))))('public load refuses $tail recovery with $state own task before mutation',async({tail,state})=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'d-load-')),backend=createJsonlBackend(root),path=join(root,'p.jsonl'),task=join(root,'task-p.doc.jsonl')
 await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'})
 if(state==='inconsistent')await backend.append('p',[{type:'subagent/start',version:1,taskId:'missing',agentPath:'a',role:'worker',description:'d'}])
 if(tail==='open')await backend.append('p',[{type:'turn/start'}]);else await appendFile(path,'{"torn":')
 const literal=state==='malformed'?'{bad':JSON.stringify({formatVersion:state==='future'?3:2,tasks:[],notifications:[]});if(state==='unavailable'){const {mkdir}=await import('node:fs/promises');await mkdir(task)}else if(state!=='missing')await writeFile(task,literal)
 const before=await readFile(path),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{await expect(coordinator.load('p')).rejects.toThrow();expect(await readFile(path)).toEqual(before);if(state==='missing')await expect(readFile(task)).rejects.toMatchObject({code:'ENOENT'});else if(state==='unavailable'){const {readdir}=await import('node:fs/promises');expect(await readdir(task)).toEqual([])}else expect(await readFile(task,'utf8')).toBe(literal)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it.each([1,2])('public load recovers with exact literal task%s',async formatVersion=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'d-load-positive-')),backend=createJsonlBackend(root),path=join(root,'p.jsonl'),task=join(root,'task-p.doc.jsonl')
 await backend.create('p',{sessionId:'p',formatVersion:14,createdAt:'x'});await backend.append('p',[{type:'turn/start'}]);await appendFile(path,'{"torn":')
 const literal=`{ "formatVersion": ${formatVersion}, "tasks": [], "notifications": [] }\n`;await writeFile(task,literal)
 const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{expect((await coordinator.load('p')).session.events.map(e=>e.type)).toEqual(['turn/start','turn/end']);expect((await backend.read('p')).events.map(e=>e.type)).toEqual(['turn/start','turn/end']);expect(await readFile(task,'utf8')).toBe(literal)}finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('public load preserves genuine13 observation and snapshot/list remain observational on14',async()=>{
 const {copyFile}=await import('node:fs/promises'),root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'d-load-observe-')),path=join(root,'p.jsonl')
 await copyFile(join(import.meta.dirname,'fixtures/original13-empty.jsonl'),path)
 const before=await readFile(path),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{await coordinator.load('p');expect(await readFile(path)).toEqual(before);await expect(readFile(join(root,'task-p.doc.jsonl'))).rejects.toMatchObject({code:'ENOENT'})
 const backend=createJsonlBackend(root);await backend.create('q',{sessionId:'q',formatVersion:14,createdAt:'x'});await backend.append('q',[{type:'turn/start'}]);const original=await readFile(join(root,'q.jsonl'));await coordinator.snapshot!('q');await coordinator.list();expect(await readFile(join(root,'q.jsonl'))).toEqual(original);await expect(readFile(join(root,'task-q.doc.jsonl'))).rejects.toMatchObject({code:'ENOENT'})
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('public load preflights future physical source before opening own task storage',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'d-load-future-')),path=join(root,'p.jsonl'),task=join(root,'task-p.doc.jsonl'),header=JSON.stringify({sessionId:'p',formatVersion:15,createdAt:'x'})+'\n',literal='{"formatVersion":2,"tasks":[],"notifications":[]}\n'
 await writeFile(path,header);await writeFile(task,literal);const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{access.path=task;access.opens=0;await expect(coordinator.load('p')).rejects.toThrow();expect(access.opens).toBe(0);expect(await readFile(path,'utf8')).toBe(header);expect(await readFile(task,'utf8')).toBe(literal)}finally{access.path='';await coordinator.close();await rm(root,{recursive:true,force:true})}
})
