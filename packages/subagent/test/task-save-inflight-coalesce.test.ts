const native=vi.hoisted(()=>({root:'',issues:0,stages:0,descriptions:[] as string[],gate:undefined as undefined|Promise<void>,entered:undefined as undefined|(()=>void),failure:undefined as undefined|{cause:unknown}}))
vi.mock('../../session-persistence-jsonl/src/backend/document-write.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/document-write.ts')>();return {...original,createOwnedDocumentWrite(...args:Parameters<typeof original.createOwnedDocumentWrite>){const created=original.createOwnedDocumentWrite(...args);if(!native.root||!args[0].path.startsWith(native.root)||!args[0].path.endsWith('task-parent.doc.jsonl'))return created;native.stages++;native.descriptions.push(JSON.parse(Buffer.from(args[0].bytes).toString('utf8')).tasks[0].description);return {handle:{async issue(){native.issues++;native.entered?.();await native.gate;if(native.failure)throw native.failure.cause;return created.handle.issue()},retry:created.handle.retry.bind(created.handle),reconcile:created.handle.reconcile.bind(created.handle),outcome:created.handle.outcome.bind(created.handle)},settle:created.settle.bind(created)}}}})
import {it,expect,vi} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {captureOwnedTaskContext} from '../src/task/owned-context.ts'
import {TaskPersistence,originalTaskSaveDependency} from '../src/task/persistence.ts'
async function fixture(){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'ordinary-inflight-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract);await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent'),owned=captureOwnedTaskContext(c,document,document.view,'parent')!;let description='first'
 const persistence=new TaskPersistence(c,'parent',true,()=>({formatVersion:2,tasks:[{id:'task-1',parentSessionId:'parent',agentPath:'one',description,prompt:'work',agent:'general',delivery:'tool',status:'accepted',timeCreated:1}],notifications:[]}),owned)
 native.root=root;native.stages=native.issues=0;native.descriptions=[];native.failure=undefined
 return {persistence,set(value:string){description=value},async close(){native.gate=undefined;native.entered=undefined;native.failure=undefined;await persistence.retireConsumers();await c.close();native.root=''}}
}
it('joins only the identical full in-flight ordinary save promise and issues completed history again',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();native.entered=entered.resolve;native.gate=release.promise
 try{const first=f.persistence.save();await entered.promise;const duplicate=f.persistence.save();expect(duplicate).toBe(first);expect(native.stages).toBe(1);release.resolve();await first;const later=f.persistence.save();expect(later).not.toBe(first);await later;expect(native.stages).toBe(2);expect(native.issues).toBe(2)}finally{release.resolve();await f.close()}
})
it('preserves different whole-document snapshots in FIFO and never joins across an intervening value',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();native.entered=entered.resolve;native.gate=release.promise
 try{const first=f.persistence.save();await entered.promise;f.set('second');const second=f.persistence.save();f.set('first');const third=f.persistence.save();expect(second).not.toBe(first);expect(third).not.toBe(first);release.resolve();await Promise.all([first,second,third]);expect(native.descriptions).toEqual(['first','second','first']);expect(native.issues).toBe(3)}finally{release.resolve();await f.close()}
})
it.each([undefined,false,null])('does not join a failed ordinary capture even when its failure is falsey (%j)',async cause=>{
 const f=await fixture();native.failure={cause}
 try{const first=f.persistence.save();await first.catch(error=>expect(error).toBe(cause));const second=f.persistence.save();expect(second).not.toBe(first);let dependency:unknown;await second.catch(error=>{dependency=error});expect(originalTaskSaveDependency(dependency)?.cause).toBe(cause);expect(native.stages).toBe(1);expect(native.issues).toBe(1)}finally{await f.close()}
})
it('does not join a held consumer and cannot overtake its original release',async()=>{
 const f=await fixture()
 try{const held=f.persistence.captureSave(true)!;await held.done;const following=f.persistence.save();expect(following).not.toBe(held.done);let done=false;void following.then(()=>{done=true});await Promise.resolve();expect(done).toBe(false);expect(native.stages).toBe(1);held.release();await following;expect(native.stages).toBe(2)}finally{await f.close()}
})
