import { open, readFile, stat } from 'node:fs/promises'
import { types } from 'node:util'
import { canonicalJsonData, readFactJournal, isStrictFactData, decodeFactBatch, validJournalPrefix } from '@i-harness/core-session'
import { captureSelectedResultsRoute, parseSelectedResultsHeaderStage, isHeldFactOwner, type HeldFactOwner, type SelectedResultsRoute, type SelectedResultsHeaderStageV2 } from '@i-harness/session-persistence'
import { resolveSelectedBirth } from './selected-birth.ts'
import { lookupSelectedBootstrapStage } from './selected-bootstrap-stage.ts'
import { ordinaryStageIO } from './bootstrap-stage.ts'
import { parseHeader } from '../format.ts'
import { readBootstrapFactJournal } from '@i-harness/core-session/internal/bootstrap'
import { selectedResultsPreparationFacts } from '../../../session-persistence/src/coordinator/selected-results-preparation.ts'

type ScopeData={route:SelectedResultsRoute;stage:SelectedResultsHeaderStageV2;owner:{sessionId:string;incarnation:string}}
const scopes=new WeakMap<object,ScopeData>()
const issuedBatches=new WeakMap<object,Map<string,{prefix:import('@i-harness/core-session').JournalPrefix;bytes:Buffer}>>()
export type SelectedLaneScope=Readonly<{kind:'selected-lane'}>
const same=(a:unknown,b:unknown)=>canonicalJsonData(a)===canonicalJsonData(b)
function closed(input:unknown,keys:readonly string[]) {
 if(!input||typeof input!=='object'||types.isProxy(input)||!isStrictFactData(input))return false
 const fields=Object.getOwnPropertyDescriptors(input), actual=Reflect.ownKeys(input)
 return actual.length===keys.length&&keys.every(key=>{const d=fields[key];return !!d&&'value' in d&&d.enumerable})
}
/** Internal coordinator-only mint. Call only after authenticated capture or checked birth. */
export function createSelectedLaneScope(owner:HeldFactOwner, route:SelectedResultsRoute, stage:SelectedResultsHeaderStageV2):SelectedLaneScope {
 if(!isHeldFactOwner(owner))throw new TypeError('Original owner required');owner.assertHeld()
 if(!isStrictFactData(stage))throw new TypeError('Invalid selected stage')
 const checked=parseSelectedResultsHeaderStage(Buffer.from(canonicalJsonData(stage)+'\n')), captured=captureSelectedResultsRoute(route)
 if(!same(captured.request,checked.captureReservation.request)||owner.owner.sessionId!==checked.invocation.targetSessionId)throw new TypeError('Selected lane scope mismatch')
 const token=Object.freeze({kind:'selected-lane' as const});scopes.set(token,{route:captured,stage:checked,owner:{...owner.owner}});return token
}
function captureBatch(prefixInput:import('@i-harness/core-session').JournalPrefix,batchInput:import('@i-harness/core-session').EncodedFactBatch) {
 if(!batchInput||typeof batchInput!=='object'||types.isProxy(batchInput)||Reflect.ownKeys(batchInput).length!==2)throw new TypeError('Invalid batch inputs')
 const k=Object.getOwnPropertyDescriptor(batchInput,'key'),b=Object.getOwnPropertyDescriptor(batchInput,'bytes')
 if(!k||!('value' in k)||!k.enumerable||!b||!('value' in b)||!b.enumerable||types.isProxy(b.value)||!(b.value instanceof Uint8Array)||!closed(prefixInput,['eventCount','bodyBytes','prefixDigest'])||!closed(k.value,['batchId','firstSeq','count','previousPrefixDigest','batchDigest'])||!validJournalPrefix(prefixInput))throw new TypeError('Invalid batch inputs')
 const prefix=JSON.parse(canonicalJsonData(prefixInput)) as typeof prefixInput,key=JSON.parse(canonicalJsonData(k.value)) as typeof batchInput.key,bytes=Buffer.from(b.value),batch=decodeFactBatch(bytes)
 if(!same(key,batch.key)||key.firstSeq!==prefix.eventCount||key.previousPrefixDigest!==prefix.prefixDigest)throw new TypeError('Invalid batch')
 return {prefix,key,bytes,batch}
}
function check(id:string,owner:HeldFactOwner,scope:SelectedLaneScope):ScopeData {
 if(!isHeldFactOwner(owner))throw new TypeError('Original owner required')
 const data=scopes.get(scope);if(!data||!same(data.owner,owner.owner)||id!==data.owner.sessionId)throw new TypeError('Selected lane scope mismatch')
 owner.assertHeld();return data
}
async function verifyUnchanged(handle:Awaited<ReturnType<typeof open>>,raw:Buffer,assertCurrent:()=>void) {
 const stat=await handle.stat();assertCurrent();if(stat.size!==raw.length)throw TypeError('Selected journal changed')
 const observed=Buffer.alloc(raw.length);let offset=0
 while(offset<observed.length){const result=await handle.read(observed,offset,observed.length-offset,offset);assertCurrent();if(!result.bytesRead)throw TypeError('Selected journal changed');offset+=result.bytesRead}
 if(!observed.equals(raw))throw TypeError('Selected journal changed')
}
async function verifyPath(handle:Awaited<ReturnType<typeof open>>,path:string,size:number,assertCurrent:()=>void) {
 const opened=await handle.stat();assertCurrent();const named=await stat(path);assertCurrent()
 if(opened.dev!==named.dev||opened.ino!==named.ino||opened.size!==size||named.size!==size)throw TypeError('Selected journal path changed')
}
export async function readSelectedJournalPrefix(path:string,id:string,owner:HeldFactOwner,scope:SelectedLaneScope,assertNotDeleted:(kind:string,id:string)=>Promise<void>) {
 const data=check(id,owner,scope), birth=await resolveSelectedBirth(path,id,assertNotDeleted);check(id,owner,scope)
 if(!birth||!same(birth.route,data.route)||!same(birth.stage,data.stage))throw new TypeError('Original selected birth unavailable')
 const raw=await readFile(path);check(id,owner,scope)
 const end=raw.indexOf(10),meta=parseHeader(raw.subarray(0,end).toString('utf8'))
 if(!raw.subarray(0,end+1).equals(Buffer.from(data.stage.headerBytes))||!meta.journal)throw new TypeError('Original selected header unavailable')
 const decoded=readFactJournal(raw.subarray(end+1),meta.journal,meta.formatVersion,meta)
 const birthFrames=readBootstrapFactJournal(raw.subarray(end+1),meta.journal,meta.formatVersion,meta).frames
 const seed=birthFrames[0],complete=birthFrames[1],count=data.stage.seed.seedLength,op=data.stage.invocation.operationId
 if(!seed||!complete||seed.prefix.eventCount!==0||seed.batch.key.firstSeq!==0||seed.batch.key.count!==count||seed.batch.key.batchId!==`bootstrap:${op}:seed`||complete.prefix.eventCount!==count||complete.batch.key.firstSeq!==count||complete.batch.key.count!==1||complete.batch.key.batchId!==`bootstrap:${op}:complete`)throw new TypeError('Original selected birth frames unavailable')
 selectedResultsPreparationFacts(data.stage,decoded.events.slice(0,count))
 const handle=await open(path,'r+')
 try {
  check(id,owner,scope)
  const disk=await handle.readFile();check(id,owner,scope)
  if(!disk.equals(raw))throw new TypeError('Selected journal changed')
  await assertNotDeleted('session',id);check(id,owner,scope)
  await verifyUnchanged(handle,raw,()=>check(id,owner,scope));check(id,owner,scope)
  const stage=await lookupSelectedBootstrapStage(path,{kind:'route',route:data.route},ordinaryStageIO(path,()=>check(id,owner,scope)));check(id,owner,scope)
  if(stage.kind!=='full'||!same(stage.stage,data.stage))throw new TypeError('Original selected stage unavailable')
  await verifyPath(handle,path,raw.length,()=>check(id,owner,scope));check(id,owner,scope)
  if(decoded.torn){check(id,owner,scope);await handle.truncate(end+1+decoded.prefix.bodyBytes);check(id,owner,scope)}
  await handle.sync();check(id,owner,scope)
 }finally{await handle.close()}
 check(id,owner,scope)
 return decoded.prefix
}

