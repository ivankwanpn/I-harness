import { expect, it, vi } from 'vitest'
import type { TransportExecutionBackend } from '@i-harness/sandbox'
import { readDeliveries } from '@i-harness/core-session'
import { createExecDeliveryFixture } from './helpers/exec-delivery-fixture.ts'
import { receivedInputsFor } from '../src/lifecycle/received-inputs.ts'
const physical=vi.hoisted(()=>({backend:undefined as TransportExecutionBackend|undefined}))
vi.mock('../src/execution-runtime.ts',async original=>{const actual=await original<typeof import('../src/execution-runtime.ts')>();return{...actual,createAssemblyExecutionRuntime(...args:Parameters<typeof actual.createAssemblyExecutionRuntime>){const runtime=actual.createAssemblyExecutionRuntime(...args);runtime.execution.selectBackend=()=>{if(!physical.backend)throw new Error('Physical fixture not installed');return physical.backend};return runtime}}})
vi.mock('../../shell/src/discovery/windows.ts',()=>({bashAvailable:()=>true,resolveBashExe:()=> 'controlled-bash',resolvePwshExe:()=> 'controlled-pwsh',powerShellExecutableAvailable:()=>true}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async original=>{
 const actual=await original<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>()
 return{...actual,createFactJournalBackend(...args:Parameters<typeof actual.createFactJournalBackend>){const journal=actual.createFactJournalBackend(...args);return{...journal,appendOwnedBatch:vi.fn(journal.appendOwnedBatch),reconcileOwnedBatch:vi.fn(journal.reconcileOwnedBatch)}}}
})

it('original Exec terminal admits one receipt and wakes idle existing lane after complete native IO and retention',async()=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{holdIo:true})
 try{
   await f.start();expect(f.requests).toHaveLength(2);expect(f.launches()).toBe(1)
   expect(readDeliveries(f.document.view).execPending()).toHaveLength(0)
   f.releaseRoot();await new Promise<void>(resolve=>setImmediate(resolve))
   expect(f.document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(0);expect(f.requests).toHaveLength(2)
   f.releaseIo();await f.terminal
   expect(f.document.view.events.find(e=>e.type==='exec/end')).toMatchObject({execution:{dispatch:'dispatched',outcome:'succeeded'},dependency:{retention:{kind:'artifact',ref:{codec:'exec-frames-v1'}}}})
   await vi.waitFor(()=>expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received'&&e.key.kind==='exec')).toHaveLength(1),{timeout:2000})
   await f.consumed
   await vi.waitFor(()=>expect(f.requests).toHaveLength(3),{timeout:2000})
   const events=f.document.view.events,terminal=events.find(e=>e.type==='exec/end')!,receipt=events.find(e=>e.type==='agent/delivery-received')!
   expect(terminal).toMatchObject({execution:{dispatch:'dispatched',outcome:'succeeded'},dependency:{retention:{kind:'artifact',ref:{codec:'exec-frames-v1'}}}})
   expect(events.filter(e=>e.type==='agent/input/promoted'&&e.inputId===receipt.inputId)).toHaveLength(1)
   expect(f.launches()).toBe(1);expect(f.releases()).toBe(1);expect(f.cancels()).toBe(0)
   expect(JSON.stringify(f.requests[2]!.body.messages)).toContain('exec')
   if(terminal.type!=='exec/end'||!('dependency' in terminal)||terminal.dependency.retention.kind!=='artifact')throw new Error('Missing original artifact')
   const query={ref:terminal.dependency.retention.ref,textView:true}
   const page=await f.service.readResultPage!('parent',query)
   expect(JSON.stringify(page)).toContain('original retained Exec output')
   expect(await f.service.readResultPage!('parent',query)).toEqual(page)
   f.service.queue('parent');f.service.queueState('parent');f.service.liveSession('parent')
   expect(f.requests).toHaveLength(3)
 }finally{await f.close()}
},15000)

it.each([0,7])('actual background outcome %s and genuine promotion reuse one original receipt/input',async exitCode=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{exitCode,promotion:true})
 try{await f.start();expect(f.document.view.events.filter(e=>e.type==='agent/delivery-handoff')).toHaveLength(1);f.releaseRoot();await f.terminal;await vi.waitFor(()=>expect(f.requests).toHaveLength(3),{timeout:2000});await f.consumed
   const terminal=f.document.view.events.find(e=>e.type==='exec/end')!,receipt=f.document.view.events.find(e=>e.type==='agent/delivery-received')!
   expect(terminal).toMatchObject({execution:{dispatch:'dispatched',outcome:exitCode===0?'succeeded':'failed'}})
   const adapter=receivedInputsFor(f.document,'parent').delivery
   expect(await adapter.admitExec({kind:'exec',sourceSeq:receipt.sourceSeq,terminalSeq:receipt.terminalSeq})).toMatchObject({inputId:receipt.inputId,disposition:'claimed'})
   expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toHaveLength(1);expect(f.launches()).toBe(1)
 }finally{await f.close()}
},15000)

