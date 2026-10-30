import { it, expect, vi } from 'vitest'
const faults=vi.hoisted(()=>({sync:false,close:false,stageClose:false,closes:0,leaked:undefined as undefined|{fd:number},openGate:undefined as undefined|Promise<void>,openEntered:undefined as undefined|(()=>void)}))
vi.mock('node:fs/promises',async importOriginal=>{
 const original=await importOriginal<typeof import('node:fs/promises')>()
 return {...original,open:async (...args:Parameters<typeof original.open>)=>{
  const handle=await original.open(...args)
  const isJournal=typeof args[0]==='string'&&args[0].endsWith('target.jsonl')&&args[1]==='r+'
  const isStage=typeof args[0]==='string'&&args[0].endsWith('.stage')&&args[1]==='r'
  if(!isJournal&&!isStage)return handle
  if(faults.openGate){faults.openEntered?.();await faults.openGate}
  return new Proxy(handle,{get(target,key){
   if(key==='sync')return async()=>{if(faults.sync){faults.sync=false;throw Error('injected sync failure')}return target.sync()}
   if(key==='close')return async()=>{faults.closes++;if(isJournal&&faults.close||isStage&&faults.stageClose){if(isJournal)faults.close=false;else faults.stageClose=false;faults.leaked=target;throw Error('injected close failure')}await target.close()}
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
  }})
 }}
})
import { mkdtemp, writeFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeFactBatch, decodeFactBatch } from '@i-harness/core-session'
import { heldFactOwner, issuingFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { codecSeed, codecPage, codecRow, sealCodecSeed } from '../../core-session/test/fixtures/selected-results.ts'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { buildSelectedResultsHeader } from '../../session-persistence/src/coordinator/selected-results-header.ts'
import { selectedBootstrapPaths } from '../src/backend/selected-results-route-path.ts'
import { createJsonlBackend } from '../src/index.ts'
import * as selectedModule from '../src/backend/selected-fact-journal.ts'
function selectedSeed() {
 const exported=codecSeed('public-completed',[codecPage([codecRow()])]);exported.seed.groups=[{extent:{kind:'framed',first:1,last:1},items:[{kind:'summary',scope:'turn',extent:{kind:'framed',first:1,last:1},origins:[{origin:0,seq:1,part:'message'}],sourceProvenance:[{origin:0,kind:'summary',authority:'derived',scope:'turn'}],messages:[{role:'user',content:'summary'}]}]}];exported.seed.passive.codeStore.groups=[0];return sealCodecSeed(exported.seed)
}
async function fixture() {
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'lane-')),path=join(root,'target.jsonl'),backend=createJsonlBackend(root),journal=backend.selectedJournal
 const ownership=createOwnership(backend,{lock:{enabled:true}}),claim=await ownership.pinOwnership('target')
 const held=heldFactOwner({sessionId:'target',incarnation:'original'},ownership,()=>claim.assertHeld()),issuer=issuingFactOwner(held,()=>held.assertHeld())
 const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'})
 const invocation={version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},request={invocation,core,requestIntent:intent},route={protocol:'public-results-v1' as const,request},reservation={version:1,kind:'semantic-bootstrap-selected-results-capture',request},seed=compileSelectedResultsSemanticSeed(selectedSeed())
 const built=buildSelectedResultsHeader({invocation,target:{kind:'new'},metadata:{},lineage:{origin:'fork',parentSession:'source'},seed},reservation),meta=JSON.parse(built.headerBytes),first=encodeFactBatch('bootstrap:op:seed',meta.journal.legacyPrefixDigest,seed.records),complete=encodeFactBatch('bootstrap:op:complete',decodeFactBatch(first.bytes).prefixDigest,[{type:'session/bootstrap',version:1,seq:seed.records.length,operationId:'op',manifestDigest:meta.semanticSeed.manifestDigest,dependencyClosureDigest:seed.dependencyDigest,seedLength:seed.records.length}])
 const raw=Buffer.concat([Buffer.from(built.headerBytes),Buffer.from(first.bytes),Buffer.from(complete.bytes)]),torn=Buffer.concat([raw,Buffer.from('{')]),initial={eventCount:0,bodyBytes:0,prefixDigest:meta.journal.legacyPrefixDigest},seedPrefix={eventCount:seed.records.length,bodyBytes:first.bytes.length,prefixDigest:decodeFactBatch(first.bytes).prefixDigest},frames=[{prefix:initial,batch:first},{prefix:seedPrefix,batch:complete}]
 await writeFile(path,raw);await writeFile(selectedBootstrapPaths(path,route).stage,built.stageBytes)
 const birth=await journal.resolveCheckedBirth('target',held);if(!birth)throw Error('Missing checked birth')
 const scope=journal.bindCheckedBirthLane('target',held,birth)
 return {root,path,backend,journal,ownership,held,issuer,route,built,raw,torn,initial,first,frames,birth,scope,async close(){await backend.settleBootstrapCaptureIO!('target',held);await claim.release()}}
}
it('binds only this factory and held owner checked-birth identity, never stage JSON',async()=>{
 const f=await fixture()
 try {
  expect('createSelectedLaneScope' in selectedModule).toBe(false)
  expect(f.journal.bindCheckedBirthLane('target',f.held,f.birth)).toBe(f.scope)
  expect(()=>f.journal.bindCheckedBirthLane('target',f.held,{...f.birth})).toThrow('Original held checked birth')
  expect(()=>f.journal.bindCheckedBirthLane('target',f.held,new Proxy(f.birth,{}))).toThrow()
  const unheld=await f.journal.resolveBirth('target');expect(()=>f.journal.bindCheckedBirthLane('target',f.held,unheld!)).toThrow()
  const other=createJsonlBackend(f.root);expect(()=>other.selectedJournal.bindCheckedBirthLane('target',f.held,f.birth)).toThrow()
  const otherOwner=heldFactOwner({sessionId:'target',incarnation:'original'},f.ownership,()=>f.held.assertHeld())
  expect(()=>f.journal.bindCheckedBirthLane('target',otherOwner,f.birth)).toThrow()
  expect(()=>f.journal.readJournalPrefix('target',otherOwner,f.scope)).toThrow()
  await expect(f.journal.appendOwnedBatch('target',f.issuer,f.scope,f.initial,f.first)).resolves.toMatchObject({kind:'conflict'})
  await writeFile(f.path,Buffer.from(f.built.headerBytes))
  await expect(f.journal.appendOwnedBatch('target',f.issuer,f.scope,f.initial,f.first)).resolves.toMatchObject({kind:'absent'})
  expect(await readFile(f.path)).toEqual(Buffer.from(f.built.headerBytes))
 } finally {await f.close()}
})
it('keeps complete birth required before repair and confirms actual exact original frames',async()=>{
 const f=await fixture()
 try{
  await writeFile(f.path,f.torn);const prefix=await f.journal.readJournalPrefix('target',f.held,f.scope);expect(await readFile(f.path)).toEqual(f.raw)
  const ack=await f.journal.confirmFrames('target',f.held,f.scope,f.frames);expect(ack.kind).toBe('committed')
  if(ack.kind==='committed')expect(ack.receipts.map(r=>r.key.batchId)).toEqual(['bootstrap:op:seed','bootstrap:op:complete'])
  const foreign=encodeFactBatch('bootstrap:foreign:complete',f.frames[1]!.prefix.prefixDigest,decodeFactBatch(f.frames[1]!.batch.bytes).events)
  expect((await f.journal.confirmFrames('target',f.held,f.scope,[f.frames[0]!,{prefix:f.frames[1]!.prefix,batch:foreign}])).kind).toBe('conflict')
  const foreignPath=f.path+'.bootstrap-'+'a'.repeat(64)+'.stage';await writeFile(foreignPath,'x');await writeFile(f.path,f.torn)
  await expect(f.journal.readJournalPrefix('target',f.held,f.scope)).rejects.toThrow();expect(await readFile(f.path)).toEqual(f.torn);await unlink(foreignPath)
  await writeFile(selectedBootstrapPaths(f.path,f.route).stage,'{}');await expect(f.journal.readJournalPrefix('target',f.held,f.scope)).rejects.toThrow();expect(await readFile(f.path)).toEqual(f.torn)
  await writeFile(selectedBootstrapPaths(f.path,f.route).stage,f.built.stageBytes)
  const partial=Buffer.concat([Buffer.from(f.built.headerBytes),Buffer.from(f.first.bytes),Buffer.from('{')]);await writeFile(f.path,partial)
  await expect(f.journal.resolveCheckedBirth('target',f.held)).rejects.toThrow();await expect(f.journal.readJournalPrefix('target',f.held,f.scope)).rejects.toThrow();expect(await readFile(f.path)).toEqual(partial)
  expect(prefix.eventCount).toBe(f.birth.stage.seed.seedLength+1)
 }finally{await f.close()}
})
it('snapshots bytes, recovers only original issued ordinary batch and retains durable receipt on close debt',async()=>{
 const f=await fixture()
 try{
  const prefix=await f.journal.readJournalPrefix('target',f.held,f.scope),batch=encodeFactBatch('ordinary',prefix.prefixDigest,[{type:'plan/mode',mode:'on',seq:prefix.eventCount}]),mutable={key:{...batch.key},bytes:Buffer.from(batch.bytes)}
  let getters=0;Object.defineProperty(mutable.bytes,'length',{get(){getters++;throw Error('length')}});Object.defineProperty(mutable.bytes,Symbol.iterator,{get(){getters++;throw Error('iterator')}})
  const denied=issuingFactOwner(f.held,()=>{throw Object.assign(Error('stale'),{code:'FACT_PRECONDITION_STALE'})})
  expect(await f.journal.appendOwnedBatch('target',denied,f.scope,prefix,batch)).toEqual({kind:'not-issued',code:'FACT_PRECONDITION_STALE'})
  await expect(f.journal.reconcileOwnedBatch('target',f.held,f.scope,prefix,batch)).rejects.toThrow('Original issued batch')
  faults.sync=true;const flight=f.journal.appendOwnedBatch('target',f.issuer,f.scope,prefix,mutable);Uint8Array.prototype.fill.call(mutable.bytes,0);mutable.key.batchId='changed'
  expect((await flight).kind).toBe('unknown');expect(getters).toBe(0)
  expect((await f.journal.reconcileOwnedBatch('target',f.held,f.scope,prefix,batch)).kind).toBe('committed')
  await writeFile(f.path,Buffer.concat([f.raw,Buffer.from(batch.bytes.subarray(0,10))]));expect((await f.journal.reconcileOwnedBatch('target',f.held,f.scope,prefix,batch)).kind).toBe('absent');expect(await readFile(f.path)).toEqual(f.raw)
  faults.close=true;const receipt=await f.journal.appendOwnedBatch('target',f.issuer,f.scope,prefix,batch);expect(receipt).toMatchObject({kind:'committed',cleanupDiagnostic:'file-close-failed'});expect(faults.leaked!.fd).toBeGreaterThanOrEqual(0)
  expect(()=>f.journal.confirmFrames('target',f.held,f.scope,f.frames)).toThrow('injected close')
  faults.close=true;await expect(f.backend.settleBootstrapCaptureIO!('target',f.held)).rejects.toThrow('cleanup unresolved');expect(faults.leaked!.fd).toBeGreaterThanOrEqual(0)
  await f.backend.settleBootstrapCaptureIO!('target',f.held);expect(faults.leaked!.fd).toBe(-1)
  expect((await f.journal.reconcileOwnedBatch('target',f.held,f.scope,prefix,batch)).kind).toBe('committed')
 }finally{await f.close()}
})
it('retains pre-issue, prefix and ACK close failures for original settlement',async()=>{
 const f=await fixture()
 try{
  const prefix=await f.journal.readJournalPrefix('target',f.held,f.scope),batch=encodeFactBatch('ordinary',prefix.prefixDigest,[{type:'plan/mode',mode:'on',seq:prefix.eventCount}])
  const denied=issuingFactOwner(f.held,()=>{throw Object.assign(Error('stale'),{code:'FACT_PRECONDITION_STALE'})});faults.close=true
  expect((await f.journal.appendOwnedBatch('target',denied,f.scope,prefix,batch)).kind).toBe('not-issued');expect(faults.leaked!.fd).toBeGreaterThanOrEqual(0)
  await f.backend.settleBootstrapCaptureIO!('target',f.held);expect(faults.leaked!.fd).toBe(-1)
  await writeFile(f.path,f.torn);faults.close=true;await expect(f.journal.readJournalPrefix('target',f.held,f.scope)).rejects.toThrow('injected close');expect(await readFile(f.path)).toEqual(f.raw)
  await f.backend.settleBootstrapCaptureIO!('target',f.held);expect(faults.leaked!.fd).toBe(-1)
  faults.close=true;expect((await f.journal.confirmFrames('target',f.held,f.scope,f.frames)).kind).toBe('unknown');expect(faults.leaked!.fd).toBeGreaterThanOrEqual(0)
  await f.backend.settleBootstrapCaptureIO!('target',f.held);expect(faults.leaked!.fd).toBe(-1)
  expect((await f.journal.confirmFrames('target',f.held,f.scope,f.frames)).kind).toBe('committed')
 }finally{await f.close()}
})
it('settlement joins a delayed original open before closing its retained handle',async()=>{
 const f=await fixture()
 try{
  const opened=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();faults.openGate=release.promise;faults.openEntered=()=>opened.resolve()
  const flight=f.journal.confirmFrames('target',f.held,f.scope,f.frames);await opened.promise
  let settled=false;const cleanup=f.backend.settleBootstrapCaptureIO!('target',f.held).then(()=>{settled=true})
  await Promise.resolve();expect(settled).toBe(false);faults.close=true;release.resolve();expect((await flight).kind).toBe('unknown');await cleanup;expect(faults.leaked!.fd).toBe(-1)
 }finally{faults.openGate=undefined;faults.openEntered=undefined;await f.close()}
})
it('retains nested stage-read close debt in the same original settlement ledger',async()=>{
 const f=await fixture()
 try{
  faults.stageClose=true
  await expect(f.journal.resolveCheckedBirth('target',f.held)).rejects.toThrow('Original selected stage unavailable')
  expect(faults.leaked!.fd).toBeGreaterThanOrEqual(0)
  expect(()=>f.journal.confirmFrames('target',f.held,f.scope,f.frames)).toThrow('injected close')
  await f.backend.settleBootstrapCaptureIO!('target',f.held);expect(faults.leaked!.fd).toBe(-1)
  expect((await f.journal.confirmFrames('target',f.held,f.scope,f.frames)).kind).toBe('committed')
 }finally{await f.close()}
})