/** Private selected issuance. Initial frames and ordinary suffixes have distinct checks. */
export async function appendSelectedOwnedBatch(path:string,id:string,owner:import('@i-harness/session-persistence').IssuingFactOwner,scope:SelectedLaneScope,prefixInput:import('@i-harness/core-session').JournalPrefix,batchInput:import('@i-harness/core-session').EncodedFactBatch,assertNotDeleted:(kind:string,id:string)=>Promise<void>):Promise<import('@i-harness/session-persistence').BackendFactOutcome> {
 const data=check(id,owner,scope)
 const {prefix,key,bytes,batch}=captureBatch(prefixInput,batchInput)
 await assertNotDeleted('session',id);check(id,owner,scope)
 let handle:Awaited<ReturnType<typeof open>>|undefined,issued=false,synced=false
 let outcome:import('@i-harness/session-persistence').BackendFactOutcome={kind:'absent',key}
 try {
  handle=await open(path,'r+');check(id,owner,scope)
  const raw=await handle.readFile();check(id,owner,scope)
  const end=raw.indexOf(10),meta=parseHeader(raw.subarray(0,end).toString('utf8'))
  if(!meta.journal||!raw.subarray(0,end+1).equals(Buffer.from(data.stage.headerBytes)))throw new TypeError('Original selected header unavailable')
  const decoded=readBootstrapFactJournal(raw.subarray(end+1),meta.journal,meta.formatVersion,meta), frames=decoded.frames
  const seed=frames[0],complete=frames[1],count=data.stage.seed.seedLength,op=data.stage.invocation.operationId
  if(decoded.torn||!same(decoded.prefix,prefix)){outcome={kind:'conflict',key};return outcome}
  const isSeed=key.batchId===`bootstrap:${op}:seed`&&key.firstSeq===0&&key.count===count
  const isComplete=key.batchId===`bootstrap:${op}:complete`&&key.firstSeq===count&&key.count===1
  if(isSeed){if(frames.length!==0)throw new TypeError('Seed phase conflict');selectedResultsPreparationFacts(data.stage,batch.events)}
  else {
   if(!seed||seed.batch.key.batchId!==`bootstrap:${op}:seed`||seed.batch.key.firstSeq!==0||seed.batch.key.count!==count)throw new TypeError('Original selected seed unavailable')
   selectedResultsPreparationFacts(data.stage,decoded.events.slice(0,count))
   if(isComplete){if(frames.length!==1)throw new TypeError('Completion phase conflict')}
   else if(key.batchId.startsWith('bootstrap:')||!complete||complete.batch.key.batchId!==`bootstrap:${op}:complete`||complete.batch.key.firstSeq!==count||complete.batch.key.count!==1)throw new TypeError('Original selected completion unavailable')
  }
  const candidate=Buffer.concat([raw.subarray(end+1),bytes])
  readBootstrapFactJournal(candidate,meta.journal,meta.formatVersion,meta)
  if(!isSeed)readFactJournal(candidate,meta.journal,meta.formatVersion,meta)
  await assertNotDeleted('session',id);check(id,owner,scope)
  await verifyUnchanged(handle,raw,()=>check(id,owner,scope));check(id,owner,scope)
  const stage=await lookupSelectedBootstrapStage(path,{kind:'route',route:data.route},ordinaryStageIO(path,()=>check(id,owner,scope)));check(id,owner,scope)
  if(stage.kind!=='full'||!same(stage.stage,data.stage))throw new TypeError('Original selected stage unavailable')
  await verifyPath(handle,path,raw.length,()=>check(id,owner,scope));check(id,owner,scope)
  check(id,owner,scope);owner.beforeIssue();issued=true
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
 finally {if(handle){try{await handle.close()}catch{if(synced&&outcome.kind==='committed')outcome={...outcome,cleanupDiagnostic:'file-close-failed'};else if(issued)outcome={kind:'unknown',key}}try{check(id,owner,scope)}catch{if(issued)outcome={kind:'unknown',key}}}}
 return outcome
}


/** Reconcile only a batch issued by this original lane; a JSON key alone grants no repair authority. */
export async function reconcileSelectedOwnedBatch(path:string,id:string,owner:HeldFactOwner,scope:SelectedLaneScope,prefixInput:import('@i-harness/core-session').JournalPrefix,batchInput:import('@i-harness/core-session').EncodedFactBatch,assertNotDeleted:(kind:string,id:string)=>Promise<void>):Promise<import('@i-harness/session-persistence').BackendFactOutcome> {
 const data=check(id,owner,scope),{prefix,key,bytes,batch}=captureBatch(prefixInput,batchInput),issued=issuedBatches.get(scope)?.get(canonicalJsonData(key))
 if(!issued||!same(issued.prefix,prefix)||!issued.bytes.equals(bytes))throw new TypeError('Original issued batch required')
 await assertNotDeleted('session',id);check(id,owner,scope)
 let handle:Awaited<ReturnType<typeof open>>|undefined,outcome:import('@i-harness/session-persistence').BackendFactOutcome={kind:'unknown',key},synced=false
 try {
  handle=await open(path,'r+');check(id,owner,scope)
  const raw=await handle.readFile();check(id,owner,scope)
  const end=raw.indexOf(10),meta=parseHeader(raw.subarray(0,end).toString('utf8'))
  if(!meta.journal||!raw.subarray(0,end+1).equals(Buffer.from(data.stage.headerBytes)))throw TypeError('Original selected header unavailable')
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
  const stage=await lookupSelectedBootstrapStage(path,{kind:'route',route:data.route},ordinaryStageIO(path,()=>check(id,owner,scope)));check(id,owner,scope)
  if(stage.kind!=='full'||!same(stage.stage,data.stage))throw TypeError('Original selected stage unavailable')
  await verifyPath(handle,path,raw.length,()=>check(id,owner,scope));check(id,owner,scope)
  if(actual.length<bytes.length){check(id,owner,scope);await handle.truncate(position);check(id,owner,scope)}
  await handle.sync();synced=true;check(id,owner,scope)
  outcome=actual.length===bytes.length?{kind:'committed',receipt:{owner:{...owner.owner},key,lastSeq:key.firstSeq+key.count-1,prefixDigest:batch.prefixDigest}}:{kind:'absent',key}
 }catch{outcome={kind:'unknown',key}}
 finally{if(handle){try{await handle.close()}catch{if(synced&&outcome.kind==='committed')outcome={...outcome,cleanupDiagnostic:'file-close-failed'};else outcome={kind:'unknown',key}}try{check(id,owner,scope)}catch{outcome={kind:'unknown',key}}}}
 return outcome
}

/** Confirm only the two actual birth frames; this does not confer protocol readiness. */
export async function confirmSelectedFrames(path:string,id:string,owner:HeldFactOwner,scope:SelectedLaneScope,expectedInput:readonly import('../../../session-persistence/src/coordinator/bootstrap-types.ts').BootstrapFrame[],assertNotDeleted:(kind:string,id:string)=>Promise<void>):Promise<{kind:'committed';receipts:import('@i-harness/core-session').FactReceipt[]}|{kind:'unknown'|'conflict'}> {
 const data=check(id,owner,scope)
 if(types.isProxy(expectedInput)||!Array.isArray(expectedInput)||expectedInput.length!==2||Reflect.ownKeys(expectedInput).length!==3)throw TypeError('Two original frames required')
 const expected=[]
 for(let i=0;i<2;i++){
  const entry=Object.getOwnPropertyDescriptor(expectedInput,String(i));if(!entry||!('value' in entry)||!entry.value||types.isProxy(entry.value)||Reflect.ownKeys(entry.value).length!==2)throw TypeError('Invalid frame')
  const p=Object.getOwnPropertyDescriptor(entry.value,'prefix'),b=Object.getOwnPropertyDescriptor(entry.value,'batch');if(!p||!('value' in p)||!b||!('value' in b))throw TypeError('Invalid frame')
  expected.push(captureBatch(p.value,b.value))
 }
 await assertNotDeleted('session',id);check(id,owner,scope)
 let handle:Awaited<ReturnType<typeof open>>|undefined,outcome:{kind:'committed';receipts:import('@i-harness/core-session').FactReceipt[]}|{kind:'unknown'|'conflict'}={kind:'unknown'}
 try {
  handle=await open(path,'r+');check(id,owner,scope)
  const raw=await handle.readFile();check(id,owner,scope)
  const end=raw.indexOf(10),meta=parseHeader(raw.subarray(0,end).toString('utf8'))
  if(!meta.journal||!raw.subarray(0,end+1).equals(Buffer.from(data.stage.headerBytes)))throw TypeError('Original selected header unavailable')
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
   const stage=await lookupSelectedBootstrapStage(path,{kind:'route',route:data.route},ordinaryStageIO(path,()=>check(id,owner,scope)));check(id,owner,scope)
   if(stage.kind!=='full'||!same(stage.stage,data.stage))throw TypeError('Original selected stage unavailable')
   await verifyPath(handle,path,raw.length,()=>check(id,owner,scope));check(id,owner,scope)
   await handle.sync();check(id,owner,scope)
   outcome={kind:'committed',receipts:expected.map(({key,batch})=>({owner:{...owner.owner},key,lastSeq:key.firstSeq+key.count-1,prefixDigest:batch.prefixDigest}))}
  }
 }catch{outcome={kind:'unknown'}}
 finally{if(handle)try{await handle.close();check(id,owner,scope)}catch{outcome={kind:'unknown'}}}
 return outcome
}
