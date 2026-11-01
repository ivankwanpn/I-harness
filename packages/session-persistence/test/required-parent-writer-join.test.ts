const cut=vi.hoisted(()=>({statFailure:undefined as undefined|{path:string;error:unknown},native:undefined as undefined|((id:string,owner:object,batch:object)=>void),run:undefined as undefined|((next:()=>Promise<unknown>)=>Promise<unknown>)}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const journal=original.createFactJournalBackend(...args);return {...journal,appendOwnedBatch(...input:Parameters<typeof journal.appendOwnedBatch>){const next=()=>journal.appendOwnedBatch(...input);return (cut.run?cut.run(next):next()) as ReturnType<typeof journal.appendOwnedBatch>}}}}})
vi.mock('../src/native-fact-writer-internal.ts',async load=>{const original=await load<typeof import('../src/native-fact-writer-internal.ts')>();return {...original,createOriginalNativePrewriteOwner(){const owner=original.createOriginalNativePrewriteOwner();return {enter(...args:Parameters<typeof owner.enter>){const leave=owner.enter(...args);cut.native?.(...args);return leave},associate(...args:Parameters<typeof owner.associate>){return owner.associate(...args)}}}}})
import { canJoinOriginalNativePrewrite } from '../src/native-fact-writer-internal.ts'
vi.mock('node:fs/promises',async load=>{const original=await load<typeof import('node:fs/promises')>();return {...original,stat(...args:Parameters<typeof original.stat>){if(cut.statFailure&&String(args[0])===cut.statFailure.path)return Promise.reject(cut.statFailure.error);return original.stat(...args)}}})
import { createHash } from 'node:crypto'
import { createFactJournalBackend } from '../../session-persistence-jsonl/src/backend/fact-journal.ts'
import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createMutations } from '../src/coordinator/mutations.ts'
import { createLoads } from '../src/coordinator/load.ts'
import { createManagedDocuments } from '../src/coordinator/managed-documents.ts'
import { isInsideOriginalSettlementClose, captureOriginalSettlementCloseAck } from '../src/coordinator/settlement-source.ts'
import { captureManagedRequiredParent } from '../src/coordinator/managed-document.ts'