it('issues only the two retained captured frames before a completed birth exists',async()=>{
 const f=await fixture()
 try{
  await writeFile(f.path,Buffer.from(f.built.headerBytes))
  const attempt={},records=decodeFactBatch(f.first.bytes).events
  const lane=f.journal.bindCapturedLane('target',f.issuer,f.route,f.built.stage,records,attempt)
  expect(lane).not.toBe(f.scope)
  expect(f.journal.bindCapturedLane('target',f.issuer,f.route,f.built.stage,records,attempt,lane)).toBe(lane)
  const otherOwner=heldFactOwner({sessionId:'target',incarnation:'original'},f.ownership,()=>f.held.assertHeld())
  expect(()=>f.journal.bindCapturedLane('target',issuingFactOwner(otherOwner,()=>{}),f.route,f.built.stage,records,attempt,lane)).toThrow()
  expect(()=>f.journal.readJournalPrefix('target',f.held,{...lane})).toThrow()
  expect(()=>createJsonlBackend(f.root).selectedJournal.readJournalPrefix('target',f.held,lane)).toThrow()
  let getter=false;const malicious={...f.frames[1]!};Object.defineProperty(malicious,'batch',{enumerable:true,get(){getter=true;throw Error('getter')}})
  expect(()=>f.journal.prepareCapturedCompletion('target',f.held,lane,malicious)).toThrow();expect(getter).toBe(false)
  f.journal.prepareCapturedCompletion('target',f.held,lane,f.frames[1]!)
  await writeFile(f.path,Buffer.concat([Buffer.from(f.built.headerBytes),Buffer.from(f.first.bytes)]))
  expect((await f.journal.appendOwnedBatch('target',f.issuer,lane,f.frames[1]!.prefix,f.frames[1]!.batch)).kind).toBe('absent')
  await writeFile(f.path,Buffer.from(f.built.headerBytes))
  const foreign=encodeFactBatch('bootstrap:op:seed',f.initial.prefixDigest,[{type:'plan/mode',mode:'on',seq:0}])
  expect((await f.journal.appendOwnedBatch('target',f.issuer,lane,f.initial,foreign)).kind).toBe('absent')
  expect((await f.journal.appendOwnedBatch('target',f.issuer,lane,f.frames[0]!.prefix,f.frames[0]!.batch)).kind).toBe('committed')
  f.journal.prepareCapturedCompletion('target',f.held,lane,f.frames[1]!)
  expect((await f.journal.appendOwnedBatch('target',f.issuer,lane,f.frames[1]!.prefix,f.frames[1]!.batch)).kind).toBe('committed')
  expect((await f.journal.confirmFrames('target',f.held,lane,f.frames)).kind).toBe('committed')
  expect(await readFile(f.path)).toEqual(f.raw)
 }finally{await f.close()}
})