it.each(['foreground','null-root','Stop'] as const)('%s keeps original result readable and cannot issue a completion receipt',async mode=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{foreground:mode==='foreground',exitCode:mode==='null-root'?null:0})
 try{
   const starting=f.start();await f.issued
   if(mode!=='foreground')await starting
   if(mode==='Stop'){f.service.cancelRunning!('parent');await f.service.awaitDeliveryStop('parent')}
   f.releaseRoot();await starting;await f.terminal;await f.checkpoint();await receivedInputsFor(f.document,'parent').delivery.settle()
   expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toHaveLength(0);expect(readDeliveries(f.document.view).execPending()).toHaveLength(0);expect(f.requests).toHaveLength(2);expect(f.launches()).toBe(1)
 }finally{await f.close()}
},15000)

it('Stop in original receipt preparation fences issue and later human cannot revive old terminal',async()=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{holdReceipt:true})
 try{await f.start();f.releaseRoot();await f.receiptPrepared;f.service.cancelRunning!('parent');f.releaseReceipt();await f.service.awaitDeliveryStop('parent');await f.service.submit('parent','new human after Stop',new AbortController().signal);await f.checkpoint();await receivedInputsFor(f.document,'parent').delivery.settle()
   expect(f.document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(1);expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toHaveLength(0);expect(f.requests).toHaveLength(3);expect(f.launches()).toBe(1)
 }finally{await f.close()}
},15000)

it.each(['unknown','false','undefined'] as const)('original physically landed %s receipt reconciles same capture/key and wakes once without native replay',async mode=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{unknownReceipt:mode==='unknown',...mode!=='unknown'?{receiptFailure:mode}:{}})
 try{await f.start();f.releaseRoot();await f.receiptUnknown;expect(f.requests).toHaveLength(2);f.releaseUnknownReceipt();await vi.waitFor(()=>expect(f.requests).toHaveLength(3),{timeout:3000});await f.consumed
   expect(new Set(f.receiptKeys).size).toBe(1);expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toHaveLength(1);expect(f.launches()).toBe(1)
 }finally{await f.close()}
},15000)

it('nominal transient original Exec admission retries through existing error scheduler without new event/input/launch',async()=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{exitCode:9,transientAdmission:true})
 try{await f.start();f.releaseRoot();await f.terminal;await vi.waitFor(()=>expect(f.requests).toHaveLength(3),{timeout:3000});await f.consumed
   expect(f.refusals()).toBe(4);expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toHaveLength(1);expect(f.document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(1);expect(f.launches()).toBe(1)
 }finally{await f.close()}
},15000)

it('active original provider step and idle hint claim one original input without interrupting model request',async()=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{holdParent:true})
 const starting=f.start();void starting.catch(()=>{})
 try{await f.parentEntered;f.releaseRoot();await f.receipt;expect(f.requests).toHaveLength(2);f.releaseParent();await starting;await vi.waitFor(()=>expect(f.requests).toHaveLength(3),{timeout:2000});await f.consumed
   const receipt=f.document.view.events.find(e=>e.type==='agent/delivery-received')!
   expect(f.document.view.events.filter(e=>e.type==='agent/input/promoted'&&e.inputId===receipt.inputId)).toHaveLength(1);expect(f.launches()).toBe(1);expect(f.cancels()).toBe(0)
 }finally{f.releaseParent();await starting.catch(()=>{});await f.close()}
},15000)

it.each([false,true])('cold original qualified terminal recovery respects confirmed generation close (%s)',async fenced=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{holdReceipt:true})
 try{
   await f.start();f.releaseRoot();await f.receiptPrepared
   const retiring=fenced?(f.service.cancelRunning!('parent'),f.service.awaitDeliveryStop('parent')):f.service.close()
   f.releaseReceipt();await retiring
   expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toHaveLength(0)
   expect(f.document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(1)
   const before=await f.journal(),taskBefore=await f.backend.getDocument('task-parent')
   await f.reopen()
   const assembly=await f.service.assemblyFor('parent')
   await receivedInputsFor(assembly.factOwner,'parent').delivery.settle()
   if(fenced){expect(f.requests).toHaveLength(2);expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toHaveLength(0)}
   else{await vi.waitFor(()=>expect(f.requests).toHaveLength(3),{timeout:2000});await f.consumed;expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toHaveLength(1)}
   expect(f.launches()).toBe(1)
   expect((await f.journal()).subarray(0,before.length)).toEqual(before);expect(await f.backend.getDocument('task-parent')).toEqual(taskBefore)
 }finally{await f.close()}
},15000)

