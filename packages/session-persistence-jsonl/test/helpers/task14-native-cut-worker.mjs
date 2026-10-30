import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const [root,cut]=process.argv.slice(2),base=resolve(import.meta.dirname,'../../../..'),original=fs.promises.open.bind(fs.promises)
let stopped=false
async function pause(){if(stopped)return;stopped=true;process.stdout.write('CUT\n');await new Promise(()=>{})}
fs.promises.open=async function(path,flags,...rest){
 const handle=await original(path,flags,...rest),name=String(path),expected=cut.startsWith('task-')?join(root,'task-p.doc.jsonl'):join(root,'p.jsonl')
 if(cut!=='committed'&&name===expected&&flags==='r+'){
  const sync=handle.sync.bind(handle);handle.sync=async()=>{if(cut.endsWith('-before'))await pause();await sync();if(cut.endsWith('-after'))await pause()}
 }
 return handle
}
syncBuiltinESMExports()
const {createJsonlTaskTransitionCoordinator}=await import(pathToFileURL(join(base,'packages/session-persistence-jsonl/src/task-document-factory.ts')).href)
const {taskDocumentStorageContract}=await import(pathToFileURL(join(base,'packages/subagent/src/task/storage-contract.ts')).href)
const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true},acquireDeadlineMs:1000},taskDocumentStorageContract)
setInterval(()=>{},1000)
try{await coordinator.create({sessionId:'p'});if(cut==='committed')await pause();else throw Error('Expected cut not reached')}catch(error){process.stderr.write(String(error?.stack??error));process.exit(2)}
