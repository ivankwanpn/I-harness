const native=vi.hoisted(()=>({root:'',stages:0,issues:0,drop:false}))
vi.mock('../../session-persistence-jsonl/src/backend/document-write.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/document-write.ts')>();return {...original,createOwnedDocumentWrite(...args:Parameters<typeof original.createOwnedDocumentWrite>){const created=original.createOwnedDocumentWrite(...args);if(!native.root||!args[0].path.startsWith(native.root)||!args[0].path.endsWith('task-parent.doc.jsonl'))return created;native.stages++;return {handle:{async issue(){native.issues++;const outcome=await created.handle.issue();return native.drop?{kind:'unknown' as const,cause:undefined,cleanupPending:false}:outcome},retry:created.handle.retry.bind(created.handle),reconcile:created.handle.reconcile.bind(created.handle),outcome:created.handle.outcome.bind(created.handle)},settle:created.settle.bind(created)}}}})
import {it,expect,vi} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {captureOwnedTaskContext} from '../src/task/owned-context.ts'
import {TaskPersistence,originalTaskSaveDependency} from '../src/task/persistence.ts'

it.each([undefined,false,null])('retires its own proved pre-native failed capture while preserving cause and nominal dependency (%j)',async cause=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'failed-task-capture-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent'),owned=captureOwnedTaskContext(c,document,document.view,'parent')!;native.root=root;native.stages=native.issues=0;native.drop=false;let refuse=true
  const persistence=new TaskPersistence(c,'parent',true,()=>{if(refuse)throw cause;return {formatVersion:2,tasks:[],notifications:[]}},owned),first=persistence.captureSave()!
  let originalRejected=false;await first.done.catch(error=>{originalRejected=true;expect(error).toBe(cause)});expect(originalRejected).toBe(true);refuse=false
  const blocked=persistence.captureSave()!;let dependent:unknown;await blocked.done.catch(error=>{dependent=error});const provenance=originalTaskSaveDependency(dependent)!;expect(provenance.cause).toBe(cause);expect(provenance.occurrence).toBeDefined()
  expect(originalTaskSaveDependency({...dependent as object})).toBeUndefined();expect(originalTaskSaveDependency(new Error('Earlier owned task save requires resolution',{cause}))).toBeUndefined();expect(originalTaskSaveDependency({cause})).toBeUndefined()
  await expect(first.retireConsumer.call({...first})).rejects.toBeInstanceOf(TypeError);await expect(persistence.flush()).rejects.toThrow('requires resolution')
  await first.retireConsumer();await blocked.retireConsumer();await persistence.flush();expect(native.stages).toBe(0);expect(native.issues).toBe(0);expect(first.outcome()).toBeUndefined();expect(blocked.outcome()).toBeUndefined()
  let retryRejected=false;await first.retry().catch(error=>{retryRejected=true;expect(error).toBe(cause)});expect(retryRejected).toBe(true);let handoffRejected=false;try{first.assertHandoff()}catch(error){handoffRejected=true;expect(error).toBe(cause)}expect(handoffRejected).toBe(true)
 }finally{native.root='';native.drop=false;await c.close()}
})
it('cannot retire a failed capture across an earlier native-started save and retries only its own bookkeeping after that original resolves',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'failed-capture-native-head-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent'),owned=captureOwnedTaskContext(c,document,document.view,'parent')!;native.root=root;native.stages=native.issues=0;native.drop=true;const marker=Object.freeze({original:'snapshot refused'});let refuse=false
  const persistence=new TaskPersistence(c,'parent',true,()=>{if(refuse)throw marker;return {formatVersion:2,tasks:[],notifications:[]}},owned),first=persistence.captureSave()!;await expect(first.done).rejects.toThrow('not acknowledged');expect(first.outcome()?.kind).toBe('unknown')
  refuse=true;const later=persistence.captureSave()!;await later.done.catch(error=>expect(error).toBe(marker));await expect(later.retireConsumer()).rejects.toThrow('Earlier owned task save');expect(first.outcome()?.kind).toBe('unknown');expect(native.stages).toBe(1)
  native.drop=false;await first.retireConsumer();expect(first.outcome()?.kind).toBe('committed');await later.retireConsumer();await persistence.flush();expect(native.stages).toBe(1);expect(native.issues).toBe(1);expect(later.outcome()).toBeUndefined();await later.retry().catch(error=>expect(error).toBe(marker))
 }finally{native.root='';native.drop=false;await c.close()}
})