const terminal = { type:'context/recovery' as const, version:1 as const, ownerSessionId:'parent', recoveryId:'original', logicalStepSeq:0, bindingFingerprint:'a'.repeat(64), rejectedInputFingerprint:'b'.repeat(64), state:'blocked' as const, retryConsumed:true }
async function fixture(onDrain?:(source:import('@i-harness/core-session').SettlementFacts)=>Promise<void>,onRevoke?:()=>void){
 cut.run=undefined;cut.native=undefined;cut.statFailure=undefined;const root=await mkdtemp(join(tmpdir(),'ih-required-writer-')),backend=createJsonlBackend(root),opts={lock:{enabled:true}}
 const ownership=createOwnership(backend,opts),mutations=createMutations(backend,ownership,200,()=>{}),loads=createLoads(backend,ownership,mutations)
 const managed=createManagedDocuments(backend,ownership,loads.loadOwned,opts,()=>{},mutations,undefined,undefined,async()=>{onRevoke?.()})
 await mutations.create({sessionId:'parent'});const document=await managed.open('parent');const action=document.beginAction(),source=action.registerSettlementSource(async()=>{await onDrain?.(source)})
 const parent=captureManagedRequiredParent(document,ownership,source)
 return {root,backend,ownership,document,action,source,parent,captureOrdinaryParent:()=>managed.captureParent(document),async close(){cut.run=undefined;cut.native=undefined;cut.statFailure=undefined;action.finish();await managed.close();await Promise.all(ownership.releaseHeldLocks())}}
}
it('joins only the held original other-source issued batch and rechecks strict readiness',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 let writes=0
 cut.run=async next=>{writes++;const outcome=await next();entered.resolve();await release.promise;return outcome}
 const admission=f.action.facts.metadata.admit({type:'plan/mode',mode:'on'});await entered.promise
 expect(()=>f.parent.assertCurrent()).toThrow();let joined=false
 const joining=f.parent.joinIssuedWriter().then(()=>{joined=true});await Promise.resolve();expect(joined).toBe(false)
 release.resolve();expect(await admission).toMatchObject({kind:'committed'});await joining;f.parent.assertCurrent();expect(writes).toBe(1);await f.close()
})
it('refuses its own issued source without waiting for the producer or discovering sources',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 cut.run=async next=>{const outcome=await next();entered.resolve();await release.promise;return outcome}
 const fact=f.source.recovery.capture(terminal),admission=fact.admit();await entered.promise
 await expect(f.parent.joinIssuedWriter()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'});await expect(f.parent.acquireWriter()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
 release.resolve();expect(await admission).toMatchObject({kind:'committed'});await f.parent.joinIssuedWriter();await f.close()
})
it('refuses a reentrant join inside the original session operation before any self wait',async()=>{
 const f=await fixture();let refusals=0
 cut.run=async next=>{const outcome=await next();await expect(f.parent.joinIssuedWriter()).rejects.toThrow();await expect(f.parent.acquireWriter()).rejects.toThrow();refusals++;return outcome}
 expect(await f.action.facts.metadata.admit({type:'plan/mode',mode:'on'})).toMatchObject({kind:'committed'});expect(refusals).toBe(1);await f.parent.joinIssuedWriter();await f.close()
})
it('retains an unknown original fact until its own reconciliation proves it',async()=>{
 const f=await fixture();let writes=0
 cut.run=async next=>{writes++;const outcome=await next() as import('../src/coordinator/fact-types.ts').BackendFactOutcome;if(outcome.kind!=='committed')throw Error('expected real commit');return {kind:'unknown',key:outcome.receipt.key}}
 const fact=f.action.facts.metadata.admit({type:'plan/mode',mode:'on'}),outcome=await fact
 expect(outcome.kind).toBe('unknown');await expect(f.parent.joinIssuedWriter()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'});expect(writes).toBe(1);await expect(f.parent.acquireWriter()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'});await expect(f.parent.acquireWriter()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
 if(outcome.kind!=='unknown')throw Error('missing unknown');expect(await f.document.reconcile(outcome.key)).toMatchObject({kind:'committed'});await f.parent.joinIssuedWriter();expect(writes).toBe(1);await f.close()
})

it('refuses an unissued other-source batch without waiting on its prerequisite',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 cut.run=async next=>{entered.resolve();await release.promise;return next()}
 const admission=f.action.facts.metadata.admit({type:'plan/mode',mode:'on'});await entered.promise
 await expect(f.parent.joinIssuedWriter()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED',cause:{originalBatchIssued:false,sameRequiredSource:false}})
 release.resolve();expect(await admission).toMatchObject({kind:'committed'});await f.parent.joinIssuedWriter();await f.close()
})

it.each([false,true])('qualifies only the exact authentic native-prewrite request (same source=%s)',async sameSource=>{
 const f=await fixture(),entered=Promise.withResolvers<{id:string;owner:import('../src/coordinator/fact-types.ts').IssuingFactOwner;batch:import('@i-harness/core-session').EncodedFactBatch}>()
 cut.native=(id,owner,batch)=>entered.resolve({id,owner:owner as never,batch:batch as never})
 const admission=sameSource?f.source.recovery.capture(terminal).admit():f.action.facts.metadata.admit({type:'plan/mode',mode:'on'}),request=await entered.promise
 expect(canJoinOriginalNativePrewrite(f.backend,request.id,request.owner,request.batch)).toBe(true)
 expect(canJoinOriginalNativePrewrite({...f.backend},request.id,request.owner,request.batch)).toBe(false)
 expect(canJoinOriginalNativePrewrite({},request.id,request.owner,request.batch)).toBe(false)
 expect(canJoinOriginalNativePrewrite(f.backend,request.id,request.owner,{...request.batch})).toBe(false)
 expect(canJoinOriginalNativePrewrite(f.backend,request.id,{...request.owner},request.batch)).toBe(false)
 if(sameSource)await expect(f.parent.joinIssuedWriter()).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
 else {let done=false;const joining=f.parent.joinIssuedWriter().then(()=>{done=true});await Promise.resolve();expect(done).toBe(false);await joining}
 expect(await admission).toMatchObject({kind:'committed'});expect(canJoinOriginalNativePrewrite(f.backend,request.id,request.owner,request.batch)).toBe(false);await f.close()
})

