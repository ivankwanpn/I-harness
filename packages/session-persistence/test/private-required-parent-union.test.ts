import {afterEach,expect,it,vi} from 'vitest'
const cut=vi.hoisted(()=>({writes:0,run:undefined as undefined|((next:()=>Promise<import('../src/coordinator/fact-types.ts').BackendFactOutcome>)=>Promise<import('../src/coordinator/fact-types.ts').BackendFactOutcome>),native:undefined as undefined|((id:string,owner:object,batch:object)=>void),metadata:undefined as undefined|{entered():void;wait:Promise<void>;fail:boolean},locks:new Map<string,{held:boolean;release():void|Promise<void>}>()}))
vi.mock('../../fs-lock/src/index.ts',async load=>{const original=await load<typeof import('../../fs-lock/src/index.ts')>();return {...original,async acquireSessionLock(options:import('../../fs-lock/src/index.ts').AcquireOptions){const lock=await original.acquireSessionLock(options);cut.locks.set(options.lockPath,lock);return lock}}})
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return {...original,createManagedSessionState(){throw Error('Private Task union constructed a complete Session')}}})
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const journal=original.createFactJournalBackend(...args);return {...journal,async appendOwnedBatch(...input:Parameters<typeof journal.appendOwnedBatch>){cut.writes++;const next=()=>journal.appendOwnedBatch(...input);return cut.run?cut.run(next):next()}}}}})
vi.mock('../src/native-fact-writer-internal.ts',async load=>{const original=await load<typeof import('../src/native-fact-writer-internal.ts')>();return {...original,createOriginalNativePrewriteOwner(){const owner=original.createOriginalNativePrewriteOwner();return {enter(...args:Parameters<typeof owner.enter>){const leave=owner.enter(...args);cut.native?.(...args);return leave},associate(...args:Parameters<typeof owner.associate>){return owner.associate(...args)}}}}})
vi.mock('node:fs/promises',async load=>{const original=await load<typeof import('node:fs/promises')>();return {...original,async rename(...args:Parameters<typeof original.rename>){await original.rename(...args);if(cut.metadata&&String(args[1]).endsWith('parent.jsonl')){const held=cut.metadata;cut.metadata=undefined;held.entered();await held.wait;if(held.fail)throw undefined}}}})
import {mkdtemp,open,stat,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'
import {taskDocumentOperationsFor} from '../src/task-document-internal.ts'
import {canJoinOriginalNativePrewrite} from '../src/native-fact-writer-internal.ts'
import * as managed from '../src/coordinator/managed-document.ts'
import {lockPathFor} from '../../fs-lock/src/index.ts'
import {artifactPathsFor} from '../src/coordinator/artifact-path-association.ts'
const cleanups:(()=>Promise<void>)[]=[]
afterEach(async()=>{cut.run=undefined;cut.native=undefined;cut.metadata=undefined;const failures:unknown[]=[];for(const close of cleanups.splice(0).reverse())try{await close()}catch(cause){failures.push(cause)}vi.restoreAllMocks();cut.locks.clear();cut.writes=0;if(failures.length){const deepest=(cause:unknown):unknown=>cause instanceof AggregateError?deepest(cause.errors[0]):cause instanceof Error&&cause.cause?deepest(cause.cause):cause;throw new Error('Private required Task original cleanup incomplete',{cause:deepest(failures[0])})}})
async function fixture(customExecution?: () => void){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-required-task-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 const originalFactory=managed.createManagedDocument
 const factory=vi.spyOn(managed,'createManagedDocument').mockImplementation((...args)=>{
  if(customExecution&&args[11]){
   const execution=args[11],current=execution.assertCurrent
   execution.assertCurrent=()=>{customExecution();Reflect.apply(current,execution,[])}
  }
  return originalFactory(...args)
 });cleanups.push(async()=>{await coordinator.close();factory.mockRestore()})
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),document=factory.mock.results.at(-1)!.value as ReturnType<typeof managed.createManagedDocument>,ownership=factory.mock.calls.at(-1)![4]
 expect(document).toBe(execution.owner);expect(Object.hasOwn(document,'view')).toBe(false)
 const drained=Promise.withResolvers<void>(),action=execution.owner.beginAction(),source=action.registerSettlementSource(()=>drained.promise),parent=managed.captureManagedRequiredParent(document,ownership,source),operations=taskDocumentOperationsFor(coordinator)!,token=await operations.requiredParent(execution.owner,source)
 let finished=false;const finish=async()=>{if(finished)return;drained.resolve();const failures:unknown[]=[];try{await source.close()}catch(cause){failures.push(cause)}try{await operations.releaseRequiredParent(token)}catch(cause){failures.push(cause)}action.finish();if(failures.length)throw new AggregateError(failures,'Original private source and parent cleanup incomplete');finished=true};cleanups.push(finish);cut.writes=0
 return {root,backend,coordinator,execution,document,ownership,action,source,parent,operations,token,finish,executionDependency:factory.mock.calls.at(-1)![11]!}
}
it('private original writer joins native IO, excludes the next journal batch, then writes the genuine Task after Stop',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 cut.run=async next=>{const result=await next();if(cut.writes===1){entered.resolve();await release.promise}return result}
 const first=f.action.facts.metadata.admit({type:'plan/mode',mode:'on'});await entered.promise
 let acquired=false;const acquiring=f.parent.acquireWriter().then(writer=>{acquired=true;return writer});await Promise.resolve();expect(acquired).toBe(false)
 release.resolve();expect(await first).toMatchObject({kind:'committed'});const writer=await acquiring
 const second=f.action.facts.metadata.admit({type:'plan/mode',mode:'off'});let completed=false;void second.then(()=>{completed=true});await Promise.resolve();await Promise.resolve();expect(cut.writes).toBe(1);expect(completed).toBe(false)
 writer.park();expect(await second).toMatchObject({kind:'committed'});await writer.resume();f.parent.assertCurrent();writer.release();writer.release();expect(cut.writes).toBe(2)
 f.execution.revokeNewWork();f.operations.assertTaskV3Parent(f.token,'parent');const operation=await f.operations.begin(f.token)
 try{const observed=await operation.observe();if(observed.kind!=='present')throw Error('Original Task document absent');expect(observed.value).toEqual(taskDocumentStorageContract.empty());const write=operation.stageWrite(observed.witness,taskDocumentStorageContract.empty());expect(await write.issue()).toMatchObject({kind:'committed'});expect(()=>f.operations.parent({...f.execution.owner})).toThrow();expect(Object.hasOwn(f.document,'view')).toBe(false)}finally{await operation.close()}
},20000)
it('private original UNKNOWN journal and Stop retain the same required source and reconcile once before Task writer admission',async()=>{
 const f=await fixture();cut.run=async next=>{const result=await next();if(result.kind!=='committed')throw Error('Original native ACK absent');return {kind:'unknown',key:result.receipt.key}}
 const original=f.action.captureMetadata!({type:'plan/mode',mode:'on'}),unknown=await original.admit();expect(unknown.kind).toBe('unknown');expect(cut.writes).toBe(1)
 f.execution.revokeNewWork();await expect(f.parent.acquireWriter()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'});await expect(f.parent.joinIssuedWriter()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
 cut.run=undefined;expect(await original.reconcile()).toMatchObject({kind:'committed'});await f.parent.joinIssuedWriter();const writer=await f.parent.acquireWriter();writer.release();expect(cut.writes).toBe(1)
 const operation=await f.operations.begin(f.token);try{expect(await operation.observe()).toMatchObject({kind:'present'});expect(Object.hasOwn(f.document,'view')).toBe(false)}finally{await operation.close()}
},20000)
it('private native-prewrite join requires the exact original backend/issuer/batch and refuses its own required source',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<{id:string;owner:Parameters<typeof canJoinOriginalNativePrewrite>[2];batch:Parameters<typeof canJoinOriginalNativePrewrite>[3]}>()
 cut.native=(id,owner,batch)=>entered.resolve({id,owner:owner as Parameters<typeof canJoinOriginalNativePrewrite>[2],batch:batch as Parameters<typeof canJoinOriginalNativePrewrite>[3]})
 const admission=f.source.recovery.capture({type:'context/recovery',version:1,ownerSessionId:'parent',recoveryId:'original',logicalStepSeq:0,bindingFingerprint:'a'.repeat(64),rejectedInputFingerprint:'b'.repeat(64),state:'blocked',retryConsumed:true}).admit(),request=await entered.promise
 expect(canJoinOriginalNativePrewrite(f.backend,request.id,request.owner,request.batch)).toBe(true);expect(canJoinOriginalNativePrewrite({...f.backend},request.id,request.owner,request.batch)).toBe(false);expect(canJoinOriginalNativePrewrite(f.backend,request.id,{...request.owner},request.batch)).toBe(false);expect(canJoinOriginalNativePrewrite(f.backend,request.id,request.owner,{...request.batch})).toBe(false)
 const method = Object.getOwnPropertyDescriptor(f.backend, 'appendOwnedBatch')!
 let getterReads = 0
 try {
  Object.defineProperty(f.backend, 'appendOwnedBatch', { configurable: true, enumerable: method.enumerable, get() { getterReads++; return method.value } })
  expect(() => canJoinOriginalNativePrewrite(f.backend,request.id,request.owner,request.batch)).toThrow()
  expect(getterReads).toBe(0)
 } finally { Object.defineProperty(f.backend, 'appendOwnedBatch', method) }
 await expect(f.parent.acquireWriter()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'});expect(await admission).toMatchObject({kind:'committed'});expect(canJoinOriginalNativePrewrite(f.backend,request.id,request.owner,request.batch)).toBe(false)
},20000)
it.each(['title','failed','authority'] as const)('private original metadata currency refuses stale Task proof without reviving private source (%s)',async mode=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();cut.metadata={entered:entered.resolve,wait:release.promise,fail:mode==='failed'}
 const changing=f.coordinator.updateMeta('parent',mode==='authority'?{modelSelection:{provider:'fixture',model:'changed'}}:{title:'display title'});void changing.catch(()=>{})
 expect(()=>f.parent.assertCurrent()).toThrow();await entered.promise;expect(()=>f.operations.assertTaskV3Parent(f.token,'parent')).toThrow();release.resolve()
 if(mode==='failed')await expect(changing).rejects.toMatchObject({message:'TASK_TRANSITION_FAILED',cause:undefined});else await changing
 expect(()=>f.parent.assertCurrent()).toThrow();await expect(f.parent.acquireWriter()).rejects.toThrow();f.ownership.assertHeld('parent');expect(Object.hasOwn(f.document,'view')).toBe(false);await f.finish();await f.coordinator.closeManagedDocument('parent')
},20000)

