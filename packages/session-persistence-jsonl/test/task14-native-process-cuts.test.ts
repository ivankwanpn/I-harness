import { expect,it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { join,resolve,sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
const repo=resolve(import.meta.dirname,'../../..'),loader=pathToFileURL(join(repo,'node_modules/tsx/dist/loader.mjs')).href,worker=join(import.meta.dirname,'helpers/task14-native-cut-worker.mjs')
it.each(['task-before','task-after','header-before','header-after','committed'] as const)('survives process cut at %s using native lock and original file owner',async cut=>{
 const base=resolve(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!),root=await mkdtemp(join(base,'native14-'))
 if(!resolve(root).startsWith(base+sep))throw Error('Invalid isolated root')
 const child=spawn(process.execPath,['--import',loader,worker,root,cut],{cwd:repo,env:process.env,stdio:'pipe',windowsHide:true})
 let stderr='',stdout='';child.stderr.on('data',x=>stderr+=x)
 const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 const marker=new Promise<void>((resolve,reject)=>{child.stdout.on('data',x=>{stdout+=x;if(stdout.includes('CUT\n'))resolve()});void exited.then(code=>reject(Error(`worker exited ${code}: ${stderr}`)))})
 try{
  await Promise.race([marker,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error(`cut timed out: ${stderr}`)),15000))])
  const task=await readFile(join(root,'task-p.doc.jsonl'));expect(JSON.parse(task.toString()).formatVersion).toBe(2)
  if(cut.startsWith('task-'))await expect(readFile(join(root,'p.jsonl'))).rejects.toMatchObject({code:'ENOENT'})
  else expect(JSON.parse((await readFile(join(root,'p.jsonl'),'utf8')).split('\n')[0]!).formatVersion).toBe(14)
  const contender=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true},acquireDeadlineMs:100,acquireRetryMs:20},taskDocumentStorageContract)
  try{await expect(contender.create({sessionId:'p'})).rejects.toThrow()}finally{await contender.close()}
  child.kill();await exited
  const resumed=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true},acquireDeadlineMs:1000},taskDocumentStorageContract)
  try{if(cut.startsWith('task-')){await expect(resumed.create({sessionId:'p'})).rejects.toThrow();await expect(readFile(join(root,'p.jsonl'))).rejects.toMatchObject({code:'ENOENT'})}else expect((await resumed.loadOwned('p')).session.formatVersion).toBe(14);expect(await readFile(join(root,'task-p.doc.jsonl'))).toEqual(task)}finally{await resumed.close()}
 } finally {if(child.exitCode===null){child.kill();await exited};await rm(root,{recursive:true,force:true})}
},30000)
