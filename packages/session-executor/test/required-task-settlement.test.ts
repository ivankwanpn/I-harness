import { expect, it } from 'vitest'
import { createDeliveryFixture } from './helpers/required-task-delivery-fixture.ts'

it('drives the original active legacy child Task acknowledgment before required end after parent retirement', async () => {
 const f=await createDeliveryFixture({retiredSourceControl:true,expectedWarnings:["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]})
 try {
  await f.start()
  expect(f.launchCount(),JSON.stringify((await f.backend.read('parent')).events.filter(e=>e.type==='tool/result'))).toBe(1)
  const closing=f.service.close();void closing.catch(()=>{})
  // Service close synchronously fences new parent work before joining its child.
  await f.waitForChildCancellation();f.releaseChild()
  await closing
  const events=(await f.backend.read('parent')).events
  expect(events.filter(event=>event.type==='agent/delivery-source')).toHaveLength(1)
  expect(events.filter(event=>event.type==='subagent/end')).toHaveLength(1)
  expect(f.launchCount(),JSON.stringify((await f.backend.read('parent')).events.filter(e=>e.type==='tool/result'))).toBe(1)
  const taskDocument=await f.backend.getDocument('task-parent') as {formatVersion:number;tasks:{outcome?:string;result?:{revision:string}}[]}
  expect(taskDocument.formatVersion).toBe(2);expect(taskDocument.tasks).toHaveLength(1);expect(taskDocument.tasks[0]!.outcome).toBe('cancelled');const runtimeState=await f.backend.getDocument('parent') as {jobs:{status:string;terminal:boolean;result?:{revision:string}}[];agentTable:{status:string;result?:{revision:string}}[]};expect(runtimeState.jobs[0]).toMatchObject({status:'killed',terminal:true});expect(runtimeState.agentTable[0]!.status).toBe('killed');expect(f.legacyProjectionCalls()).toEqual({retainers:0,publications:0});expect(runtimeState.jobs[0]!.result?.revision).toBe(taskDocument.tasks[0]!.result?.revision);expect(runtimeState.agentTable[0]!.result?.revision).toBe(taskDocument.tasks[0]!.result?.revision);console.info('required-original-source-effects',JSON.stringify({root:f.root,runtimeJobs:runtimeState.jobs.map(j=>({status:j.status,terminal:j.terminal})),runtimeAgents:runtimeState.agentTable.map(e=>e.status),launches:f.launchCount(),sources:events.filter(e=>e.type==='agent/delivery-source').length,ends:events.filter(e=>e.type==='subagent/end').length,taskDocument}))
 } catch(cause) {console.info('required-legacy-primary',cause);throw cause} finally {f.releaseChild();await f.close()}
},20000)

it('holds the exact original Task acknowledgment before first required end issuance',async()=>{
 const f=await createDeliveryFixture({retiredSourceControl:true,holdTaskACK:true,expectedWarnings:["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]})
 try{
  await f.start();const closing=f.service.close();void closing.catch(()=>{})
  await f.waitForChildCancellation();f.releaseChild();await f.waitForTaskACK()
  expect((await f.backend.read('parent')).events.filter(e=>e.type==='subagent/end')).toHaveLength(0)
  let closed=false;void closing.then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false)
  f.releaseTaskACK();await closing
  expect((await f.backend.read('parent')).events.filter(e=>e.type==='subagent/end')).toHaveLength(1);expect(f.launchCount(),JSON.stringify((await f.backend.read('parent')).events.filter(e=>e.type==='tool/result'))).toBe(1)
 }finally{f.releaseTaskACK();f.releaseChild();await f.close()}
},20000)

it('keeps original Task physical unknown as debt and retries the same snapshot before end',async()=>{
 const f=await createDeliveryFixture({retiredSourceControl:true,holdTaskUnknown:true,expectedWarnings:["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]})
 try{
  await f.start();const closing=f.service.close();void closing.catch(()=>{})
  await f.waitForChildCancellation();f.releaseChild();await f.waitForTaskACK();await expect(closing).rejects.toThrow()
  expect((await f.backend.read('parent')).events.filter(e=>e.type==='subagent/end')).toHaveLength(0)
  const first=f.taskWriteSnapshots().at(-1);expect(first).toBeDefined();expect(f.terminalTaskSnapshotCount()).toBe(1)
  f.releaseTaskUnknown();await f.settleOriginalSpawnSources();await f.service.close()
  expect((await f.backend.read('parent')).events.filter(e=>e.type==='subagent/end')).toHaveLength(1);expect(f.launchCount(),JSON.stringify((await f.backend.read('parent')).events.filter(e=>e.type==='tool/result'))).toBe(1)
  expect(f.taskWriteSnapshots().slice(-2)).toEqual([first,first]);expect(f.terminalTaskSnapshotCount()).toBe(1)
 }finally{f.releaseTaskUnknown();f.releaseChild();await f.close()}
},20000)

it('reconciles an already-issued unknown original end without a new Task snapshot or launch',async()=>{
 const f=await createDeliveryFixture({retiredSourceControl:true,holdTerminalUnknown:true,expectedWarnings:["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]})
 try{
  await f.start();const closing=f.service.close();void closing.catch(()=>{})
  await f.waitForChildCancellation();f.releaseChild();await f.waitForHeldTerminal();await expect(closing).rejects.toThrow()
  expect(f.terminalTaskSnapshotCount()).toBe(1);expect(new Set(f.terminalKeys).size).toBe(1)
  const original=f.terminalKeys[0];f.releaseTerminalOutcome();await f.settleOriginalSpawnSources();await f.service.close()
  expect(f.terminalTaskSnapshotCount()).toBe(1);expect(f.terminalKeys.every(key=>key===original)).toBe(true);expect(f.launchCount(),JSON.stringify((await f.backend.read('parent')).events.filter(e=>e.type==='tool/result'))).toBe(1)
  expect((await f.backend.read('parent')).events.filter(e=>e.type==='subagent/end')).toHaveLength(1)
 }finally{f.releaseTerminalOutcome();f.releaseChild();await f.close()}
},20000)

it.each([false,true])('joins original Task and resident projection on direct parent close (jobStatusEvents=%s)',async(jobStatusEvents)=>{
 const f=await createDeliveryFixture({jobStatusEvents,retiredSourceControl:true,expectedWarnings:["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]})
 try{
  await f.start();const parent=await f.coordinator.openManagedDocument('parent'),closing=parent.close();void closing.catch(()=>{});expect(()=>parent.assertReady()).toThrow();expect((await parent.metadata.admit({type:'plan/mode',mode:'on'})).kind).toBe('not-issued')
  await f.waitForChildCancellation();f.releaseChild();await closing
  const runtime=await f.backend.getDocument('parent') as {jobs:{status:string;terminal:boolean}[];agentTable:{status:string}[]};expect(runtime.jobs[0]).toMatchObject({status:'killed',terminal:true});expect(runtime.agentTable[0]!.status).toBe('killed');expect(f.legacyProjectionCalls()).toEqual({retainers:0,publications:0});expect((await f.backend.read('parent')).events.filter(e=>e.type==='subagent/end')).toHaveLength(1);expect(f.launchCount(),JSON.stringify((await f.backend.read('parent')).events.filter(e=>e.type==='tool/result'))).toBe(1)
 }catch(cause){const{inspect}=await import('node:util');console.info('required-parent-projection-primary',inspect(cause,{depth:16}));console.info('required-parent-projection-facts',JSON.stringify((await f.backend.read('parent')).events.filter(e=>e.type==='job/status'||e.type==='subagent/end')));await f.diagnoseOriginalSources();throw cause}finally{f.releaseChild();await f.close()}
},20000)

it('keeps unavailable original end recovery eligible while refusing retired new drains',async()=>{
 const f=await createDeliveryFixture({holdTerminalUnknown:true,expectedWarnings:["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]})
 try{
  await f.start();const parent=await f.coordinator.openManagedDocument('parent');f.releaseChild();await f.waitForHeldTerminal();await f.waitForTerminalReconcile()
  const {managedExecutionStatus}=await import('@i-harness/session-persistence/internal/retained-inspection');expect(managedExecutionStatus(parent)).toBe('unavailable')
  f.releaseTerminalOutcome();await f.waitForTerminalCommitted();expect(new Set(f.terminalKeys).size).toBe(1);expect(f.launchCount(),JSON.stringify((await f.backend.read('parent')).events.filter(e=>e.type==='tool/result'))).toBe(1);expect(f.terminalTaskSnapshotCount()).toBe(1)
  await f.service.close()
 }finally{f.releaseTerminalOutcome();f.releaseChild();await f.close()}
},20000)

it('retains undispatched setup failure and original unknown Task save for same-source recovery',async()=>{
 const f=await createDeliveryFixture({failBeforePublication:true,holdTaskUnknown:true,retiredSourceControl:true,expectedWarnings:["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]})
 let primary:{cause:unknown}|undefined
 try{
  const starting=f.start();void starting.catch(()=>{});await f.waitForTaskACK();await starting.catch(()=>{})
  expect(f.launchCount()).toBe(0);expect(f.terminalTaskSnapshotCount()).toBe(1)
  f.coordinator.revokeManagedDocumentNewWork('parent');f.releaseTaskUnknown();await f.settleOriginalSpawnSources()
  const task=(await f.backend.getDocument('task-parent') as {tasks:{outcome:string;result:{envelope:{execution:{dispatch:string}}}}[]}).tasks[0]!
  expect(task.outcome).toBe('error');expect(task.result.envelope.execution.dispatch).toBe('not-dispatched');expect(f.terminalTaskSnapshotCount()).toBe(1);expect(f.launchCount()).toBe(0)
  expect((await f.backend.read('parent')).events.filter(e=>e.type==='subagent/end')).toHaveLength(1);await f.service.close()
 }catch(cause){primary={cause};console.info('required-undispatched-primary',cause)}finally{f.releaseTaskUnknown();f.releaseChild();try{await f.close()}catch(cleanup){throw new AggregateError([...(primary?[primary.cause]:[]),cleanup],'Original undispatched recovery failed')};if(primary)throw primary.cause}
},20000)

it('actual Task3 B2 original child persists its terminal once across real parent close',async()=>{
 const f=await createDeliveryFixture({b2:true,retiredSourceControl:true,expectedWarnings:["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]})
 try{
  await f.start();await f.waitForChildStarted();expect(f.launchCount(),JSON.stringify((await f.backend.read('parent')).events.filter(e=>e.type==='tool/result'))).toBe(1)
  const before=await f.backend.getDocument('task-parent') as {formatVersion:number;tasks:{childBirth?:unknown}[]};expect(before.formatVersion).toBe(3);expect(before.tasks[0]!.childBirth).toBeDefined()
  const closing=f.service.close();void closing.catch(()=>{});await f.waitForChildCancellation();f.releaseChild();await closing
  const after=await f.backend.getDocument('task-parent') as {formatVersion:number;tasks:{outcome:string}[]};expect(after.formatVersion).toBe(3);expect(after.tasks[0]!.outcome).toBe('cancelled');expect((await f.backend.read('parent')).events.filter(e=>e.type==='subagent/end')).toHaveLength(1);expect(f.launchCount(),JSON.stringify((await f.backend.read('parent')).events.filter(e=>e.type==='tool/result'))).toBe(1);expect(f.legacyProjectionCalls()).toEqual({retainers:0,publications:0})
 }finally{f.releaseChild();await f.close()}
},20000)

it.each(['task-unknown','end-unknown','stop-unknown','partial-publication'] as const)('actual Task3 B2 retained original source intersection: %s',async mode=>{
 const f=await createDeliveryFixture({b2:true,holdTaskUnknown:mode==='task-unknown'||mode==='stop-unknown',holdTerminalUnknown:mode==='end-unknown',failPartialPublication:mode==='partial-publication',retiredSourceControl:true,expectedWarnings:["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]})
 try{
  if(mode==='partial-publication'){
   await f.start().catch(()=>{});await f.settleOriginalSpawnSources();await f.service.close();expect(f.launchCount()).toBe(0)
  }else{
   await f.start();await f.waitForChildStarted();if(mode==='stop-unknown'){expect(f.stopOriginalTask().cancelled).toBe(1);await f.waitForTaskACK()}
   const closing=f.service.close();void closing.catch(()=>{});await f.waitForChildCancellation();f.releaseChild()
   if(mode==='end-unknown')await f.waitForHeldTerminal();else await f.waitForTaskACK()
   await expect(closing).rejects.toThrow();expect(f.terminalTaskSnapshotCount()).toBe(1)
   f.releaseTaskUnknown();f.releaseTerminalOutcome();await f.settleOriginalSpawnSources();await f.service.close();expect(f.launchCount()).toBe(1)
  }
  const document=await f.backend.getDocument('task-parent') as {formatVersion:number;tasks:{outcome?:string;childBirth?:unknown}[]};expect(document.formatVersion).toBe(3);expect(document.tasks).toHaveLength(1);expect(document.tasks[0]!.childBirth).toBeDefined();expect(document.tasks[0]!.outcome).toMatch(/cancelled|error/)
  expect((await f.backend.read('parent')).events.filter(e=>e.type==='subagent/end')).toHaveLength(1);expect(f.terminalTaskSnapshotCount()).toBe(1);expect(f.legacyProjectionCalls()).toEqual({retainers:0,publications:0})
 }finally{f.releaseTaskUnknown();f.releaseTerminalOutcome();f.releaseChild();await f.close()}
},20000)

it('actual B2 issued Task UNKNOWN recovers automatically on its same captured operation without producer replay',async()=>{
 const f=await createDeliveryFixture({b2:true,dropTaskACKOnce:true,expectedWarnings:["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]})
 try{await f.start();await f.waitForChildStarted();f.releaseChild();await f.waitForTaskACK();expect(f.terminalTaskSnapshotCount()).toBe(1);await f.waitForTerminalCommitted();await f.waitForDeliveryRequest();await f.waitForConsumed();const originalWrites=f.taskWriteSnapshots().filter(text=>(JSON.parse(text) as {tasks:{outcome?:string}[]}).tasks.some(task=>task.outcome!==undefined));expect(originalWrites[1]).toBe(originalWrites[0]);expect(f.terminalTaskSnapshotCount()).toBe(3);expect(f.launchCount()).toBe(1);const events=(await f.backend.read('parent')).events;expect(events.filter(event=>event.type==='subagent/end')).toHaveLength(1);expect(events.filter(event=>event.type==='agent/delivery-received')).toHaveLength(1);expect(f.legacyProjectionCalls()).toEqual({retainers:0,publications:0})}finally{f.releaseChild();await f.close()}
},60000)
it('actual Stop joins only captured parent journal debt while full Task recovery remains held',async()=>{
 const f=await createDeliveryFixture({b2:true,holdTaskUnknown:true,holdTaskCollector:true,expectedWarnings:["[subagent] role 'general' declares 3 tool(s) absent from the parent registry; the child runs without them: code_context_search, code_context_status, code_context_index"]})
 try{await f.start();await f.waitForChildStarted();f.releaseChild();await f.waitForTaskACK();expect(f.terminalTaskSnapshotCount()).toBe(1);await f.waitForTaskCollector();const assembly=await f.service.assemblyFor('parent');let fullDone=false;const full=assembly.settleParentDeliverySources!().then(()=>{fullDone=true});void full.catch(()=>{});f.service.cancelRunning!('parent');let timer:ReturnType<typeof setTimeout>;const receipt=await Promise.race([f.service.awaitDeliveryStop('parent'),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Stop waited on Task recovery/body')),4000)})]).finally(()=>clearTimeout(timer!));expect(receipt).toMatchObject({durability:'durable'});expect(fullDone).toBe(false);expect((await f.backend.read('parent')).events.filter(event=>event.type==='subagent/end')).toHaveLength(0);f.releaseTaskUnknown();f.releaseTaskCollector();await full;await f.waitForTerminalCommitted();await assembly.drainParentNotifications?.();const originalWrites=f.taskWriteSnapshots().filter(text=>(JSON.parse(text) as {tasks:{outcome?:string}[]}).tasks.some(task=>task.outcome!==undefined));expect(originalWrites[1]).toBe(originalWrites[0]);expect(f.launchCount()).toBe(1);expect((await f.backend.read('parent')).events.filter(event=>event.type==='agent/delivery-received')).toHaveLength(0)}finally{f.releaseTaskUnknown();f.releaseTaskCollector();f.releaseChild();await f.close()}
},60000)