it.each(['marker','error'] as const)('preserves the original native deletion refusal and leaves no stale scheduling grant (%s)',async mode=>{
 const f=await fixture(),path=join(f.root,'desktop-deleted-session-'+createHash('sha256').update('parent').digest('hex')+'.tombstone'),before=await readFile(join(f.root,'parent.jsonl'))
 let request:{id:string;owner:import('../src/coordinator/fact-types.ts').IssuingFactOwner;batch:import('@i-harness/core-session').EncodedFactBatch}|undefined
 cut.native=(id,owner,batch)=>{request={id,owner:owner as never,batch:batch as never}}
 if(mode==='marker')await writeFile(path,'original deletion fence');else cut.statFailure={path,error:Object.assign(new Error('original namespace stat failed'),{code:'EIO'})}
 expect(await f.action.facts.metadata.admit({type:'plan/mode',mode:'on'})).toMatchObject({kind:'not-issued'})
 expect(request).toBeDefined();expect(canJoinOriginalNativePrewrite(f.backend,request!.id,request!.owner,request!.batch)).toBe(false)
 expect(await readFile(join(f.root,'parent.jsonl'))).toEqual(before);await f.close()
})
it('refuses a copied prerequisite pair before opening or acquiring native scheduling provenance',()=>{
 const path=()=>'/unused',deleted=async()=>{},replacement=async()=>{};let entries=0
 expect(()=>createFactJournalBackend(path,deleted,{filePath:path,assertNotDeleted:replacement,enter(){entries++;return()=>{}}})).toThrow('Changed original native writer prerequisites')
 expect(()=>createFactJournalBackend(path,deleted,{filePath:()=>'/changed',assertNotDeleted:deleted,enter(){entries++;return()=>{}}})).toThrow('Changed original native writer prerequisites');expect(entries).toBe(0)
})

it('original writer exclusion joins an existing native batch, blocks new selection, and releases once',async()=>{
 const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let writes=0
 cut.run=async next=>{writes++;const outcome=await next();if(writes===1){entered.resolve();await release.promise}return outcome}
 const first=f.action.facts.metadata.admit({type:'plan/mode',mode:'on'});await entered.promise
 let acquired=false;const acquiring=f.parent.acquireWriter().then(lease=>{acquired=true;return lease});await Promise.resolve();expect(acquired).toBe(false)
 release.resolve();expect(await first).toMatchObject({kind:'committed'});const writer=await acquiring
 const second=f.action.facts.metadata.admit({type:'plan/mode',mode:'off'});let completed=false;void second.then(()=>{completed=true});await Promise.resolve();await Promise.resolve();expect(writes).toBe(1);expect(completed).toBe(false)
 f.parent.assertCurrent();writer.release();writer.release();expect(await second).toMatchObject({kind:'committed'});expect(writes).toBe(2);await f.close()
})

it('refuses an actual same-source close recursion immediately and retains its exact failure for outside retry',async()=>{
 let reenter=true,attempts=0,selfFailure:unknown;const f=await fixture(async source=>{attempts++;expect(isInsideOriginalSettlementClose(source)).toBe(true);if(reenter)await source.close().catch(error=>{selfFailure=error;throw error})})
 let failure:unknown;await f.source.close().catch(error=>{failure=error});expect(failure).toMatchObject({code:'FACT_RECOVERY_REQUIRED'});expect((failure as AggregateError).errors).toContain(selfFailure);expect(attempts).toBe(1)
 reenter=false;await f.source.close();expect(attempts).toBe(2);await f.close()
})
it('coalesces external callers with the same original close ACK without granting a copied source own-close identity',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let drains=0
 const f=await fixture(async source=>{drains++;expect(isInsideOriginalSettlementClose(source)).toBe(true);expect(isInsideOriginalSettlementClose({...source})).toBe(false);entered.resolve();await release.promise})
 const first=f.source.close();await entered.promise;const second=f.source.close();expect(second).toBe(first);expect(isInsideOriginalSettlementClose(f.source)).toBe(false);release.resolve();await Promise.all([first,second]);expect(drains).toBe(1);await f.close()
})

