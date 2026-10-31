import { expect,it,vi } from 'vitest'
const probe=vi.hoisted(()=>({root:'',phase:'' as string,entered:undefined as undefined|(()=>void),gate:undefined as undefined|Promise<void>,fail:false,cause:undefined as unknown,consumeRelease:false,closes:0,leases:0,pins:0,confirm:'real',calls:0,onConfirm:undefined as undefined|(()=>void),onValidate:undefined as undefined|(()=>void),assertLatch:undefined as undefined|(()=>void)}))
vi.mock('../src/coordinator/ownership.ts',async original=>{const real=await original<typeof import('../src/coordinator/ownership.ts')>();return {...real,createOwnership(...args:Parameters<typeof real.createOwnership>){const owner=real.createOwnership(...args),lease=owner.acquireDocumentLease;owner.acquireDocumentLease=async id=>{const held=await lease(id),release=held.release;held.release=async()=>{if(id==='task-parent'&&probe.root){probe.leases++;if(probe.phase==='lease'){probe.entered?.();await probe.gate;if(probe.consumeRelease)await release();if(probe.fail)throw probe.cause}}await release()};return held};return owner}}})
vi.mock('../../session-persistence-jsonl/src/backend/task-document-observation.ts',async original=>{const real=await original<typeof import('../../session-persistence-jsonl/src/backend/task-document-observation.ts')>();return {...real,createTaskDocumentObservation(...args:Parameters<typeof real.createTaskDocumentObservation>){const raw=real.createTaskDocumentObservation(...args);return {...raw,observe:()=>raw.observe(),stageWrite:(...input:Parameters<typeof raw.stageWrite>)=>raw.stageWrite(...input),stageInitialize:(...input:Parameters<typeof raw.stageInitialize>)=>raw.stageInitialize(...input),async confirm(witness:Parameters<typeof raw.confirm>[0]){if(args[0]!==probe.root)return raw.confirm(witness);probe.calls++;probe.onConfirm?.();if(probe.confirm==='pending'){probe.entered?.();await probe.gate}const result=await raw.confirm(witness);if(probe.confirm==='unknown'){probe.confirm='real';return {kind:'unknown' as const,cleanupPending:false}}if(probe.confirm==='conflict')return {kind:'conflict' as const,cleanupPending:false};if(probe.confirm==='cleanup')return {kind:'confirmed' as const,cleanupPending:true};return result},async settleResources(){if(args[0]===probe.root){probe.closes++;if(probe.phase==='backend'){probe.entered?.();await probe.gate;if(probe.fail)throw probe.cause}}await raw.settleResources()}}}}})
vi.mock('../src/coordinator/process-read-latches.ts',async original=>{const real=await original<typeof import('../src/coordinator/process-read-latches.ts')>();return {...real,createProcessReadLatches(...args:Parameters<typeof real.createProcessReadLatches>){const owner=real.createProcessReadLatches(...args),capture=owner.capture;owner.capture=input=>{const latch=capture(input);if(input.sessionId==='parent'&&input.mode==='cold'&&input.documentKeys.includes('task-parent'))probe.assertLatch=()=>latch.assertCurrent();return latch};return owner}}})
// Pause invocation of the exact captured claim release without replacing any
// claim descriptor or bypassing the original claim-identity checks.
const originalApply=Reflect.apply
vi.spyOn(Reflect,'apply').mockImplementation((fn,receiver,args)=>{
 if(probe.root&&fn.name==='release'&&receiver&&Object.hasOwn(receiver,'retainLive')&&probe.phase==='pin')return(async()=>{probe.pins++;probe.entered?.();await probe.gate;if(probe.consumeRelease)await originalApply(fn,receiver,args);if(probe.fail)throw probe.cause;return originalApply(fn,receiver,args)})()
 return originalApply(fn,receiver,args)
})
import { mkdtemp,rm,readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { taskDocumentOperationsFor } from '@i-harness/session-persistence/internal/task-document-operations'
async function fixture(){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'read-leaf-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},{...taskDocumentStorageContract,validate(value:unknown){taskDocumentStorageContract.validate(value);probe.onValidate?.()}})
 await coordinator.create({sessionId:'parent'});await coordinator.create({sessionId:'other'});const parent=await coordinator.openManagedDocument('parent'),other=await coordinator.openManagedDocument('other'),ops=taskDocumentOperationsFor(coordinator)!
 probe.root=root;probe.phase='';probe.confirm='real';probe.fail=false;probe.consumeRelease=false;probe.closes=probe.leases=probe.pins=probe.calls=0
 async function observed(doc=parent){const op=await ops.begin(ops.parent(doc)),seen=await op.observe();if(seen.kind!=='present')throw Error('absent');return{op,seen}}
 async function armed(){const {op,seen}=await observed();expect((await op.confirm(seen.witness)).kind).toBe('confirmed');return{op,seen,handle:op.prepareReadHandoff(seen.witness)}}
 return{root,coordinator,parent,other,ops,observed,armed,async close(){probe.root='';probe.phase='';probe.fail=false;probe.gate=undefined;probe.onConfirm=probe.onValidate=undefined;await coordinator.close();await rm(root,{recursive:true,force:true})}}
}
it.each(['backend','lease','pin'].flatMap(phase=>['key','parent','unrelated'].map(mutation=>({phase,mutation}))))('shared production latch rejects $mutation mutation during original $phase close window',async({phase,mutation})=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 try{const {op,handle}=await f.armed();probe.phase=phase;probe.gate=release.promise;probe.entered=entered.resolve;const closing=op.close();await entered.promise
 const writing=mutation==='key'?f.coordinator.putDocumentStrict!('task-parent',{formatVersion:2,tasks:[],notifications:[]}):(mutation==='parent'?f.parent:f.other).metadata.admit({type:'plan/mode',mode:'on'});void writing.catch(()=>{});if(mutation==='unrelated'){await writing;expect(()=>probe.assertLatch!()).not.toThrow()}else await vi.waitFor(()=>expect(()=>probe.assertLatch!()).toThrow());probe.phase='';release.resolve();await closing;await writing
 if(mutation==='unrelated')expect(()=>handle.consume()).not.toThrow();else expect(()=>handle.consume()).toThrow();await f.coordinator.flush('parent');const fresh=await f.observed(f.other);await fresh.op.close()
 }finally{release.resolve();await f.close()}
})
it('canonical away-and-back task ABA after clean close cannot revive the original read',async()=>{
 const f=await fixture();try{const {op,handle}=await f.armed();await op.close();const before=await readFile(join(f.root,'task-parent.doc.jsonl'));await f.coordinator.putDocumentStrict!('task-parent',{formatVersion:1,tasks:[],notifications:[]});await f.coordinator.putDocumentStrict!('task-parent',{formatVersion:2,tasks:[],notifications:[]});expect(await readFile(join(f.root,'task-parent.doc.jsonl'))).toEqual(before);expect(()=>handle.consume()).toThrow();const fresh=await f.armed();await fresh.op.close();fresh.handle.consume();await f.coordinator.flush('parent')}finally{await f.close()}
})
it.each(['parent','coordinator','delete'] as const)('external %s retirement completes after read close without installer participation',async retirement=>{
 const f=await fixture();try{const {op,handle}=await f.armed();await op.close();if(retirement==='parent')await f.coordinator.closeManagedDocument('parent');else if(retirement==='delete')await f.coordinator.deleteOwnedSession!('parent',{documents:['task-parent']});else await f.coordinator.close();expect(()=>handle.consume()).toThrow();handle.abandon();await f.ops.joinTaskDocumentIO();if(retirement==='coordinator'){const next=createJsonlTaskTransitionCoordinator(f.root,{lock:{enabled:true}},taskDocumentStorageContract);try{await next.openManagedDocument('other');await next.putDocumentStrict!('fresh',{ok:true});await next.flush('other')}finally{await next.close()}}if(retirement==='delete')await expect(readFile(join(f.root,'task-parent.doc.jsonl'))).rejects.toMatchObject({code:'ENOENT'});if(retirement!=='coordinator'){const fresh=await f.observed(f.other);await fresh.op.close();await f.coordinator.putDocumentStrict!('unrelated',{ok:true});await f.coordinator.flush('other')}}finally{await f.close()}
})
it.each(['unknown','conflict','cleanup','pending'] as const)('original %s confirmation cannot arm early; only supported exact-witness retry recovers',async mode=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 try{const {op,seen}=await f.observed();probe.confirm=mode;probe.gate=release.promise;probe.entered=entered.resolve;const confirming=op.confirm(seen.witness);void confirming.catch(()=>{});if(mode==='pending'){await entered.promise;expect(()=>op.prepareReadHandoff(seen.witness)).toThrow();release.resolve()}const result=await confirming
 if(mode==='pending')expect(result.kind).toBe('confirmed');else expect(()=>op.prepareReadHandoff(seen.witness)).toThrow()
 if(mode==='unknown'){await expect(op.retryConfirmation({...seen.witness})).rejects.toThrow();expect((await op.retryConfirmation(seen.witness)).kind).toBe('confirmed')}
 if(mode==='unknown'||mode==='pending'){const handle=op.prepareReadHandoff(seen.witness);await op.close();handle.consume();expect(()=>op.assertHandoff()).toThrow()}else{probe.confirm='real';await op.retryConfirmation(seen.witness);expect(()=>op.prepareReadHandoff(seen.witness)).toThrow();await op.close()}
 await f.ops.joinTaskDocumentIO()
 }finally{release.resolve();await f.close()}
})
it.each(['backend','lease','pin'].flatMap(phase=>[false,undefined].flatMap(cause=>(phase==='backend'?[false]:[false,true]).map(consumed=>({phase,cause,consumed})))) )('falsey $phase cleanup cause=$cause consumed=$consumed cannot grant or revive read',async({phase,cause,consumed})=>{
 const f=await fixture()
 try{const {op,handle}=await f.armed();probe.phase=phase;probe.fail=true;probe.cause=cause;probe.consumeRelease=consumed;await expect(op.close()).rejects.toBe(cause);const before={backend:probe.closes,lease:probe.leases,pin:probe.pins};expect(()=>handle.consume()).toThrow();handle.abandon();expect(()=>handle.consume()).toThrow();await expect(f.ops.joinTaskDocumentIO()).rejects.toMatchObject({errors:[cause]});probe.fail=false;await op.retryClose();expect(()=>handle.consume()).toThrow();handle.abandon();await f.ops.joinTaskDocumentIO();expect(probe.closes).toBeGreaterThanOrEqual(before.backend);probe.phase='';const fresh=await f.armed();await fresh.op.close();fresh.handle.consume()
 }finally{await f.close()}
})
it('foreign witnesses and copied methods do not poison either legitimate original operation',async()=>{
 const f=await fixture()
 try{const first=await f.observed(),other=await f.observed(f.other);await first.op.confirm(first.seen.witness);await other.op.confirm(other.seen.witness)
 expect(()=>first.op.prepareReadHandoff(other.seen.witness)).toThrow();expect(()=>first.op.prepareReadHandoff({...first.seen.witness})).toThrow();const copy={...first.op};expect(()=>copy.prepareReadHandoff(first.seen.witness)).toThrow();expect(()=>first.op.prepareReadHandoff.call(other.op,first.seen.witness)).toThrow()
 const a=first.op.prepareReadHandoff(first.seen.witness),b=other.op.prepareReadHandoff(other.seen.witness);expect(()=>a.abandon.call(b)).toThrow();expect(()=>({...a}).consume()).toThrow();expect(()=>({...a}).abandon()).toThrow();expect(()=>first.op.prepareReadHandoff(first.seen.witness)).toThrow();await expect(first.op.observe()).rejects.toThrow();await expect(first.op.confirm(first.seen.witness)).rejects.toThrow();await expect(first.op.retryConfirmation(first.seen.witness)).rejects.toThrow();expect(()=>first.op.stageWrite(first.seen.witness,{formatVersion:2,tasks:[],notifications:[]})).toThrow();await first.op.close();await other.op.close();a.consume();b.consume();expect(()=>a.consume()).toThrow();a.abandon();b.abandon();await f.ops.joinTaskDocumentIO()
 }finally{await f.close()}
})
it.each(['validator','backend'] as const)('original %s self-reentry refuses before sealing or mutating admission',async mode=>{
 const f=await fixture()
 try{const other=await f.observed(f.other);await other.op.confirm(other.seen.witness);const legitimate=other.op.prepareReadHandoff(other.seen.witness);await other.op.close();const op=await f.ops.begin(f.ops.parent(f.parent));let rejected=0,attempted:Promise<void>|undefined,witness=other.seen.witness
 const reenter=()=>{expect(()=>op.prepareReadHandoff(witness)).toThrow();rejected++;attempted=f.coordinator.putDocumentStrict!('task-parent',{formatVersion:2,tasks:[],notifications:[]});void attempted.catch(()=>{})}
 if(mode==='validator')probe.onValidate=reenter;const seen=await op.observe();if(seen.kind!=='present')throw Error('absent');witness=seen.witness;probe.onValidate=undefined;if(mode==='backend')probe.onConfirm=reenter;await op.confirm(seen.witness);probe.onConfirm=undefined;expect(rejected).toBe(1);await expect(attempted).rejects.toThrow();const original=op.prepareReadHandoff(seen.witness);await op.close();original.consume();legitimate.consume();await f.ops.joinTaskDocumentIO()
 }finally{await f.close()}
})
it('actual committed write retains write-only handoff and listener cleanup',async()=>{
 const f=await fixture(),controller=new AbortController()
 try{const op=await f.ops.begin(f.ops.parent(f.parent),{signal:controller.signal}),seen=await op.observe();if(seen.kind!=='present')throw Error('absent');const write=op.stageWrite(seen.witness,{formatVersion:2,tasks:[],notifications:[]});expect((await write.issue()).kind).toBe('committed');expect(()=>op.prepareReadHandoff(seen.witness)).toThrow();await op.close();expect(()=>op.assertHandoff()).not.toThrow();controller.abort();expect(()=>op.assertHandoff()).not.toThrow();await f.ops.joinTaskDocumentIO()
 }finally{await f.close()}
})