it.each(['retentionDebt','nativeDebt'] as const)('original %s stays recovery-required until actual cleanup acknowledgment before recipient wake',async mode=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{[mode]:true})
 try{await f.start();f.releaseRoot();await f.debt;await f.recoveryHeld;await expect(f.requestOriginalCheckpoint()).rejects.toThrow()
   expect(f.document.view.events.filter(e=>e.type==='exec/end'||e.type==='agent/delivery-received')).toHaveLength(0);expect(f.requests).toHaveLength(2)
   f.releaseDebt();await f.checkpoint();await f.terminal
   if(mode==='retentionDebt'){await vi.waitFor(()=>expect(f.requests).toHaveLength(3),{timeout:2000});await f.consumed}
   else{await receivedInputsFor(f.document,'parent').delivery.reconcileExecCandidates();expect(f.requests).toHaveLength(2);expect(f.document.view.events.find(e=>e.type==='exec/end')).toMatchObject({execution:{outcome:'unknown'}})}
   expect(f.launches()).toBe(1);expect(f.document.view.events.filter(e=>e.type==='exec/end')).toHaveLength(1);expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toHaveLength(mode==='retentionDebt'?1:0)
 }finally{await f.close()}
},15000)

it('actual Code Mode broker nested Shell keeps resultConsumer code and never becomes a host completion source',async()=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{nestedCode:true})
 try{await f.start();expect(f.launches()).toBe(1);f.releaseRoot();const assembly=await f.service.assemblyFor('parent');const exec=assembly.ctx.services.get<import('@i-harness/exec').ExecService>('exec/service');await exec.dispose();await f.checkpoint()
   expect(f.document.view.events.filter(e=>e.type==='agent/delivery-source'||e.type==='exec/end'||e.type==='agent/delivery-received')).toHaveLength(0);expect(f.requests).toHaveLength(2)
 }finally{await f.close()}
},15000)

it('original quota-refused frame retention is terminal metadata without eligible artifact or completion wake',async()=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{artifactRefused:true})
 try{await f.start();f.releaseRoot();await f.terminal;await f.checkpoint();await receivedInputsFor(f.document,'parent').delivery.reconcileExecCandidates()
   expect(f.document.view.events.find(e=>e.type==='exec/end')).toMatchObject({execution:{dispatch:'dispatched',outcome:'succeeded'},dependency:{retention:{kind:'unavailable',reason:'quota'}}})
   expect(f.requests).toHaveLength(2);expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toHaveLength(0);expect(f.launches()).toBe(1)
 }finally{await f.close()}
},15000)

it('Stop at actual original lane promotion fence preserves receipt and suppresses claim even after new human',async()=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{holdPromotion:true})
 try{await f.start();f.releaseRoot();await f.promotionPrepared;const receipt=f.document.view.events.find(e=>e.type==='agent/delivery-received')!
   f.service.cancelRunning!('parent');f.releasePromotion();await f.service.awaitDeliveryStop('parent');await f.service.submit('parent','new human after promotion Stop',new AbortController().signal)
   const adapter=receivedInputsFor(f.document,'parent').delivery
   expect(await adapter.admitExec({kind:'exec',sourceSeq:receipt.sourceSeq,terminalSeq:receipt.terminalSeq})).toMatchObject({inputId:receipt.inputId,disposition:'suppressed'})
   expect(f.document.view.events.filter(e=>e.type==='agent/input/promoted'&&e.inputId===receipt.inputId)).toHaveLength(0);expect(f.requests).toHaveLength(3);expect(JSON.stringify(f.requests.map(r=>r.body.messages))).not.toContain('<exec_result>');expect(f.launches()).toBe(1)
 }finally{await f.close()}
},15000)

it('cold persisted pending Exec receipt crash image preserves original inputId and physical source records without replay',async()=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{holdPromotion:true})
 try{await f.start();f.releaseRoot();await f.promotionPrepared;const receipt=f.document.view.events.find(e=>e.type==='agent/delivery-received')!
   const taskBefore=await f.backend.getDocument('task-parent'),before=await f.reopenPendingSnapshot()
   await vi.waitFor(()=>expect(f.requests).toHaveLength(3),{timeout:2000});await f.consumed
   expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toEqual([receipt]);expect(f.document.view.events.filter(e=>e.type==='agent/input/promoted'&&e.inputId===receipt.inputId)).toHaveLength(1)
   const persisted=await f.backend.read('parent');expect((await f.journal()).subarray(0,before.length)).toEqual(before)
   expect(persisted.events.filter(e=>e.type==='agent/delivery-source')).toHaveLength(1);expect(await f.backend.getDocument('task-parent')).toEqual(taskBefore);expect(f.launches()).toBe(1)
 }finally{await f.close()}
},15000)