it('keeps the live-captured original outer close ACK pending through failure and refuses copied or late lookup',async()=>{
 const marker=Object.freeze({original:'close failure'});let fail=true,drains=0;const f=await fixture(async()=>{drains++;if(fail)throw marker})
 const ack=captureOriginalSettlementCloseAck(f.source)!;expect(ack).toBeInstanceOf(Promise);expect(captureOriginalSettlementCloseAck({...f.source})).toBeUndefined();let acknowledged=false;void ack.then(()=>{acknowledged=true})
 let failure:unknown;await f.source.close().catch(error=>{failure=error});expect((failure as AggregateError).errors).toContain(marker);expect(acknowledged).toBe(false);expect(()=>captureOriginalSettlementCloseAck(f.source)).toThrow();
 fail=false;await f.source.close();await ack;expect(acknowledged).toBe(true);expect(drains).toBe(2);expect(()=>captureOriginalSettlementCloseAck(f.source)).toThrow();await f.close()
})

it('resumes the same parked exclusion only after concurrent original parent native IO settles',async()=>{
 const f=await fixture(),writer=await f.parent.acquireWriter(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();writer.park();let writes=0
 cut.run=async next=>{writes++;const outcome=await next();entered.resolve();await release.promise;return outcome}
 const fact=f.action.facts.metadata.admit({type:'plan/mode',mode:'on'});await entered.promise;let resumed=false;const resuming=writer.resume().then(()=>{resumed=true});await Promise.resolve();expect(resumed).toBe(false);release.resolve();expect(await fact).toMatchObject({kind:'committed'});await resuming;f.parent.assertCurrent();expect(writes).toBe(1);writer.release();await f.close()
})

it('drains the same original sources after revoke without releasing the document or dropping failed cleanup',async()=>{
 const marker=Object.freeze({original:'producer cleanup'});let failing=true,drains=0
 const f=await fixture(async()=>{drains++;if(failing)throw marker}),drain=f.document.drainOriginalSources.bind(f.document),ack=captureOriginalSettlementCloseAck(f.source)!
 f.action.finish();f.document.revokeNewWork();let acknowledged=false;void ack.then(()=>{acknowledged=true})
 await expect(f.document.drainOriginalSources.call({...f.document})).rejects.toThrow('Invalid original document source drain')
 let failed:unknown;await drain().catch(error=>{failed=error});expect(failed).toMatchObject({code:'FACT_RECOVERY_REQUIRED'});expect(((failed as Error).cause as AggregateError).errors[0].errors).toContain(marker)
 expect(acknowledged).toBe(false);f.source.assertHeld();expect(()=>f.document.assertReady()).toThrow();expect(drains).toBe(1)
 failing=false;await Promise.all([drain(),drain()]);await ack;expect(acknowledged).toBe(true);expect(drains).toBe(2)
 // Source cleanup did not perform final document close or grant new admission.
 expect(await f.document.metadata.admit({type:'plan/mode',mode:'on'})).toMatchObject({kind:'not-issued'})
 await f.document.close();await f.close()
})

it.each([Object.freeze({original:'drain-marker'}),undefined,false])('original direct close cannot replace its own source barrier (%j)',async marker=>{
 let failing=true,drains=0,replacements=0
 const f=await fixture(async()=>{drains++;if(failing)throw marker}),originalClose=f.document.close.bind(f.document),exposed=Object.getOwnPropertyDescriptor(f.document,'drainOriginalSources')!,ack=captureOriginalSettlementCloseAck(f.source)!,before=await readFile(join(f.root,'parent.jsonl'))
 let acknowledged=false,primary:{cause:unknown}|undefined;void ack.then(()=>{acknowledged=true});f.action.finish()
 if(marker===undefined)Object.defineProperty(f.document,'drainOriginalSources',{configurable:true,get(){replacements++;throw Error('Replaced public drain getter')}});else f.document.drainOriginalSources=async()=>{replacements++}
 try{
  let rejected=false,cause:unknown;await originalClose().catch(error=>{rejected=true;cause=error});expect(rejected).toBe(true);expect(drains).toBe(1);expect(replacements).toBe(0)
  expect(cause).toBeInstanceOf(AggregateError);expect((cause as AggregateError).errors).toHaveLength(1)
  const ownedFailure=(cause as AggregateError).errors[0] as Error;expect(ownedFailure).toMatchObject({code:'FACT_RECOVERY_REQUIRED'});expect(ownedFailure.cause).toBeInstanceOf(AggregateError)
  const sourceFailures=(ownedFailure.cause as AggregateError).errors;expect(sourceFailures).toHaveLength(1);expect(sourceFailures[0]).toBeInstanceOf(AggregateError);expect(sourceFailures[0].errors).toEqual([marker])
  expect(acknowledged).toBe(false);f.source.assertHeld();expect(()=>f.document.assertReady()).toThrow()
  failing=false;await originalClose();await ack;expect(acknowledged).toBe(true);expect(drains).toBe(2);expect(replacements).toBe(0);expect(await readFile(join(f.root,'parent.jsonl'))).toEqual(before)
 }catch(cause){primary={cause}}finally{failing=false;Object.defineProperty(f.document,'drainOriginalSources',exposed);const errors:unknown[]=[];try{await f.source.close()}catch(error){errors.push(error)};try{await f.close()}catch(error){errors.push(error)};if(primary||errors.length)throw new AggregateError([...(primary?[primary.cause]:[]),...errors],'Original close barrier and cleanup must both acknowledge')}
})

it('original direct close fences admission before joining its source even if public revoke is replaced',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),f=await fixture(async()=>{entered.resolve();await release.promise}),originalClose=f.document.close.bind(f.document),revoke=f.document.revokeNewWork
 let replacementCalls=0;f.document.revokeNewWork=()=>{replacementCalls++};f.action.finish();const closing=originalClose();void closing.catch(()=>{})
 try{await entered.promise;expect(()=>f.document.assertReady()).toThrow();expect(replacementCalls).toBe(0)}finally{f.document.revokeNewWork=revoke;revoke();release.resolve();await closing;await f.close()}
})

