import { randomUUID } from 'node:crypto'
import { encodeFactBatch, legacyPrefixDigest, EMPTY_SEMANTIC_DEPENDENCY_DIGEST, validateSemanticBootstrapHistory, type FactOutcome, type Session, type JournalPrefix, type SessionEvent, type BootstrapInvocation, type BootstrapPhase, type BootstrapResumeToken } from '@i-harness/core-session'
import { buildSession } from '../format/validation.ts'
import { bootstrapManifest, buildBootstrapHeader, captureBootstrapInvocation, captureBootstrapRequest, parseBootstrapHeaderStage, sameBootstrapData } from './bootstrap-header.ts'
import type { BootstrapDocumentControl, BootstrapFrame, BootstrapGuards, BootstrapHeaderOperation, BootstrapHeaderStage, BootstrapInspection, BootstrapOutcome, BootstrapReadState, BootstrapRequest } from './bootstrap-types.ts'
import type { createManagedDocument } from './managed-document.ts'
import type { PersistenceBackend } from './types.ts'
import type { Ownership } from './ownership.ts'
import type { Mutations } from './mutations.ts'
import { heldFactOwner, issuingFactOwner } from './fact-owner.ts'
import { compileSemanticSeed } from '../semantic-seed.ts'
import { isStrictFactData } from '@i-harness/core-session'
import { ownBackendOutcome } from './fact-outcome.ts'
import { captureBootstrapTargetPreparationOutcome, captureBootstrapTargetPreparationPort, captureBootstrapTargetPreparationRequest } from './bootstrap-preparation.ts'

