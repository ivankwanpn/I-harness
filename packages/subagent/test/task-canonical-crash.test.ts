import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {expect,it,onTestFinished} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
import {createContext} from '@i-harness/core-plugin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {createManagedAgentModelOriginOwner} from '@i-harness/core-agent/model-origin'
import {createContextOutputService} from '../../context-output/src/index.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {receivedExecutionInputsFor} from '../../session-executor/src/lifecycle/execution-inputs.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {registerExec} from '@i-harness/exec'
import {registerSubagent,SHIPPING_REPORT_POLICY} from '../src/index.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import type {TaskProtocolDocument} from '../src/task/types.ts'
it.each(['normal','stop','unknown-parent-ack','unknown-receipt-ack','aux-before','aux-after','unknown-native'] as const)('cold restores native completion after a crash before projection: %s',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'canonical-task-crash-'))
 const here=dirname(fileURLToPath(import.meta.url)),workspace=resolve(here,'../../..')
 const child=spawn(process.execPath,['--import',pathToFileURL(join(workspace,'node_modules/tsx/dist/loader.mjs')).href,join(here,'helpers/crash-canonical-task.ts'),root,mode],{windowsHide:true,stdio:['ignore','pipe','pipe']})
 onTestFinished(()=>{if(child.exitCode===null)child.kill()})
 let stdout='',stderr='';child.stdout.on('data',bytes=>{stdout+=String(bytes)});child.stderr.on('data',bytes=>{stderr+=String(bytes)})
 const status=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done)})
 expect(status,stderr).toBe(0);const original=JSON.parse(stdout.trim().split('\n').at(-1)!) as {childBodies:number;auxFailures:number}
 expect(original.childBodies).toBe(1);expect(original.auxFailures).toBe(0)
 let uncertain=false,endWrites=0,receiptWrites=0,holdReceiptReconcile=mode==='unknown-receipt-ack'
 const backend=createJsonlBackend(join(root,'sessions'),{wrapOwnedBatch(append){return async(...input)=>{
  const bytes=Buffer.from(input[3].bytes).toString('utf8'),end=bytes.includes('"type":"subagent/end"'),receipt=bytes.includes('"type":"agent/delivery-received"')&&bytes.includes('"kind":"subagent"')
  const result=await append(...input)
  if(end){endWrites++;if(mode==='unknown-parent-ack'&&!uncertain){uncertain=true;return{kind:'unknown' as const,key:input[3].key}}}
  if(receipt){receiptWrites++;if(mode==='unknown-receipt-ack'&&!uncertain){uncertain=true;return{kind:'unknown' as const,key:input[3].key}}}
  return result
 }},wrapOwnedReconcile(reconcile){return async(...input)=>{
  const result=await reconcile(...input),bytes=Buffer.from(input[3].bytes).toString('utf8')
  if(holdReceiptReconcile&&bytes.includes('"type":"agent/delivery-received"')&&bytes.includes('"kind":"subagent"'))return{kind:'unknown' as const,key:input[3].key}
  return result
 }}}),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 const doc=await coordinator.getDocument('task-parent') as TaskProtocolDocument
 expect(doc.formatVersion).toBe(3);expect(doc.tasks[0]).toMatchObject({outcome:'completed',result:{kind:'retained',envelope:{execution:{outcome:'succeeded',dispatch:'dispatched'}}}})
 expect(doc.notifications).toHaveLength(1);expect(doc.notifications[0]?.status).toBe('pending')
 expect((await backend.read('parent')).events.filter(event=>event.type==='subagent/end')).toHaveLength(0)
 if(mode==='unknown-native'){
  // Adversarial current-format data is not a known execution result. Even a
  // real child birth and protected native read cannot promote unknown bytes.
  const task=doc.tasks[0]!
  task.status='recovery-required';task.outcome='recovery-required';task.recoveryReason='dispatch-unknown'
  if(task.result?.kind!=='retained')throw Error('Original retained fixture required')
  task.result.envelope.execution={outcome:'unknown',dispatch:'unknown'}
  delete task.savedObservation;delete task.publication
  doc.notifications[0]!.state='recovery-required'
  await coordinator.putDocumentStrict!('task-parent',doc)
 }
 const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution)
 const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'parent'}},origin.verifier)
 const inputs=receivedExecutionInputsFor(execution),recipient=inputs.taskDelivery(origin.domain),output=createContextOutputService({root:join(root,'output'),workspaceId:'canonical-crash'})
 let primary:unknown,failed=false
 let admissions=0,wakes=0
 const mounted=registerSubagent(ctx,pair.registry,{managedParent:{domain:origin.domain,execution},parentModel:createOpenAICompatibleClient({apiKey:'loopback',model:'must-not-run',baseUrl:'http://127.0.0.1:1'}),exec:registerExec(ctx),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),resolveModel:async()=>{throw Error('Old body must never prepare again')},reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(output,undefined,'parent'),parentNotify:{
 prepareTaskDelivery:input=>recipient.prepareTaskLaunch(input),taskEvidence:(namespace,id)=>recipient.taskEvidence(namespace,id),
 async admitTaskDelivery({evidence,text,description,display}){admissions++;return recipient.admitTask(evidence,{text,description,display})},
 async admit(){throw Error('Legacy delivery forbidden')},wake(){wakes++}
 },persist:{coordinator,stateId:'parent',parentSessionId:'parent'}})
 try{
  await mounted.ready
  if(mode==='unknown-native'){
   expect(mounted.tasks.get('task-1')).toMatchObject({outcome:'recovery-required',publication:'unqualified'})
   await mounted.drainParentNotifications();await mounted.drainParentNotifications()
   expect((await backend.read('parent')).events.filter(event=>event.type==='subagent/end')).toHaveLength(0)
   expect(endWrites).toBe(0);expect(admissions).toBe(0);expect(wakes).toBe(0)
   expect(await coordinator.getDocument('task-parent')).toEqual(doc)
   return
  }
  if(mode==='stop')await recipient.requestClose('user-stop').settled
  const restored=mounted.tasks.get('task-1')!;expect(restored).toMatchObject({status:'completed',outcome:'completed',publication:'unqualified'})
  if(mode==='unknown-parent-ack'){await expect(mounted.drainParentNotifications()).rejects.toThrow();expect(restored.outcome).toBe('completed')}
  if(mode==='unknown-receipt-ack'){
   await expect(mounted.drainParentNotifications()).rejects.toThrow()
   expect(restored.outcome).toBe('completed')
   // Only the actual recipient that owns this capture can reconcile it.
   holdReceiptReconcile=false
   await recipient.settle()
  }
  await mounted.drainParentNotifications();await mounted.drainParentNotifications()
  expect(mounted.tasks.get('task-1')).toMatchObject({status:'completed',publication:'committed'})
  const events=(await backend.read('parent')).events
  expect(events.filter(event=>event.type==='subagent/end')).toHaveLength(1)
  expect(events.filter(event=>event.type==='agent/delivery-received'&&event.key.kind==='subagent')).toHaveLength(mode==='stop'?0:1)
  expect(endWrites).toBe(1)
  expect(receiptWrites).toBe(mode==='stop'?0:1)
  expect(admissions).toBe(mode==='unknown-receipt-ack'?2:1);if(mode==='stop'){expect(wakes).toBe(0);expect(mounted.tasks.notifications()[0]?.status).toBe('suppressed')}else expect(wakes).toBeGreaterThan(0)
  expect((await mounted.tasks.readResult('task-1',{maxBytes:2048})).data.text).toContain('canonical original child result')
 }catch(error){primary=error;failed=true}finally{const errors:unknown[]=[];for(const close of [()=>mounted.dispose(),()=>inputs.close(),()=>output.close(),()=>coordinator.close()])try{await close()}catch(error){errors.push(error)}if(failed||errors.length){const failure=new AggregateError(failed?[primary,...errors]:errors,'Canonical Task crash recovery or cleanup failed');console.dir(failure,{depth:8});throw failure}}
},60000)