it('private retired original entry cannot borrow a new incarnation for parent proof or cleanup identity',async()=>{
 const f=await fixture(),oldHeld=managed.originalManagedExecution(f.document,f.ownership).held;await f.finish();await f.coordinator.closeManagedDocument('parent');const next=await acquireManagedExecution(f.coordinator,'parent');expect(next.owner).not.toBe(f.execution.owner);expect(()=>oldHeld.assertHeld()).toThrow();expect(()=>f.source.assertHeld()).toThrow();await expect(f.parent.acquireWriter()).rejects.toThrow();expect(Object.hasOwn(next.owner,'view')).toBe(false)
},20000)
it('private source cleanup refuses actual original native ownership loss without granting a replacement epoch',async()=>{
 const f=await fixture();cleanups.splice(-2);try{const target=artifactPathsFor(f.backend)!.session('parent');if(target.kind!=='ready')throw Error('Original artifact identity unavailable');const native=cut.locks.get(lockPathFor(f.root,'artifact-ownership:'+target.key))!;expect(native).toBeDefined();expect(native.held).toBe(true);await native.release();expect(native.held).toBe(false);expect(()=>f.source.assertHeld()).toThrow();await expect(f.parent.acquireWriter()).rejects.toThrow();await expect(f.finish()).rejects.toBeInstanceOf(AggregateError);await expect(f.coordinator.close()).rejects.toThrow();expect(Object.hasOwn(f.document,'view')).toBe(false)}finally{await f.finish().catch(()=>{});await f.coordinator.close().catch(()=>{})}
},20000)