export interface ManagedEntry {
  document?: ReturnType<typeof createManagedDocument>; control?: BootstrapDocumentControl;
  flight?: Promise<unknown>; revoked?: boolean; ready?: boolean; headerUnknown?: boolean;
  bootstrap?: { invocation: BootstrapInvocation; manifestDigest?: string; request?: BootstrapRequest; stage?: BootstrapHeaderStage; operation?: BootstrapHeaderOperation; phase: BootstrapPhase; issued: boolean; pending?: FactOutcome };
}
const emptyPrefix=():JournalPrefix=>({eventCount:0,bodyBytes:0,prefixDigest:legacyPrefixDigest(0,new Uint8Array())})
function current(guards:BootstrapGuards,entry?:ManagedEntry) {
  if(guards.signal?.aborted||entry?.revoked)throw Object.assign(new Error('FACT_CANCELLED'),{code:'FACT_CANCELLED'})
  try{guards.assertCurrent()}catch(error){throw Object.assign(new Error('FACT_PRECONDITION_STALE'),{code:'FACT_PRECONDITION_STALE',cause:error})}
}
function targetCurrent(guards: BootstrapGuards) {
  try { guards.targetPreparation?.assertTargetCurrent() }
  catch (cause) { throw Object.assign(new Error('Bootstrap target unavailable'), { code: 'FACT_TARGET_UNAVAILABLE', cause }) }
}
function knownToken(entry:ManagedEntry):BootstrapResumeToken {
  const b=entry.bootstrap!,digest=b.stage?JSON.parse(b.stage.headerBytes).semanticSeed.manifestDigest:b.manifestDigest
  return digest ? {version:1,invocation:b.invocation,phase:b.phase,manifestDigest:digest} : {version:1,invocation:b.invocation,phase:'header',manifest:'unknown'}
}
const blocked=(entry:ManagedEntry,reason:'unknown'|'payload-required'|'dependency-unavailable'|'source-changed'='unknown'):BootstrapOutcome=>({kind:'blocked',token:knownToken(entry),reason})
function manifest(stage:BootstrapHeaderStage){return (JSON.parse(stage.headerBytes) as import('./types.ts').SessionMeta).semanticSeed!.manifestDigest}
function readyState(state:BootstrapReadState):boolean {
  if(!state.meta?.semanticSeed||!state.events)return false
  try{validateSemanticBootstrapHistory(state.events,state.meta.formatVersion,state.meta);return true}catch{return false}
}
function publicationStatus(state:BootstrapReadState,stage?:BootstrapHeaderStage):'valid'|'unknown'|'conflict' {
  if(!state.publicationPresent)return 'valid'
  if(!stage)return 'unknown'
  if(stage.originalTarget.kind==='new')return 'conflict'
  const bytes=state.publicationBytes,expected=Buffer.from(stage.headerBytes)
  if(!bytes)return 'unknown'
  if(bytes.length>expected.length||!Buffer.from(bytes).equals(expected.subarray(0,bytes.length)))return 'conflict'
  return readyState(state)&&bytes.length!==expected.length?'unknown':'valid'
}
function framesFor(stage:BootstrapHeaderStage,events:readonly SessionEvent[]):BootstrapFrame[] {
  let prefix=emptyPrefix();const frames:BootstrapFrame[]=[]
  const add=(name:string,items:readonly SessionEvent[])=>{const batch=encodeFactBatch(`bootstrap:${stage.invocation.operationId}:${name}`,prefix.prefixDigest,items);frames.push({prefix,batch});const decoded=JSON.parse(Buffer.from(batch.bytes).toString('utf8'));prefix={eventCount:prefix.eventCount+batch.key.count,bodyBytes:prefix.bodyBytes+batch.bytes.length,prefixDigest:decoded.prefixDigest}}
  if(stage.seed.seedLength)add('seed',events.slice(0,stage.seed.seedLength))
  add('complete',events.slice(stage.seed.seedLength,stage.seed.seedLength+1+(stage.initial?1:0)))
  return frames
}
function checkBirth(stage:BootstrapHeaderStage,state:BootstrapReadState) {
  const meta=state.meta!,original=JSON.parse(stage.headerBytes)
  for(const key of ['formatVersion','sessionId','createdAt','journal','parentSession','seedLength','origin','delegationDepth','subagentProtocolVersion','semanticSeed'])if(!sameBootstrapData((meta as any)[key],original[key]))throw new Error('Bootstrap birth conflict')
  if(bootstrapManifest(stage,state.events!.slice(0,stage.seed.seedLength) as BootstrapRequest['seed']['records'])!==manifest(stage))throw new Error('Bootstrap manifest conflict')
  const first=state.events![0]
  if(stage.seed.seedLength&&first?.type==='conversation/seed-manifest') {
    if(stage.seed.sourceObservation.kind!=='semantic')throw new Error('Bootstrap source binding conflict')
    const seed={version:1 as const,origins:first.origins,selection:first.selection,turns:first.turns,omissions:first.omissions,artifacts:first.artifacts,
      groups:state.events!.slice(1,stage.seed.seedLength).map(e=>{if(e.type!=='conversation/seed-group')throw new Error('Bootstrap group conflict');return e.group})}
    const compiled=compileSemanticSeed({kind:'seed',seed,digest:stage.seed.digest,sourceObservationDigest:stage.seed.sourceObservation.digest})
    if(compiled.dependencyDigest!==stage.seed.dependencyDigest)throw new Error('Bootstrap dependency binding conflict')
  } else if(stage.seed.sourceObservation.kind!=='none')throw new Error('Bootstrap empty source binding conflict')
}
export function createBootstrapOwner(backend:PersistenceBackend,ownership:Ownership,documents:Map<string,ManagedEntry>,attach:(id:string,entry:ManagedEntry,session:Session,prefix:JournalPrefix)=>ReturnType<typeof createManagedDocument>,mutations:Mutations) {
  const supported=()=>ownership.lockEnabled&&!!backend.prepareBootstrapHeader&&!!backend.reconcileBootstrapHeader&&!!backend.readBootstrapState&&!!backend.confirmBootstrapFrames&&!!backend.appendOwnedBatch&&!!backend.reconcileOwnedBatch
  const read=(invocation:BootstrapInvocation)=>backend.readBootstrapState!(invocation)
  async function prepareTarget(stage: BootstrapHeaderStage, guards: BootstrapGuards, reconcile: boolean, entry: ManagedEntry): Promise<boolean> {
    if (!guards.targetPreparation) return true
    if (!reconcile) current(guards, entry)
    try {
      const request = captureBootstrapTargetPreparationRequest({ invocation: stage.invocation, manifestDigest: manifest(stage) })
      const outcome = captureBootstrapTargetPreparationOutcome(reconcile
        ? await guards.targetPreparation.reconcile(request)
        : await guards.targetPreparation.confirm(request, () => { try { current(guards, entry); return true } catch { return false } }))
      if (outcome.kind !== 'confirmed') return false
      targetCurrent(guards)
    } catch { return false }
    if (!reconcile) current(guards, entry)
    return true
  }
  async function dependencies(stage:BootstrapHeaderStage,events:readonly SessionEvent[],guards:BootstrapGuards,reconcile:boolean,entry:ManagedEntry):Promise<string|undefined> {
    const first=events[0],artifacts=first?.type==='conversation/seed-manifest'?first.artifacts:entry.bootstrap?.request?.seed.records[0]?.type==='conversation/seed-manifest'?entry.bootstrap.request.seed.records[0].artifacts:[]
    if(!artifacts.length)return EMPTY_SEMANTIC_DEPENDENCY_DIGEST
    const origin=first?.type==='conversation/seed-manifest'?first.origins[0]:entry.bootstrap!.request!.seed.records[0]?.type==='conversation/seed-manifest'?entry.bootstrap!.request!.seed.records[0].origins[0]:undefined
    if(origin?.kind!=='session')return
    const request={operationId:stage.invocation.operationId,targetSessionId:stage.invocation.targetSessionId,manifestDigest:manifest(stage),sourceSessionId:origin.sessionId,artifacts}
    if(!reconcile)current(guards,entry)
    targetCurrent(guards)
    const outcome=reconcile?await guards.dependencies.reconcile(request):await guards.dependencies.confirm(request,()=>{try{current(guards,entry);return true}catch{return false}})
    targetCurrent(guards)
    if(!outcome||typeof outcome!=='object'||!importOutcome(outcome))return
    if(!reconcile)current(guards,entry)
    return outcome.kind==='confirmed'?outcome.closureDigest:undefined
  }
  async function adopt(entry:ManagedEntry,state:BootstrapReadState,guards:BootstrapGuards):Promise<BootstrapOutcome> {
    const b=entry.bootstrap!,stage=b.stage!
    if(state.torn)return blocked(entry)
    checkBirth(stage,state)
    if (!await prepareTarget(stage, guards, true, entry)) return blocked(entry, 'dependency-unavailable')
    const closure=await dependencies(stage,state.events!,guards,true,entry)
    const completion=state.events![stage.seed.seedLength]
    if(!closure||completion?.type!=='session/bootstrap'||completion.dependencyClosureDigest!==closure)return blocked(entry,'dependency-unavailable')
    const doc=entry.document??attach(b.invocation.targetSessionId,entry,buildSession(state.meta,state.events!),state.prefix!)
    const frames=framesFor(stage,state.events!)
    const confirmed=await ownership.withSessionOperation(b.invocation.targetSessionId,()=>backend.confirmBootstrapFrames!(b.invocation.targetSessionId,entry.control!.held,frames))
    if(!isStrictFactData(confirmed)||confirmed.kind!=='committed'||!Array.isArray(confirmed.receipts)||confirmed.receipts.length!==frames.length)return blocked(entry)
    // These are confirmations of original issued frames, not new appends.
    // Apply the same key/incarnation/last-seq/prefix checks as the normal pump.
    const receipts=[]
    for(const [index,frame] of frames.entries()) {
      const checked=ownBackendOutcome({kind:'committed',receipt:confirmed.receipts[index]},frame.batch.key,entry.control!.held.owner,true)
      if(checked.kind!=='committed')return blocked(entry)
      receipts.push(checked.receipt)
    }
    targetCurrent(guards)
    entry.control!.ready();entry.ready=true;b.phase='completion';entry.headerUnknown=false
    return {kind:'already-ready',document:doc,receipt:{version:1,invocation:b.invocation,manifestDigest:manifest(stage),seedLength:stage.seed.seedLength,dependencyClosureDigest:closure,
      ...(stage.seed.seedLength?{seed:receipts[0]}:{}),completion:receipts.at(-1)!,...(stage.initial?{initial:{inputId:stage.initial.inputId,seq:stage.seed.seedLength+1,startedAt:stage.initial.startedAt,expiresAt:stage.initial.expiresAt}}:{})}}
  }
  async function run(entry:ManagedEntry,guards:BootstrapGuards):Promise<BootstrapOutcome> {
    const b=entry.bootstrap!,id=b.invocation.targetSessionId
    const held=heldFactOwner({sessionId:id,incarnation:randomUUID()},ownership,()=>{})
    try {
      await ownership.withSessionOperation(id,async()=>{mutations.assertWritableBootstrap(id);await ownership.ensureOwnership(id)})
      if(b.pending&&entry.document) {
        const pending=b.pending,key='key' in pending?pending.key:'receipt' in pending?pending.receipt.key:undefined
        if(key){const outcome=await entry.document.reconcile(key);b.pending=outcome;if(outcome.kind==='committed'||outcome.kind==='absent')b.pending=undefined;else return blocked(entry)}
      }
      let state=await read(b.invocation)
      if(state.foreign)return {kind:'refused',reason:'conflict'}
      if(state.publicationPresent){b.issued=true;entry.headerUnknown=true}
      if(state.meta?.semanticSeed&&(state.meta.sessionId!==id||state.meta.createdAt!==b.invocation.createdAt||state.meta.semanticSeed.operationId!==b.invocation.operationId||state.meta.semanticSeed.requestDigest!==b.invocation.requestDigest))return {kind:'refused',reason:'conflict'}
      if(state.meta?.semanticSeed){b.manifestDigest=state.meta.semanticSeed.manifestDigest;b.issued=true}
      if(state.meta&&!state.meta.semanticSeed&&state.events?.length)return {kind:'refused',reason:'nonempty'}
      if(state.stageBytes) {
        b.issued=true
        try {b.stage=parseBootstrapHeaderStage(state.stageBytes);if(!sameBootstrapData(b.stage.invocation,b.invocation))return {kind:'refused',reason:'conflict'}}catch {entry.headerUnknown=true}
      }
      if(b.issued&&!state.meta?.semanticSeed)entry.headerUnknown=true
      if(b.stage&&b.request) {
        try {const built=buildBootstrapHeader(b.request,b.stage);b.operation=built.operation}catch{return {kind:'refused',reason:'conflict'}}
      }
      const publication=publicationStatus(state,b.stage)
      if(publication==='conflict')return {kind:'refused',reason:'conflict'}
      if(publication==='unknown'&&(b.stage||!b.request||!state.stageBytes))return blocked(entry,b.stage?'unknown':'payload-required')
      if(b.stage&&readyState(state))return await adopt(entry,state,guards)
      if(!b.stage&&readyState(state))return blocked(entry,'payload-required')
      if(!b.request)return blocked(entry,'payload-required')
      if(!b.stage) {
        if(b.request.target.kind==='resume')return blocked(entry,'payload-required')
        if(b.request.target.kind==='existing-empty'&&!state.rawHeader)return blocked(entry,'payload-required')
        const built=buildBootstrapHeader(b.request,undefined,b.request.target.kind==='existing-empty'?JSON.parse(state.rawHeader!):undefined)
        b.stage=built.stage;b.operation=built.operation
      }
      if(publicationStatus(state,b.stage)!=='valid')return blocked(entry)
      b.phase='header'
      let outcome=await ownership.withSessionOperation(id,()=>backend.reconcileBootstrapHeader!(id,held,b.operation!))
      if(outcome.kind!=='committed') {
        if(outcome.kind==='conflict')return {kind:'refused',reason:'conflict'}
        current(guards,entry)
        outcome=await ownership.withSessionOperation(id,async()=>{
          if(mutations.pendingWriteBehind(id)?.hasWork)return {kind:'conflict' as const}
          const issuing=issuingFactOwner(held,()=>{current(guards,entry);b.issued=true;entry.headerUnknown=true})
          return backend.prepareBootstrapHeader!(id,issuing,b.operation!)
        })
      }
      if(outcome.kind!=='committed') {
        if(outcome.kind==='conflict')return {kind:'refused',reason:'conflict'}
        if(!b.issued&&outcome.kind==='not-issued')return {kind:'not-issued',reason:outcome.reason}
        return blocked(entry)
      }
      entry.headerUnknown=false
      state=await read(b.invocation)
      if(!state.meta||!state.events||!state.prefix)return blocked(entry)
      const doc=entry.document??attach(id,entry,buildSession(state.meta,state.events),state.prefix)
      b.phase='dependencies'
      if (!await prepareTarget(b.stage, guards, false, entry)) return blocked(entry, 'dependency-unavailable')
      const closure=await dependencies(b.stage,state.events,guards,false,entry)
      if(!closure)return blocked(entry,'dependency-unavailable')
      current(guards,entry)
      const phases:{phase:'seed'|'completion';events:SessionEvent[]}[]=[]
      if(b.stage.seed.seedLength)phases.push({phase:'seed',events:[...b.request.seed.records]})
      const initial=buildBootstrapHeader(b.request,b.stage).initial
      const complete:SessionEvent={type:'session/bootstrap',version:1,seq:b.stage.seed.seedLength,operationId:b.invocation.operationId,manifestDigest:manifest(b.stage),dependencyClosureDigest:closure,seedLength:b.stage.seed.seedLength,
        ...(b.stage.initial?{initialInputId:b.stage.initial.inputId,initialStartedAt:b.stage.initial.startedAt,initialExpiresAt:b.stage.initial.expiresAt}:{})}
      phases.push({phase:'completion',events:[complete,...(initial?[{...initial,seq:b.stage.seed.seedLength+1}]:[])]})
      for(const phase of phases) {
        b.phase=phase.phase
        if(doc.view.events.length>=phase.events[0]!.seq!+phase.events.length)continue
        const prefix:JournalPrefix=phase.phase==='seed'?emptyPrefix():state.prefix!
        const batch=encodeFactBatch(`bootstrap:${b.invocation.operationId}:${phase.phase==='seed'?'seed':'complete'}`,prefix.prefixDigest,phase.events)
        const reconciled=await ownership.withSessionOperation(id,()=>backend.reconcileOwnedBatch!(id,entry.control!.held,prefix,batch))
        if(reconciled.kind==='unknown'||reconciled.kind==='conflict')return blocked(entry)
        if(reconciled.kind==='committed') {
          // Cold fully written phases are already installed by the private load.
          return blocked(entry)
        }
        current(guards,entry)
        targetCurrent(guards)
        const result=await entry.control!.admit(phase.phase,phase.events,{...guards,assertCurrent(){
          current(guards,entry)
          // Reuse the admission owner's precondition failure, without turning
          // a target policy change into a permanent source document fault.
          try { targetCurrent(guards) } catch (cause) { throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE', cause }) }
        }})
        if(result.kind!=='committed'){
          b.pending=result.kind==='unknown'||result.kind==='conflict'||result.kind==='recovery-required'?result:undefined
          targetCurrent(guards)
          return blocked(entry,result.kind==='not-issued'&&result.code==='FACT_PRECONDITION_STALE'?'source-changed':'unknown')
        }
        targetCurrent(guards)
        state=await read(b.invocation)
      }
      const adopted=await adopt(entry,state,guards)
      return adopted.kind==='already-ready'?{...adopted,kind:'ready'}:adopted
    } catch(error) {
      const code=(error as {code?:string}).code
      if(code==='FACT_TARGET_UNAVAILABLE')return blocked(entry,'dependency-unavailable')
      if(code==='FACT_PRECONDITION_STALE'||code==='FACT_CANCELLED')return b.issued?blocked(entry,code==='FACT_PRECONDITION_STALE'?'source-changed':'unknown'):{kind:'not-issued',reason:code==='FACT_CANCELLED'?'cancelled':'stale-source'}
      return b.issued?blocked(entry):{kind:'refused',reason:'manifest-invalid'}
    }
  }
  function start(invocation:BootstrapInvocation,guards:BootstrapGuards,request?:BootstrapRequest):Promise<BootstrapOutcome> {
    if(!supported())return Promise.resolve({kind:'not-issued',reason:'unsupported'})
    let captured:BootstrapInvocation,r:BootstrapRequest|undefined
    try{captured=captureBootstrapInvocation(invocation);r=request?captureBootstrapRequest(request):undefined;if(r&&!sameBootstrapData(r.invocation,captured))throw new Error('invocation mismatch');
      const port=Object.getOwnPropertyDescriptor(guards,'targetPreparation')
      if(port) { if(!('value' in port) || !port.enumerable)throw new TypeError('Invalid target preparation'); guards={...guards,targetPreparation:captureBootstrapTargetPreparationPort(port.value)} }
    }catch{return Promise.resolve({kind:'refused',reason:'manifest-invalid'})}
    const first=r?.seed.records[0]
    if(first?.type==='conversation/seed-manifest'&&first.artifacts.length&&first.origins[0]?.kind!=='session')return Promise.resolve({kind:'refused',reason:'target-policy'})
    const id=captured.targetSessionId
    if(mutations.pendingWriteBehind(id)?.hasWork)return Promise.resolve({kind:'refused',reason:'cached-unprepared'})
    let entry=documents.get(id)
    if(entry&&!entry.bootstrap)return Promise.resolve({kind:'refused',reason:'cached-unprepared'})
    if(entry) {
      if(!sameBootstrapData(entry.bootstrap!.invocation,captured))return Promise.resolve({kind:'refused',reason:'conflict'})
      if(r&&entry.bootstrap!.request) {
        const previous=entry.bootstrap!.request
        const compared=r.target.kind==='resume'?{...r,target:previous.target}:r
        if(!sameBootstrapData(compared,previous)||r.target.kind==='resume'&&entry.bootstrap!.stage&&r.target.manifestDigest!==manifest(entry.bootstrap!.stage))return Promise.resolve({kind:'refused',reason:'conflict'})
      }
      if(entry.flight)return entry.flight as Promise<BootstrapOutcome>
      entry.bootstrap!.request??=r
    }else{entry={bootstrap:{invocation:captured,request:r,phase:'header',issued:false}};documents.set(id,entry)}
    const owned=entry
    const flight=run(owned,guards).finally(()=>{if(owned.flight===flight)owned.flight=undefined;if(!owned.bootstrap!.issued&&!owned.document&&documents.get(id)===owned)documents.delete(id)})
    owned.flight=flight;return flight
  }
  return {
    bootstrapSemanticTarget:(request:BootstrapRequest,guards:BootstrapGuards)=>{
      const field=request&&Object.getOwnPropertyDescriptor(request,'invocation')
      if(!field||!('value'in field))return Promise.resolve<BootstrapOutcome>({kind:'refused',reason:'manifest-invalid'})
      return start(field.value,guards,request)
    },
    resumeSemanticTarget:(invocation:BootstrapInvocation,guards:BootstrapGuards,original?:BootstrapRequest)=>start(invocation,guards,original),
    async inspectBootstrap(invocation:BootstrapInvocation):Promise<BootstrapInspection> {
      const captured=captureBootstrapInvocation(invocation)
      if(!backend.readBootstrapState)return {kind:'unavailable',invocation:captured,needsConfirmation:true}
      try {
        const state=await read(captured)
        if(state.kind==='absent')return {kind:'absent',invocation:captured,needsConfirmation:false}
        if(state.foreign)return {kind:'conflict',invocation:captured,needsConfirmation:true}
        let stage:BootstrapHeaderStage|undefined
        if(state.stageBytes)try{stage=parseBootstrapHeaderStage(state.stageBytes)}catch{}
        const publication=publicationStatus(state,stage)
        if(publication==='conflict')return {kind:'conflict',invocation:captured,needsConfirmation:true}
        if(stage&&!sameBootstrapData(stage.invocation,captured)||state.meta?.semanticSeed&&(state.meta.semanticSeed.operationId!==captured.operationId||state.meta.semanticSeed.requestDigest!==captured.requestDigest)||state.meta&&state.meta.createdAt!==captured.createdAt)return {kind:'conflict',invocation:captured,needsConfirmation:true}
        const digest=stage?manifest(stage):state.meta?.semanticSeed?.manifestDigest
        const token:BootstrapResumeToken=digest?{version:1,invocation:captured,manifestDigest:digest,phase:readyState(state)?'completion':'header'}:{version:1,invocation:captured,phase:'header',manifest:'unknown'}
        return {kind:stage&&publication==='valid'?(readyState(state)&&!state.torn?'ready':'reserved'):'unavailable',invocation:captured,token,needsConfirmation:true}
      }catch{return {kind:'unavailable',invocation:captured,needsConfirmation:true}}
    },
  }
}
function importOutcome(value:unknown):value is import('./bootstrap-types.ts').BootstrapDependencyOutcome {
  if(!value||typeof value!=='object'||!isStrictFactData(value))return false
  const descriptors=Object.getOwnPropertyDescriptors(value)
  if(Reflect.ownKeys(value).some(k=>typeof k!=='string')||Object.values(descriptors).some(d=>!('value'in d)||!d.enumerable))return false
  const row=value as Record<string,unknown>
  return row.kind==='confirmed'?Object.keys(row).length===2&&typeof row.closureDigest==='string'&&/^[a-f0-9]{64}$/.test(row.closureDigest):row.kind==='blocked'&&Object.keys(row).length===2&&['unknown','unavailable','conflict','policy'].includes(row.reason as string)
}