it('marks the original attached entry before synchronous Task revocation port reentry',async()=>{
 let captureParent:(()=>unknown)|undefined,failing=true,drains=0,portCalls=0;const admitted:unknown[]=[],refused:unknown[]=[]
 const f=await fixture(async()=>{drains++;if(failing)throw false},()=>{portCalls++;try{admitted.push(captureParent!())}catch(error){refused.push(error)}})
 captureParent=f.captureOrdinaryParent;f.captureOrdinaryParent().assertCurrent();const ack=captureOriginalSettlementCloseAck(f.source)!,close=f.document.close.bind(f.document),before=await readFile(join(f.root,'parent.jsonl'));let acknowledged=false;void ack.then(()=>{acknowledged=true});f.action.finish()
 try{
  let failed=false,cause:unknown;await close().catch(error=>{failed=true;cause=error});expect(failed).toBe(true);expect(portCalls).toBeGreaterThan(0);expect(admitted).toEqual([]);expect(refused).toHaveLength(portCalls);expect(refused.map(error=>(error as {code?:string}).code)).toEqual(['FACT_RECOVERY_REQUIRED','FACT_CLOSED'])
  expect(cause).toBeInstanceOf(AggregateError);const originalFailure=(cause as AggregateError).errors[0] as Error;expect(originalFailure).toMatchObject({code:'FACT_RECOVERY_REQUIRED'});expect(((originalFailure.cause as AggregateError).errors[0] as AggregateError).errors).toEqual([false])
  expect(drains).toBe(1);expect(acknowledged).toBe(false);f.source.assertHeld();failing=false;await close();await ack;expect(acknowledged).toBe(true);expect(drains).toBe(2);expect(admitted).toEqual([]);expect(await readFile(join(f.root,'parent.jsonl'))).toEqual(before)
 }finally{failing=false;await f.source.close();await f.close()}
})
