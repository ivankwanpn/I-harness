import { stat, type FileHandle } from 'node:fs/promises'
import { types } from 'node:util'
import { canonicalJsonData, readFactJournal, isStrictFactData, decodeFactBatch, encodeFactBatch, validJournalPrefix } from '@i-harness/core-session'
import { isHeldFactOwner, captureSelectedResultsRoute, type HeldFactOwner, type SelectedResultsRoute, type SelectedResultsHeaderStageV2 } from '@i-harness/session-persistence'
import { assertSelectedCurrentHeader } from './selected-current-header.ts'
import { resolveSelectedBirth } from './selected-birth.ts'
import { lookupSelectedBootstrapStage } from './selected-bootstrap-stage.ts'
import { bootstrapNamespace } from './bootstrap-stage.ts'
import type { BootstrapCaptureIO, CaptureLedger, CaptureResource } from './bootstrap-capture-io.ts'
import { parseHeader } from '../format.ts'
import { readBootstrapFactJournal } from '@i-harness/core-session/internal/bootstrap'
import { selectedResultsPreparationFacts } from '../../../session-persistence/src/coordinator/selected-results-preparation.ts'

type ScopeData={route:SelectedResultsRoute;stage:SelectedResultsHeaderStageV2;owner:HeldFactOwner['owner'];birthBody:Buffer;capturedFrames?:ReturnType<typeof captureBatch>[];acknowledged?:Set<number>;attempt?:object}
export type SelectedLaneScope=Readonly<{kind:'selected-lane'}>
type Birth=NonNullable<Awaited<ReturnType<typeof resolveSelectedBirth>>>
const same=(a:unknown,b:unknown)=>canonicalJsonData(a)===canonicalJsonData(b)
function matchesBirth(raw:Buffer,end:number,meta:ReturnType<typeof parseHeader>,data:ScopeData) {
 const original=JSON.parse(data.stage.headerBytes)
 const header=original.formatVersion===13 && meta.formatVersion===14 ? canonicalJsonData({...original,formatVersion:14})+'\n' : data.stage.headerBytes
 if(end<0||end+1>65536)return false
 if(data.capturedFrames){if(!raw.subarray(0,end+1).equals(Buffer.from(header)))return false}
 else {try{assertSelectedCurrentHeader(data.stage,JSON.parse(raw.subarray(0,end).toString('utf8')))}catch{return false}}
 return raw.subarray(end+1,end+1+data.birthBody.length).equals(data.birthBody)
}
const byteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'length')!.get!
function snapshotBytes(input:unknown):Buffer {
 if(types.isProxy(input)||!types.isUint8Array(input))throw TypeError('Invalid batch bytes')
 const copy=Buffer.alloc(byteLength.call(input));Uint8Array.prototype.set.call(copy,input);return copy
}
function closed(input:unknown,keys:readonly string[]) {
 if(!input||typeof input!=='object'||types.isProxy(input)||!isStrictFactData(input))return false
 const fields=Object.getOwnPropertyDescriptors(input), actual=Reflect.ownKeys(input)
 return actual.length===keys.length&&keys.every(key=>{const d=fields[key];return !!d&&'value' in d&&d.enumerable})
}
function captureBatch(prefixInput:import('@i-harness/core-session').JournalPrefix,batchInput:import('@i-harness/core-session').EncodedFactBatch) {
 if(!batchInput||typeof batchInput!=='object'||types.isProxy(batchInput)||Reflect.ownKeys(batchInput).length!==2)throw new TypeError('Invalid batch inputs')
 const k=Object.getOwnPropertyDescriptor(batchInput,'key'),b=Object.getOwnPropertyDescriptor(batchInput,'bytes')
 if(!k||!('value' in k)||!k.enumerable||!b||!('value' in b)||!b.enumerable||!closed(prefixInput,['eventCount','bodyBytes','prefixDigest'])||!closed(k.value,['batchId','firstSeq','count','previousPrefixDigest','batchDigest'])||!validJournalPrefix(prefixInput))throw new TypeError('Invalid batch inputs')
 const prefix=JSON.parse(canonicalJsonData(prefixInput)) as typeof prefixInput,key=JSON.parse(canonicalJsonData(k.value)) as typeof batchInput.key,bytes=snapshotBytes(b.value),batch=decodeFactBatch(bytes)
 if(!same(key,batch.key)||key.firstSeq!==prefix.eventCount||key.previousPrefixDigest!==prefix.prefixDigest)throw new TypeError('Invalid batch')
 return {prefix,key,bytes,batch}
}
/** Private factory; no selected bootstrap authoring capability is advertised. */
export function createSelectedFactJournalBackend(filePath:(id:string)=>string,assertNotDeleted:(kind:string,id:string)=>Promise<void>,captureIO:BootstrapCaptureIO) {
 const scopes=new WeakMap<object,ScopeData>()
 const checkedBirths=new WeakMap<object,{id:string;owner:HeldFactOwner['owner'];birthBody:Buffer;history:ReturnType<typeof readBootstrapFactJournal>;meta:ReturnType<typeof parseHeader>}>()
 const birthLanes=new WeakMap<object,WeakMap<object,SelectedLaneScope>>()
 const issuedBatches=new WeakMap<object,Map<string,{prefix:import('@i-harness/core-session').JournalPrefix;bytes:Buffer}>>()
 const stageIO=(ledger:CaptureLedger,path:string,guard:()=>void)=>({namespace:()=>bootstrapNamespace(path),read:(p:string,limit:number)=>captureIO.bytes(ledger,p,limit,guard),assertCurrent:guard})
 async function readWhole(ledger:CaptureLedger,path:string,guard:()=>void) {
  const resource=await captureIO.acquire(ledger,path,'r')
  try{guard();const raw=await resource.handle.readFile();guard();return raw}finally{await captureIO.close(ledger,resource)}
 }
 const birthIO=(ledger:CaptureLedger,path:string,guard:()=>void)=>({readJournal:()=>readWhole(ledger,path,guard),stage:stageIO(ledger,path,guard)})
 function resolveCheckedBirth(id:string,owner:HeldFactOwner) {
  captureIO.scope(id,owner)
  return captureIO.tracked(id,owner,async ledger=>{
   const guard=()=>captureIO.scope(id,owner),path=filePath(id)
let observed:Buffer|undefined
   const io=birthIO(ledger,path,guard)
   const birth=await resolveSelectedBirth(path,id,assertNotDeleted,{stage:io.stage,async readJournal(){observed=await io.readJournal();return observed}});guard();captureIO.assertNoCleanupDebt(ledger)
if(birth){
    const raw=observed!,end=raw.indexOf(10),meta=parseHeader(raw.subarray(0,end).toString('utf8')),journal=readBootstrapFactJournal(raw.subarray(end+1),meta.journal!,meta.formatVersion,meta),last=journal.frames[1]!
    checkedBirths.set(birth,{id,owner:owner.owner,birthBody:Buffer.from(raw.subarray(end+1,end+1+last.prefix.bodyBytes+last.batch.bytes.length)),history:journal,meta})
   }
   return birth
  })
 }
 /** Qualify the entire original route before exposing the held checked birth. */
 async function inspectCheckedBirth(input:SelectedResultsRoute,owner:HeldFactOwner):Promise<
  {kind:'checked';birth:Birth;history:ReturnType<typeof readBootstrapFactJournal>;meta:ReturnType<typeof parseHeader>}|{kind:'unavailable'}|{kind:'conflict'}> {
  const route=captureSelectedResultsRoute(input),id=route.request.invocation.targetSessionId
  const birth=await resolveCheckedBirth(id,owner)
  if(!birth)return {kind:'unavailable'}
  if(!same(route,birth.route))return {kind:'conflict'}
  const {history,meta}=checkedBirths.get(birth)!
  if(history.torn)throw TypeError('Selected journal has incomplete suffix')
  return {kind:'checked',birth,history,meta}
 }
 function bindCheckedBirthLane(id:string,owner:HeldFactOwner,birth:Birth):SelectedLaneScope {
  captureIO.scope(id,owner)
  const checked=checkedBirths.get(birth)
  if(!checked||checked.id!==id||checked.owner!==owner.owner)throw TypeError('Original held checked birth required')
  let owners=birthLanes.get(birth);if(!owners){owners=new WeakMap();birthLanes.set(birth,owners)}
  const prior=owners.get(owner.owner);if(prior)return prior
  const lane=Object.freeze({kind:'selected-lane' as const});scopes.set(lane,{route:birth.route,stage:birth.stage,owner:owner.owner,birthBody:Buffer.from(checked.birthBody)});owners.set(owner.owner,lane);return lane
 }
/** Called only by the original entry after its checked capture succeeds. */
function bindCapturedLane(id:string,owner:import('@i-harness/session-persistence').IssuingFactOwner,route:SelectedResultsRoute,stage:SelectedResultsHeaderStageV2,records:unknown,attempt:object,prior?:SelectedLaneScope):SelectedLaneScope {
 captureIO.scope(id,owner)
 if(typeof owner.beforeIssue!=='function'||!attempt||typeof attempt!=='object'||types.isProxy(attempt))throw TypeError('Original captured owner required')
 route=captureSelectedResultsRoute(route);selectedResultsPreparationFacts(stage,records)
 if(!same(route.request,stage.captureReservation.request)||id!==route.request.invocation.targetSessionId)throw TypeError('Original captured route required')
 const meta=JSON.parse(stage.headerBytes),prefix={eventCount:0,bodyBytes:0,prefixDigest:meta.journal.legacyPrefixDigest}
 const batch=encodeFactBatch('bootstrap:'+stage.invocation.operationId+':seed',prefix.prefixDigest,records as import('@i-harness/core-session').SessionEvent[]),seed=captureBatch(prefix,batch)
 if(prior){const data=check(id,owner,prior);if(data.attempt!==attempt||!same(data.route,route)||!same(data.stage,stage)||!data.capturedFrames||!data.capturedFrames[0]!.bytes.equals(seed.bytes))throw TypeError('Captured lane changed');return prior}
 const lane=Object.freeze({kind:'selected-lane' as const})
 scopes.set(lane,{route:JSON.parse(canonicalJsonData(route)),stage:JSON.parse(canonicalJsonData(stage)),owner:owner.owner,birthBody:Buffer.alloc(0),capturedFrames:[seed],acknowledged:new Set(),attempt});return lane
}
/** The same entry supplies its completion only after genuine dependency confirmation. */
function prepareCapturedCompletion(id:string,owner:HeldFactOwner,scope:SelectedLaneScope,frame:import('../../../session-persistence/src/coordinator/bootstrap-types.ts').BootstrapFrame):void {
 const data=check(id,owner,scope),seed=data.capturedFrames?.[0]
 if(!seed||!frame||types.isProxy(frame)||Reflect.ownKeys(frame).length!==2)throw TypeError('Captured lane required')
 const p=Object.getOwnPropertyDescriptor(frame,'prefix'),b=Object.getOwnPropertyDescriptor(frame,'batch')
 if(!p||!('value' in p)||!p.enumerable||!b||!('value' in b)||!b.enumerable)throw TypeError('Invalid captured completion')
 const complete=captureBatch(p.value,b.value),after={eventCount:seed.key.count,bodyBytes:seed.bytes.length,prefixDigest:seed.batch.prefixDigest}
 if(!same(complete.prefix,after)||complete.key.batchId!=='bootstrap:'+data.stage.invocation.operationId+':complete'||complete.key.count!==1)throw TypeError('Captured completion mismatch')
 const meta=JSON.parse(data.stage.headerBytes);readFactJournal(Buffer.concat([seed.bytes,complete.bytes]),meta.journal,meta.formatVersion,meta)
 const prior=data.capturedFrames![1];if(prior){if(!same(prior.prefix,complete.prefix)||!prior.bytes.equals(complete.bytes))throw TypeError('Captured completion changed');return}
 data.capturedFrames!.push(complete)
}
function check(id:string,owner:HeldFactOwner,scope:SelectedLaneScope):ScopeData {
 if(!isHeldFactOwner(owner))throw new TypeError('Original owner required')
 const data=scopes.get(scope);if(!data||data.owner!==owner.owner||id!==data.owner.sessionId)throw new TypeError('Selected lane scope mismatch')
 owner.assertHeld();return data
}
async function verifyUnchanged(handle:FileHandle,raw:Buffer,assertCurrent:()=>void) {
 const stat=await handle.stat();assertCurrent();if(stat.size!==raw.length)throw TypeError('Selected journal changed')
 const observed=Buffer.alloc(raw.length);let offset=0
 while(offset<observed.length){const result=await handle.read(observed,offset,observed.length-offset,offset);assertCurrent();if(!result.bytesRead)throw TypeError('Selected journal changed');offset+=result.bytesRead}
 if(!observed.equals(raw))throw TypeError('Selected journal changed')
}
async function verifyPath(handle:FileHandle,path:string,size:number,assertCurrent:()=>void) {
 const opened=await handle.stat();assertCurrent();const named=await stat(path);assertCurrent()
 if(opened.dev!==named.dev||opened.ino!==named.ino||opened.size!==size||named.size!==size)throw TypeError('Selected journal path changed')
}
async function readSelectedJournalPrefix(path:string,id:string,owner:HeldFactOwner,scope:SelectedLaneScope,assertNotDeleted:(kind:string,id:string)=>Promise<void>,ledger:CaptureLedger) {
 const data=check(id,owner,scope), birth=await resolveSelectedBirth(path,id,assertNotDeleted,birthIO(ledger,path,()=>check(id,owner,scope)));check(id,owner,scope)
 if(!birth||!same(birth.route,data.route)||!same(birth.stage,data.stage))throw new TypeError('Original selected birth unavailable')
 const raw=await readWhole(ledger,path,()=>check(id,owner,scope));check(id,owner,scope)
 const end=raw.indexOf(10),meta=parseHeader(raw.subarray(0,end).toString('utf8'))
 if(!matchesBirth(raw,end,meta,data)||!meta.journal)throw new TypeError('Original selected header unavailable')
 const decoded=readFactJournal(raw.subarray(end+1),meta.journal,meta.formatVersion,meta)
 const birthFrames=readBootstrapFactJournal(raw.subarray(end+1),meta.journal,meta.formatVersion,meta).frames
 const seed=birthFrames[0],complete=birthFrames[1],count=data.stage.seed.seedLength,op=data.stage.invocation.operationId
 if(!seed||!complete||seed.prefix.eventCount!==0||seed.batch.key.firstSeq!==0||seed.batch.key.count!==count||seed.batch.key.batchId!==`bootstrap:${op}:seed`||complete.prefix.eventCount!==count||complete.batch.key.firstSeq!==count||complete.batch.key.count!==1||complete.batch.key.batchId!==`bootstrap:${op}:complete`)throw new TypeError('Original selected birth frames unavailable')
 selectedResultsPreparationFacts(data.stage,decoded.events.slice(0,count))
 const resource=await captureIO.acquire(ledger,path,'r+'),handle=resource.handle
 try {
  check(id,owner,scope)
  const disk=await handle.readFile();check(id,owner,scope)
  if(!disk.equals(raw))throw new TypeError('Selected journal changed')
  await assertNotDeleted('session',id);check(id,owner,scope)
  await verifyUnchanged(handle,raw,()=>check(id,owner,scope));check(id,owner,scope)
  const stage=await lookupSelectedBootstrapStage(path,{kind:'route',route:data.route},stageIO(ledger,path,()=>check(id,owner,scope)));check(id,owner,scope)
  if(stage.kind!=='full'||!same(stage.stage,data.stage))throw new TypeError('Original selected stage unavailable')
  await verifyPath(handle,path,raw.length,()=>check(id,owner,scope));check(id,owner,scope)
  captureIO.assertNoCleanupDebt(ledger)
  if(decoded.torn){check(id,owner,scope);await handle.truncate(end+1+decoded.prefix.bodyBytes);check(id,owner,scope)}
  await handle.sync();check(id,owner,scope)
 }finally{await captureIO.close(ledger,resource!)}
 check(id,owner,scope)
 return decoded.prefix
}

/** Cold checked-birth lanes issue only ordinary suffixes under the real issuer. */
async function appendSelectedOwnedBatch(path:string,id:string,owner:import('@i-harness/session-persistence').IssuingFactOwner,scope:SelectedLaneScope,prefixInput:import('@i-harness/core-session').JournalPrefix,batchInput:import('@i-harness/core-session').EncodedFactBatch,assertNotDeleted:(kind:string,id:string)=>Promise<void>,ledger:CaptureLedger):Promise<import('@i-harness/session-persistence').BackendFactOutcome> {
 const data=check(id,owner,scope)
 const {prefix,key,bytes,batch}=captureBatch(prefixInput,batchInput)
 await assertNotDeleted('session',id);check(id,owner,scope)
 let resource:CaptureResource|undefined,handle:FileHandle|undefined,issued=false,synced=false
 let outcome:import('@i-harness/session-persistence').BackendFactOutcome={kind:'absent',key}
 try {
  resource=await captureIO.acquire(ledger,path,'r+');handle=resource.handle;check(id,owner,scope)
  const raw=await handle.readFile();check(id,owner,scope)
  const end=raw.indexOf(10),meta=parseHeader(raw.subarray(0,end).toString('utf8'))
  if(!meta.journal||!matchesBirth(raw,end,meta,data))throw new TypeError('Original selected header unavailable')
  const decoded=readBootstrapFactJournal(raw.subarray(end+1),meta.journal,meta.formatVersion,meta), frames=decoded.frames
  const seed=frames[0],complete=frames[1],count=data.stage.seed.seedLength,op=data.stage.invocation.operationId
  if(decoded.torn||!same(decoded.prefix,prefix)){outcome={kind:'conflict',key};return outcome}
  if(data.capturedFrames){
   for(let i=0;i<Math.min(frames.length,2);i++){const expected=data.capturedFrames[i],actual=frames[i];if(!expected||!data.acknowledged!.has(i)||!actual||!same(actual.prefix,expected.prefix)||!Buffer.from(actual.batch.bytes).equals(expected.bytes))throw TypeError('Original captured acknowledgement required')}
  }
  if(key.batchId.startsWith('bootstrap:')) {
   const expected=data.capturedFrames?.[frames.length]
   if(!expected||!same(expected.prefix,prefix)||!expected.bytes.equals(bytes))throw TypeError('Original captured frame required')
  } else {
  if(!seed||seed.batch.key.batchId!==`bootstrap:${op}:seed`||seed.batch.key.firstSeq!==0||seed.batch.key.count!==count)throw new TypeError('Original selected seed unavailable')
  if(!complete||complete.batch.key.batchId!==`bootstrap:${op}:complete`||complete.batch.key.firstSeq!==count||complete.batch.key.count!==1)throw new TypeError('Original selected completion unavailable')
  selectedResultsPreparationFacts(data.stage,decoded.events.slice(0,count))
  }
  const candidate=Buffer.concat([raw.subarray(end+1),bytes])
  if(data.capturedFrames&&frames.length===0)readBootstrapFactJournal(candidate,meta.journal,meta.formatVersion,meta)
  else readFactJournal(candidate,meta.journal,meta.formatVersion,meta)
  await assertNotDeleted('session',id);check(id,owner,scope)
  await verifyUnchanged(handle,raw,()=>check(id,owner,scope));check(id,owner,scope)
  const stage=await lookupSelectedBootstrapStage(path,{kind:'route',route:data.route},stageIO(ledger,path,()=>check(id,owner,scope)));check(id,owner,scope)
  if(stage.kind!=='full'||!same(stage.stage,data.stage))throw new TypeError('Original selected stage unavailable')
  await verifyPath(handle,path,raw.length,()=>check(id,owner,scope));check(id,owner,scope)
  check(id,owner,scope);captureIO.assertNoCleanupDebt(ledger);owner.beforeIssue();issued=true
  let issuedSet=issuedBatches.get(scope);if(!issuedSet){issuedSet=new Map();issuedBatches.set(scope,issuedSet)}
  issuedSet.set(canonicalJsonData(key),{prefix,bytes:Buffer.from(bytes)})
  let offset=0;while(offset<bytes.length){const result=await handle.write(bytes,offset,bytes.length-offset,raw.length+offset);check(id,owner,scope);if(result.bytesWritten<=0)throw Error('No write progress');offset+=result.bytesWritten}
  check(id,owner,scope);await handle.sync();synced=true;check(id,owner,scope)
  outcome={kind:'committed',receipt:{owner:{...owner.owner},key,lastSeq:key.firstSeq+key.count-1,prefixDigest:batch.prefixDigest}}
 }catch (error) {
  const code=(error as {code?:string}).code
  outcome=!issued&&['FACT_CANCELLED','FACT_CLOSED','FACT_OWNER_UNSUPPORTED','FACT_RECOVERY_REQUIRED','FACT_PRECONDITION_STALE'].includes(code??'')
   ? {kind:'not-issued',code:code as import('@i-harness/core-session').FactCode} : {kind:issued?'unknown':'absent',key}
 }
 finally {if(handle){try{await captureIO.close(ledger,resource!)}catch{if(synced&&outcome.kind==='committed')outcome={...outcome,cleanupDiagnostic:'file-close-failed'};else if(issued)outcome={kind:'unknown',key}}try{check(id,owner,scope)}catch{if(issued)outcome={kind:'unknown',key}}}}
 if(outcome.kind==='committed'&&data.capturedFrames){const index=data.capturedFrames.findIndex(frame=>same(frame.key,key)&&frame.bytes.equals(bytes));if(index>=0)data.acknowledged!.add(index)}
 return outcome
}


/** Reconcile only a batch issued by this original lane; a JSON key alone grants no repair authority. */
async function reconcileSelectedOwnedBatch(path:string,id:string,owner:HeldFactOwner,scope:SelectedLaneScope,prefixInput:import('@i-harness/core-session').JournalPrefix,batchInput:import('@i-harness/core-session').EncodedFactBatch,assertNotDeleted:(kind:string,id:string)=>Promise<void>,ledger:CaptureLedger):Promise<import('@i-harness/session-persistence').BackendFactOutcome> {
 const data=check(id,owner,scope),{prefix,key,bytes,batch}=captureBatch(prefixInput,batchInput),issued=issuedBatches.get(scope)?.get(canonicalJsonData(key))
 if(!issued||!same(issued.prefix,prefix)||!issued.bytes.equals(bytes))throw new TypeError('Original issued batch required')
 await assertNotDeleted('session',id);check(id,owner,scope)
 let resource:CaptureResource|undefined,handle:FileHandle|undefined,outcome:import('@i-harness/session-persistence').BackendFactOutcome={kind:'unknown',key},synced=false
 try {
  resource=await captureIO.acquire(ledger,path,'r+');handle=resource.handle;check(id,owner,scope)
  const raw=await handle.readFile();check(id,owner,scope)
  const end=raw.indexOf(10),meta=parseHeader(raw.subarray(0,end).toString('utf8'))
  if(!meta.journal||!matchesBirth(raw,end,meta,data))throw TypeError('Original selected header unavailable')
  const position=end+1+prefix.bodyBytes
  if(raw.length<position||raw.length>position+bytes.length){outcome={kind:'conflict',key};return outcome}
  const prior=raw.subarray(end+1,position),decoded=readBootstrapFactJournal(prior,meta.journal,meta.formatVersion,meta)
  if(decoded.torn||!same(decoded.prefix,prefix)){outcome={kind:'conflict',key};return outcome}
  const candidate=Buffer.concat([prior,bytes]),all=readBootstrapFactJournal(candidate,meta.journal,meta.formatVersion,meta),count=data.stage.seed.seedLength,op=data.stage.invocation.operationId,seed=all.frames[0],complete=all.frames[1]
  if(!seed||seed.batch.key.batchId!==`bootstrap:${op}:seed`||seed.batch.key.firstSeq!==0||seed.batch.key.count!==count)throw TypeError('Original selected seed unavailable')
  selectedResultsPreparationFacts(data.stage,all.events.slice(0,count))
  if(key.firstSeq!==0&&(!complete||complete.batch.key.batchId!==`bootstrap:${op}:complete`||complete.batch.key.firstSeq!==count||complete.batch.key.count!==1))throw TypeError('Original selected completion unavailable')
  if(key.firstSeq!==0)readFactJournal(candidate,meta.journal,meta.formatVersion,meta)
  const actual=raw.subarray(position)
  if(!actual.equals(bytes.subarray(0,actual.length))){outcome={kind:'conflict',key};return outcome}
  await assertNotDeleted('session',id);check(id,owner,scope)
  await verifyUnchanged(handle,raw,()=>check(id,owner,scope));check(id,owner,scope)
  const stage=await lookupSelectedBootstrapStage(path,{kind:'route',route:data.route},stageIO(ledger,path,()=>check(id,owner,scope)));check(id,owner,scope)
  if(stage.kind!=='full'||!same(stage.stage,data.stage))throw TypeError('Original selected stage unavailable')
  await verifyPath(handle,path,raw.length,()=>check(id,owner,scope));check(id,owner,scope)
  captureIO.assertNoCleanupDebt(ledger)
  if(actual.length<bytes.length){check(id,owner,scope);await handle.truncate(position);check(id,owner,scope)}
  await handle.sync();synced=true;check(id,owner,scope)
  outcome=actual.length===bytes.length?{kind:'committed',receipt:{owner:{...owner.owner},key,lastSeq:key.firstSeq+key.count-1,prefixDigest:batch.prefixDigest}}:{kind:'absent',key}
 }catch{outcome={kind:'unknown',key}}
 finally{if(handle){try{await captureIO.close(ledger,resource!)}catch{if(synced&&outcome.kind==='committed')outcome={...outcome,cleanupDiagnostic:'file-close-failed'};else outcome={kind:'unknown',key}}try{check(id,owner,scope)}catch{outcome={kind:'unknown',key}}}}
 if(outcome.kind==='committed'&&data.capturedFrames){const index=data.capturedFrames.findIndex(frame=>same(frame.key,key)&&frame.bytes.equals(bytes));if(index>=0)data.acknowledged!.add(index)}
 return outcome
}

/** Confirm only the two actual birth frames; this does not confer protocol readiness. */
async function confirmSelectedFrames(path:string,id:string,owner:HeldFactOwner,scope:SelectedLaneScope,expectedInput:readonly import('../../../session-persistence/src/coordinator/bootstrap-types.ts').BootstrapFrame[],assertNotDeleted:(kind:string,id:string)=>Promise<void>,ledger:CaptureLedger):Promise<{kind:'committed';receipts:import('@i-harness/core-session').FactReceipt[]}|{kind:'unknown'|'conflict'}> {
 const data=check(id,owner,scope)
 if(types.isProxy(expectedInput)||!Array.isArray(expectedInput)||expectedInput.length!==2||Reflect.ownKeys(expectedInput).length!==3)throw TypeError('Two original frames required')
 const expected=[]
 for(let i=0;i<2;i++){
  const entry=Object.getOwnPropertyDescriptor(expectedInput,String(i));if(!entry||!('value' in entry)||!entry.value||types.isProxy(entry.value)||Reflect.ownKeys(entry.value).length!==2)throw TypeError('Invalid frame')
  const p=Object.getOwnPropertyDescriptor(entry.value,'prefix'),b=Object.getOwnPropertyDescriptor(entry.value,'batch');if(!p||!('value' in p)||!b||!('value' in b))throw TypeError('Invalid frame')
  expected.push(captureBatch(p.value,b.value))
 }
 await assertNotDeleted('session',id);check(id,owner,scope)
 let resource:CaptureResource|undefined,handle:FileHandle|undefined,outcome:{kind:'committed';receipts:import('@i-harness/core-session').FactReceipt[]}|{kind:'unknown'|'conflict'}={kind:'unknown'}
 try {
  resource=await captureIO.acquire(ledger,path,'r+');handle=resource.handle;check(id,owner,scope)
  const raw=await handle.readFile();check(id,owner,scope)
  const end=raw.indexOf(10),meta=parseHeader(raw.subarray(0,end).toString('utf8'))
  if(!meta.journal||!matchesBirth(raw,end,meta,data))throw TypeError('Original selected header unavailable')
  const decoded=readBootstrapFactJournal(raw.subarray(end+1),meta.journal,meta.formatVersion,meta),count=data.stage.seed.seedLength,op=data.stage.invocation.operationId
  if(decoded.torn)throw TypeError('Torn journal')
  readFactJournal(raw.subarray(end+1),meta.journal,meta.formatVersion,meta)
  const seed=decoded.frames[0],complete=decoded.frames[1]
  if(!seed||!complete||seed.batch.key.batchId!==`bootstrap:${op}:seed`||seed.batch.key.firstSeq!==0||seed.batch.key.count!==count||complete.batch.key.batchId!==`bootstrap:${op}:complete`||complete.batch.key.firstSeq!==count||complete.batch.key.count!==1)throw TypeError('Original selected birth unavailable')
  selectedResultsPreparationFacts(data.stage,decoded.events.slice(0,count))
  if(expected.some((wanted,index)=>!same(wanted.prefix,decoded.frames[index]!.prefix)||!wanted.bytes.equals(Buffer.from(decoded.frames[index]!.batch.bytes))))outcome={kind:'conflict'}
  else {
   await assertNotDeleted('session',id);check(id,owner,scope)
   await verifyUnchanged(handle,raw,()=>check(id,owner,scope));check(id,owner,scope)
   const stage=await lookupSelectedBootstrapStage(path,{kind:'route',route:data.route},stageIO(ledger,path,()=>check(id,owner,scope)));check(id,owner,scope)
   if(stage.kind!=='full'||!same(stage.stage,data.stage))throw TypeError('Original selected stage unavailable')
   await verifyPath(handle,path,raw.length,()=>check(id,owner,scope));check(id,owner,scope)
   captureIO.assertNoCleanupDebt(ledger)
   await handle.sync();check(id,owner,scope)
   outcome={kind:'committed',receipts:expected.map(({key,batch})=>({owner:{...owner.owner},key,lastSeq:key.firstSeq+key.count-1,prefixDigest:batch.prefixDigest}))}
  }
 }catch{outcome={kind:'unknown'}}
 finally{if(handle)try{await captureIO.close(ledger,resource!);check(id,owner,scope)}catch{outcome={kind:'unknown'}}}
 return outcome
}
 return {
  resolveBirth:(id:string)=>resolveSelectedBirth(filePath(id),id,assertNotDeleted),
  resolveCheckedBirth,inspectCheckedBirth,bindCheckedBirthLane,bindCapturedLane,prepareCapturedCompletion,
  readJournalPrefix(id:string,owner:HeldFactOwner,scope:SelectedLaneScope){check(id,owner,scope);return captureIO.tracked(id,owner,ledger=>readSelectedJournalPrefix(filePath(id),id,owner,scope,assertNotDeleted,ledger))},
  appendOwnedBatch(id:string,owner:import('@i-harness/session-persistence').IssuingFactOwner,scope:SelectedLaneScope,prefix:import('@i-harness/core-session').JournalPrefix,batch:import('@i-harness/core-session').EncodedFactBatch){
   check(id,owner,scope);const snapshot=captureBatch(prefix,batch)
   return captureIO.tracked(id,owner,ledger=>appendSelectedOwnedBatch(filePath(id),id,owner,scope,snapshot.prefix,{key:snapshot.key,bytes:snapshot.bytes},assertNotDeleted,ledger))
  },
  reconcileOwnedBatch(id:string,owner:HeldFactOwner,scope:SelectedLaneScope,prefix:import('@i-harness/core-session').JournalPrefix,batch:import('@i-harness/core-session').EncodedFactBatch){
   check(id,owner,scope);const snapshot=captureBatch(prefix,batch)
   return captureIO.tracked(id,owner,ledger=>reconcileSelectedOwnedBatch(filePath(id),id,owner,scope,snapshot.prefix,{key:snapshot.key,bytes:snapshot.bytes},assertNotDeleted,ledger))
  },
  confirmFrames(id:string,owner:HeldFactOwner,scope:SelectedLaneScope,input:readonly import('../../../session-persistence/src/coordinator/bootstrap-types.ts').BootstrapFrame[]){
   check(id,owner,scope)
   if(types.isProxy(input)||!Array.isArray(input)||input.length!==2||Reflect.ownKeys(input).length!==3)throw TypeError('Two original frames required')
   const frames:import('../../../session-persistence/src/coordinator/bootstrap-types.ts').BootstrapFrame[]=[]
   for(let i=0;i<2;i++){
    const entry=Object.getOwnPropertyDescriptor(input,String(i));if(!entry||!('value' in entry)||!entry.value||types.isProxy(entry.value)||Reflect.ownKeys(entry.value).length!==2)throw TypeError('Invalid frame')
    const p=Object.getOwnPropertyDescriptor(entry.value,'prefix'),b=Object.getOwnPropertyDescriptor(entry.value,'batch');if(!p||!('value' in p)||!b||!('value' in b))throw TypeError('Invalid frame')
    const snapshot=captureBatch(p.value,b.value);frames.push({prefix:snapshot.prefix,batch:{key:snapshot.key,bytes:snapshot.bytes}})
   }
   return captureIO.tracked(id,owner,ledger=>confirmSelectedFrames(filePath(id),id,owner,scope,frames,assertNotDeleted,ledger))
  }
 }
}