it('cold original stopped observation action cannot be recreated from its historically pending receipt',async()=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{holdPromotion:true})
 try{await f.start();f.releaseRoot();await f.promotionPrepared;const receipt=f.document.view.events.find(e=>e.type==='agent/delivery-received')!
   const closing=f.service.close();f.releasePromotion();await closing;const priorErrors=f.errors().length;await f.reopen();const adapter=receivedInputsFor(f.document,'parent').delivery
   expect(await adapter.admitExec({kind:'exec',sourceSeq:receipt.sourceSeq,terminalSeq:receipt.terminalSeq})).toMatchObject({inputId:receipt.inputId,disposition:'pending'})
   await vi.waitFor(()=>expect(f.errors().length).toBeGreaterThan(priorErrors),{timeout:2000})
   const action=f.document.view.events.find(e=>e.type==='context/action'&&e.op==='open'&&e.origin.kind==='observation-input'&&e.origin.inputId===receipt.inputId)
   expect(action).toBeDefined();if(action?.type!=='context/action'||action.op!=='open')throw new Error('Missing original observation action')
   expect(f.document.view.events.filter(e=>e.type==='context/action'&&e.op==='open'&&e.origin.kind==='observation-input'&&e.origin.inputId===receipt.inputId)).toHaveLength(1)
   expect(f.document.view.events.find(e=>e.type==='context/action'&&e.op==='close'&&e.actionId===action.actionId)).toMatchObject({disposition:'stopped'})
   expect(f.requests).toHaveLength(2);expect(f.document.view.events.filter(e=>e.type==='agent/input/promoted'&&e.inputId===receipt.inputId)).toHaveLength(0);expect(f.launches()).toBe(1)
 }finally{await f.close()}
},15000)

it('actual original input cancellation suppresses queued idle hint and repeats the same cancelled receipt',async()=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{holdParent:true})
 const starting=f.start();void starting.catch(()=>{})
 try{await f.parentEntered;f.releaseRoot();await f.receipt;const receipt=f.document.view.events.find(e=>e.type==='agent/delivery-received')!
   await vi.waitFor(()=>expect(f.service.queue('parent').some(row=>row.id===receipt.inputId)).toBe(true),{timeout:2000})
   expect(await f.service.cancelQueued('parent',receipt.inputId)).toMatchObject({cancelled:true});f.releaseParent();await starting
   const adapter=receivedInputsFor(f.document,'parent').delivery
   expect(await adapter.admitExec({kind:'exec',sourceSeq:receipt.sourceSeq,terminalSeq:receipt.terminalSeq})).toMatchObject({inputId:receipt.inputId,disposition:'cancelled'})
   expect(f.requests).toHaveLength(2);expect(f.document.view.events.filter(e=>e.type==='agent/input/promoted'&&e.inputId===receipt.inputId)).toHaveLength(0);expect(f.launches()).toBe(1)
 }finally{f.releaseParent();await starting.catch(()=>{});await f.close()}
},15000)

it('recipient re-reads exact Exec source and terminal and refuses subagent casts or DTO authority upgrades',async()=>{
 const f=await createExecDeliveryFixture(backend=>{physical.backend=backend},{holdReceipt:true})
 try{await f.start();f.releaseRoot();await f.receiptPrepared;const source=f.document.view.events.find(e=>e.type==='agent/delivery-source'&&e.kind==='exec')!,terminal=f.document.view.events.find(e=>e.type==='exec/end')!,adapter=receivedInputsFor(f.document,'parent').delivery
   const evidence={kind:'exec' as const,sourceSeq:source.seq!,terminalSeq:terminal.seq!}
   await expect(adapter.admit(evidence,{text:'forged spawn result',description:'forged',display:{kind:'task',title:'forged',body:'forged'}})).rejects.toMatchObject({deliveryDisposition:{reason:'invalid'}})
   await expect(adapter.admitExec({...evidence,sourceSeq:source.seq!-1})).rejects.toMatchObject({deliveryDisposition:{reason:'invalid'}})
   await expect(adapter.admitExec({...evidence,terminalSeq:terminal.seq!+1})).rejects.toMatchObject({deliveryDisposition:{reason:'invalid'}})
   const upgraded={...evidence,sourceId:'forged-authority'}
   await expect(adapter.admitExec(upgraded)).rejects.toMatchObject({deliveryDisposition:{reason:'invalid'}})
   expect(f.document.view.events.filter(e=>e.type==='agent/delivery-received')).toHaveLength(0);f.releaseReceipt();await vi.waitFor(()=>expect(f.requests).toHaveLength(3),{timeout:2000});expect(f.launches()).toBe(1)
 }finally{await f.close()}
},15000)
