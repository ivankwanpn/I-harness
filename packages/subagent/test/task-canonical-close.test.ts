import {expect,it,onTestFinished} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import type {TaskProtocolDocument} from '../src/task/types.ts'
it.each(['aux-before','aux-after'])('normally closes a canonical Task without its duplicate %s cache writer',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'canonical-task-close-')),here=dirname(fileURLToPath(import.meta.url)),workspace=resolve(here,'../../..')
 const child=spawn(process.execPath,['--import',pathToFileURL(join(workspace,'node_modules/tsx/dist/loader.mjs')).href,join(here,'helpers/crash-canonical-task.ts'),root,mode,'graceful'],{windowsHide:true,stdio:['ignore','pipe','pipe']})
 onTestFinished(()=>{if(child.exitCode===null)child.kill()})
 let stdout='',stderr='';child.stdout.on('data',bytes=>{stdout+=String(bytes)});child.stderr.on('data',bytes=>{stderr+=String(bytes)})
 const status=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done)})
 expect(status,stderr).toBe(0)
 const outcome=JSON.parse(stdout.trim().split('\n').at(-1)!)
 expect(outcome).toMatchObject({childBodies:1,auxFailures:0,closed:true,waitedForReceipt:true})
 // Successful reopen also proves the original service/coordinator released
 // their real native owners rather than merely reporting a clean close.
 const sessions=join(root,'sessions'),coordinator=createJsonlTaskTransitionCoordinator(sessions,{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  const document=await coordinator.getDocument('task-parent') as TaskProtocolDocument
  expect(document).toMatchObject({formatVersion:3,tasks:[{outcome:'completed',result:{kind:'retained',envelope:{execution:{outcome:'succeeded',dispatch:'dispatched'}}}}]})
  expect(document.notifications).toHaveLength(1)
  expect(['delivered','suppressed'],JSON.stringify(outcome)).toContain(document.notifications[0]?.status)
  const events=(await createJsonlBackend(sessions).read('parent')).events
  expect(events.filter(event=>event.type==='subagent/end')).toHaveLength(1)
  expect(events.filter(event=>event.type==='agent/delivery-received'&&event.key.kind==='subagent')).toHaveLength(1)
 }finally{await coordinator.close()}
},60000)