it('adopts a checked selected birth under the actual managed document owner and appends its suffix',async()=>{
 const f=await fixture()
 try{
  const {createManagedDocument}=await import('../../session-persistence/src/coordinator/managed-document.ts'),{buildSession}=await import('../../session-persistence/src/format/validation.ts'),{readFactJournal}=await import('@i-harness/core-session')
  const meta=JSON.parse(f.built.headerBytes),decoded=readFactJournal(f.raw.subarray(Buffer.byteLength(f.built.headerBytes)),meta.journal,meta.formatVersion,meta),session=buildSession(meta,decoded.events)
  let control:any;const document=createManagedDocument('target',session,decoded.prefix,f.backend,f.ownership,undefined,()=>{},{operationId:'op',selected:true,bind(value){control=value}})
  expect(()=>control.ready()).toThrow()
  faults.close=true;const first=control.bindSelected(),joined=control.bindSelected();expect(joined).toBe(first);await expect(first).rejects.toThrow();expect(faults.leaked!.fd).toBe(-1)
  await control.bindSelected();control.ready()
  expect((await document.metadata.admit({type:'plan/mode',mode:'on'})).kind).toBe('committed')
  expect((await readFile(f.path)).subarray(0,f.raw.length)).toEqual(f.raw)
  await document.close()
 }finally{await f.close()}
})