it('refuses an opaque pre-native append without waiting on its required Task exclusion', async () => {
 const f = await fixture()
 const entered = Promise.withResolvers<void>()
 const release = Promise.withResolvers<void>()
 const writer = await f.parent.acquireWriter()
 cut.run = async next => { entered.resolve(); await release.promise; return next() }
 const admission = f.action.captureMetadata!({ type: 'plan/mode', mode: 'on' }).admit()
 void admission.catch(() => {})
 try {
  await Promise.resolve()
  await Promise.resolve()
  expect(cut.writes).toBe(0)
  writer.release()
  await entered.promise
  // The wrapper is genuinely entered, but its original native delegate is not.
  // Refusal must complete while that wrapper remains held, not join its gate.
  await expect(f.parent.acquireWriter()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  expect(cut.writes).toBe(1)
  release.resolve()
  expect(await admission).toMatchObject({ kind: 'committed' })
  await f.parent.joinIssuedWriter()
 } finally {
  writer.release()
  release.resolve()
  await admission
 }
}, 20000)

it('keeps an opaque execution callback uncalled and unrecognized during original quarantine refusal', async () => {
 let calls = 0
 const f = await fixture(() => { calls++ })
 const ordinary = managed.captureManagedTaskParentReadiness(f.document, f.ownership)
 cut.run = async next => {
  const result = await next()
  if (result.kind !== 'committed') throw Error('Original native append did not commit')
  return { kind: 'unknown', key: result.receipt.key }
 }
 const capture = f.action.captureMetadata!({ type: 'plan/mode', mode: 'on' })
 expect(await capture.admit()).toMatchObject({ kind: 'unknown' })
 const before = calls
 const cause = await f.operations.joinRequiredWriter(f.token).then(() => { throw Error('Original quarantine was not refused') }, cause => cause)
 expect(calls).toBe(before)
 expect(() => ordinary.assertCurrent()).toThrow()
 expect(calls).toBe(before)
 expect(f.operations.captureRequiredWriterRecovery(f.token, cause)).toBeUndefined()
 expect(calls).toBe(before)
 cut.run = undefined
 expect(await capture.reconcile()).toMatchObject({ kind: 'committed' })
}, 20000)

it.each(['invalid', 'cancelled'] as const)('removes original prewrite scheduling evidence after %s pre-issue refusal', async mode => {
 const f = await fixture()
 const path = join(f.root, 'parent.jsonl')
 const bytes = await readFile(path)
 let request: { id: string; owner: Parameters<typeof canJoinOriginalNativePrewrite>[2]; batch: Parameters<typeof canJoinOriginalNativePrewrite>[3] } | undefined
 cut.native = (id, owner, batch) => {
  request = { id, owner: owner as Parameters<typeof canJoinOriginalNativePrewrite>[2], batch: batch as Parameters<typeof canJoinOriginalNativePrewrite>[3] }
  expect(canJoinOriginalNativePrewrite(f.backend, request.id, request.owner, request.batch)).toBe(true)
  if (mode === 'cancelled') f.action.stop()
  else request.batch.bytes[0] = request.batch.bytes[0]! ^ 1
 }
 const outcome = await f.action.captureMetadata!({ type: 'plan/mode', mode: 'on' }).admit()
 expect(outcome.kind).toBe('not-issued')
 expect(request).toBeDefined()
 expect(canJoinOriginalNativePrewrite(f.backend, request!.id, request!.owner, request!.batch)).toBe(false)
 expect(await readFile(path)).toEqual(bytes)
 expect(cut.writes).toBe(1)
}, 20000)

it.each(['committed', 'absent'] as const)('matches only the original private readiness occurrence after actual %s reconciliation', async disposition => {
 const f = await fixture()
 const path = join(f.root, 'parent.jsonl')
 const initialSize = (await stat(path)).size
 cut.run = async next => {
  const result = await next()
  if (result.kind !== 'committed') throw Error('Original native append did not commit')
  return { kind: 'unknown', key: result.receipt.key }
 }
 const capture = f.action.captureMetadata!({ type: 'plan/mode', mode: 'on' })
 expect(await capture.admit()).toMatchObject({ kind: 'unknown' })
 const cause = await f.operations.joinRequiredWriter(f.token).then(() => { throw Error('Original UNKNOWN was not refused') }, cause => cause)
 const recovered = f.operations.captureRequiredWriterRecovery(f.token, cause)
 expect(recovered).toBeTypeOf('function')
 expect(recovered!()).toBe(false)
 expect(f.operations.captureRequiredWriterRecovery(f.token, new Error('callback failure'))).toBeUndefined()
 expect(f.parent.captureWriterRecovery?.(cause)).toBeUndefined()

 // The original dependency's own descriptor must be checked without invoking
 // a replacement accessor, even though the caller reuses the exact error.
 const dependency = f.executionDependency
 const current = Object.getOwnPropertyDescriptor(dependency, 'assertCurrent')!
 let getterReads = 0
 try {
  Object.defineProperty(dependency, 'assertCurrent', { ...current, value: () => {} })
  expect(() => f.operations.captureRequiredWriterRecovery(f.token, cause)).toThrow()
  expect(recovered!()).toBe(false)
  Object.defineProperty(dependency, 'assertCurrent', { configurable: true, enumerable: current.enumerable, get() { getterReads++; return current.value } })
  expect(() => f.operations.captureRequiredWriterRecovery(f.token, cause)).toThrow()
  expect(recovered!()).toBe(false)
  expect(getterReads).toBe(0)
 } finally {
  Object.defineProperty(dependency, 'assertCurrent', current)
 }

 const held = Object.getOwnPropertyDescriptor(f.source, 'assertHeld')!
 try {
  Object.defineProperty(f.source, 'assertHeld', { ...held, value: () => {} })
  expect(() => f.operations.captureRequiredWriterRecovery(f.token, cause)).toThrow()
  expect(recovered!()).toBe(false)
 } finally {
  Object.defineProperty(f.source, 'assertHeld', held)
 }
 cut.run = undefined
 if (disposition === 'absent') {
  // Simulate loss of the unacknowledged suffix. Only the original native
  // reconcile (including its own truncate/sync) may certify its absence.
  const original = await open(path, 'r+')
  try { await original.truncate(initialSize); await original.sync() }
  finally { await original.close() }
 }
 expect(await capture.reconcile()).toMatchObject({ kind: disposition })
 expect(recovered!()).toBe(true)
 await f.finish()
 await f.coordinator.closeManagedDocument('parent')
 expect(recovered!()).toBe(true)
 const replacement = await acquireManagedExecution(f.coordinator, 'parent')
 expect(replacement.owner).not.toBe(f.execution.owner)
 expect(recovered!()).toBe(false)
}, 20000)
