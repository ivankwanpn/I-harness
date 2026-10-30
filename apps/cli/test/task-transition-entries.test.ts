import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const repo=resolve(import.meta.dirname,'../../..'),loader=pathToFileURL(join(repo,'node_modules/tsx/dist/loader.mjs')).href,entry=join(repo,'apps/cli/src/index.ts')
it.each(['run','sdk','acp'] as const)('actual %s durable entry initializes its task sidecar',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'cli-task-')),workspace=join(root,'workspace'),profile=join(root,'config'),sessions=join(root,'sessions')
 await mkdir(workspace);await mkdir(profile)
 const child=spawn(process.execPath,['--import',loader,entry,mode,...(mode==='run'?['fixture']:[]),'--session-dir',sessions],{cwd:workspace,env:{...process.env,IH_CONFIG_DIR:profile},stdio:'pipe',windowsHide:true})
 let buffer='',diagnostic='',next=0;const pending=new Map<number,{resolve(v:any):void;reject(e:Error):void}>()
 child.stderr.on('data',chunk=>{diagnostic+=chunk});child.stdout.on('data',chunk=>{buffer+=chunk;for(let end=buffer.indexOf('\n');end>=0;end=buffer.indexOf('\n')){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const x=JSON.parse(line),p=pending.get(x.id);if(p){pending.delete(x.id);x.error?p.reject(Error(JSON.stringify(x.error))):p.resolve(x.result)}}catch{}}})
 const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 const request=(method:string,params:unknown={})=>{const id=++next,promise=new Promise<any>((resolve,reject)=>pending.set(id,{resolve,reject}));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return Promise.race([promise,exited.then(code=>{throw Error(`exit ${code}: ${diagnostic}`)})])}
 try {
  let id:string
  if(mode==='sdk'){
   await request('initialize');({sessionId:id}=await request('session/create'))
   await request('session/prompt',{sessionId:'sdk-ensure-root',prompt:'fixture'}).catch(()=>{})
   expect(JSON.parse(await readFile(join(sessions,'task-sdk-ensure-root.doc.jsonl'),'utf8')).formatVersion).toBe(2)
   expect(JSON.parse((await readFile(join(sessions,'sdk-ensure-root.jsonl'),'utf8')).split('\n')[0]!).formatVersion).toBe(14)
   await request('shutdown');child.stdin.end()
  }
  else if(mode==='acp'){await request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'task-fixture',version:'1'}});({sessionId:id}=await request('session/new',{cwd:workspace,mcpServers:[]}));child.stdin.end()}
  else {child.stdin.end();await exited;const names=await readdir(sessions);const header=names.find(name=>name.endsWith('.jsonl')&&!name.endsWith('.doc.jsonl'));if(!header)throw Error(diagnostic);id=header.slice(0,-6)}
  expect(JSON.parse(await readFile(join(sessions,`task-${id}.doc.jsonl`),'utf8'))).toEqual({formatVersion:2,tasks:[],notifications:[]})
  expect(JSON.parse((await readFile(join(sessions,`${id}.jsonl`),'utf8')).split('\n')[0]!).formatVersion).toBe(14)
  await exited
 } finally {if(child.exitCode===null){child.kill();await exited};await rm(root,{recursive:true,force:true})}
},30000)
it.each(['run','sdk','acp'] as const)('actual %s entry starts without a persistence coordinator',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'cli-memory-')),workspace=join(root,'workspace'),profile=join(root,'config');await mkdir(workspace);await mkdir(profile)
 const child=spawn(process.execPath,['--import',loader,entry,mode,...(mode==='run'?['fixture']:[])],{cwd:workspace,env:{...process.env,IH_CONFIG_DIR:profile},stdio:'pipe',windowsHide:true})
 let buffer='',diagnostic='',next=0;const pending=new Map<number,{resolve(v:any):void;reject(e:Error):void}>()
 child.stderr.on('data',chunk=>{diagnostic+=chunk});child.stdout.on('data',chunk=>{buffer+=chunk;for(let end=buffer.indexOf('\n');end>=0;end=buffer.indexOf('\n')){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const x=JSON.parse(line),p=pending.get(x.id);if(p){pending.delete(x.id);x.error?p.reject(Error(JSON.stringify(x.error))):p.resolve(x.result)}}catch{}}})
 const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 const request=(method:string,params:unknown={})=>{const id=++next,promise=new Promise<any>((resolve,reject)=>pending.set(id,{resolve,reject}));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return Promise.race([promise,exited.then(code=>{throw Error(`exit ${code}: ${diagnostic}`)})])}
 try{
  if(mode==='sdk'){await request('initialize');await expect(request('session/create')).rejects.toThrow();await request('shutdown');child.stdin.end()}
  else if(mode==='acp'){await request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'memory-fixture',version:'1'}});expect((await request('session/new',{cwd:workspace,mcpServers:[]})).sessionId).toBeTruthy();child.stdin.end()}
  else child.stdin.end()
  await exited;expect(await readdir(workspace)).toEqual([])
 }finally{if(child.exitCode===null){child.kill();await exited};await rm(root,{recursive:true,force:true})}
},30000)
it.skipIf(!process.env.IH_TASK_D_PREDECESSOR_FIXTURES).each(['sdk','acp'] as const)('actual %s resumes an original13 parent through the durable transition',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'cli-resume-')),workspace=join(root,'workspace'),profile=join(root,'config'),sessions=join(root,'sessions');await mkdir(workspace);await mkdir(profile);await mkdir(sessions)
 const {copyFile}=await import('node:fs/promises'),original=join(process.env.IH_TASK_D_PREDECESSOR_FIXTURES!,'ordinary13.jsonl');await copyFile(original,join(sessions,'ordinary13.jsonl'))
 const child=spawn(process.execPath,['--import',loader,entry,mode,'--session-dir',sessions],{cwd:workspace,env:{...process.env,IH_CONFIG_DIR:profile},stdio:'pipe',windowsHide:true})
 let buffer='',diagnostic='',next=0;const pending=new Map<number,{resolve(v:any):void;reject(e:Error):void}>()
 child.stderr.on('data',chunk=>{diagnostic+=chunk});child.stdout.on('data',chunk=>{buffer+=chunk;for(let end=buffer.indexOf('\n');end>=0;end=buffer.indexOf('\n')){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const x=JSON.parse(line),p=pending.get(x.id);if(p){pending.delete(x.id);x.error?p.reject(Error(JSON.stringify(x.error))):p.resolve(x.result)}}catch{}}})
 const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 const request=(method:string,params:unknown={})=>{const id=++next,promise=new Promise<any>((resolve,reject)=>pending.set(id,{resolve,reject}));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return Promise.race([promise,exited.then(code=>{throw Error(`exit ${code}: ${diagnostic}`)})])}
 try{
  if(mode==='sdk'){await request('initialize');await request('session/prompt',{sessionId:'ordinary13',prompt:'fixture'}).catch(()=>{});await request('shutdown')}
  else{await request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'resume-fixture',version:'1'}});await request('session/resume',{sessionId:'ordinary13',cwd:workspace,mcpServers:[]})}
  child.stdin.end();await exited
  expect(JSON.parse((await readFile(join(sessions,'ordinary13.jsonl'),'utf8')).split('\n')[0]!).formatVersion).toBe(14)
  expect(JSON.parse(await readFile(join(sessions,'task-ordinary13.doc.jsonl'),'utf8')).formatVersion).toBe(2)
 }finally{if(child.exitCode===null){child.kill();await exited};await rm(root,{recursive:true,force:true})}
},30000)
it.skipIf(!process.env.IH_TASK_D_PREDECESSOR_FIXTURES)('actual run resumes an original13 parent through the durable transition',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'cli-run-resume-')),workspace=join(root,'workspace'),profile=join(root,'config'),sessions=join(root,'sessions');await mkdir(workspace);await mkdir(profile);await mkdir(sessions)
 const {copyFile}=await import('node:fs/promises');await copyFile(join(process.env.IH_TASK_D_PREDECESSOR_FIXTURES!,'ordinary13.jsonl'),join(sessions,'ordinary13.jsonl'))
 const child=spawn(process.execPath,['--import',loader,entry,'run','fixture','--session-dir',sessions,'--resume','ordinary13'],{cwd:workspace,env:{...process.env,IH_CONFIG_DIR:profile},stdio:'pipe',windowsHide:true})
 let diagnostic='';child.stderr.on('data',chunk=>diagnostic+=chunk);child.stdout.resume();const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 try{child.stdin.end();await exited;expect(JSON.parse((await readFile(join(sessions,'ordinary13.jsonl'),'utf8')).split('\n')[0]!).formatVersion,diagnostic).toBe(14);expect(JSON.parse(await readFile(join(sessions,'task-ordinary13.doc.jsonl'),'utf8')).formatVersion).toBe(2)}finally{if(child.exitCode===null){child.kill();await exited};await rm(root,{recursive:true,force:true})}
},30000)