it('reconciles an uncertain original selected seed before authorizing completion',async()=>{
 const f=await fixture()
 try{
  await writeFile(f.path,Buffer.from(f.built.headerBytes))
  const lane=f.journal.bindCapturedLane('target',f.issuer,f.route,f.built.stage,decodeFactBatch(f.first.bytes).events,{})
  f.journal.prepareCapturedCompletion('target',f.held,lane,f.frames[1]!)
  faults.sync=true;expect((await f.journal.appendOwnedBatch('target',f.issuer,lane,f.frames[0]!.prefix,f.frames[0]!.batch)).kind).toBe('unknown')
  expect((await f.journal.appendOwnedBatch('target',f.issuer,lane,f.frames[1]!.prefix,f.frames[1]!.batch)).kind).toBe('absent')
  expect((await f.journal.reconcileOwnedBatch('target',f.held,lane,f.frames[0]!.prefix,f.frames[0]!.batch)).kind).toBe('committed')
  expect((await f.journal.appendOwnedBatch('target',f.issuer,lane,f.frames[1]!.prefix,f.frames[1]!.batch)).kind).toBe('committed')
  expect(await readFile(f.path)).toEqual(f.raw)
 }finally{await f.close()}
})

it('joins selected birth binding before managed document closes',async()=>{
 const f=await fixture()
 try{
  const {createManagedDocument}=await import('../../session-persistence/src/coordinator/managed-document.ts'),{buildSession}=await import('../../session-persistence/src/format/validation.ts'),{readFactJournal}=await import('@i-harness/core-session')
  const meta=JSON.parse(f.built.headerBytes),decoded=readFactJournal(f.raw.subarray(Buffer.byteLength(f.built.headerBytes)),meta.journal,meta.formatVersion,meta),session=buildSession(meta,decoded.events)
  let control:any;const document=createManagedDocument('target',session,decoded.prefix,f.backend,f.ownership,undefined,()=>{},{operationId:'op',selected:true,bind(value){control=value}})
  const entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>();faults.openGate=leave.promise;faults.openEntered=entered.resolve
  const binding=control.bindSelected().catch((error:unknown)=>error);await entered.promise;let closed=false;const closing=document.close().then(()=>{closed=true});try{await Promise.resolve();expect(closed).toBe(false)}finally{leave.resolve()}
  expect(await binding).toBeInstanceOf(Error);await closing;expect(closed).toBe(true)
 }finally{faults.openGate=undefined;faults.openEntered=undefined;await f.close()}
})
