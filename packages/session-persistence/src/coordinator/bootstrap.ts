import { captureChildBootstrapCaptureRequest, type ChildBootstrapCaptureRequest, type ChildBootstrapCaptureInspection, type OwnedCaptureReservation, type OwnedCaptureInspection } from './child-bootstrap-intent.ts'
import { captureBootstrapRoute, captureBootstrapCaptureRoute, encodeOwnedCaptureReservation, routeForReservation, routeInvocation, validateOwnedCaptureStage, type BootstrapRoute, type BootstrapCaptureRoute } from './bootstrap-route.ts'
import { randomUUID } from 'node:crypto'
import { semanticSeedFromRecords } from '@i-harness/core-session/internal/bootstrap'
import { AsyncLocalStorage } from 'node:async_hooks'
import { types as utilTypes } from 'node:util'
import { SessionLockConflictError } from '@i-harness/fs-lock'
import { SessionBindingObservationError } from './types.ts'
import { captureBootstrapCaptureRequest } from './bootstrap-capture.ts'
import type { BootstrapCaptureRequest, BootstrapCaptureInspection } from './bootstrap-types.ts'
import type { HeldFactOwner, IssuingFactOwner } from './fact-types.ts'
import { CURRENT_FORMAT_VERSION, FactRecoveryRequiredError, encodeFactBatch, legacyPrefixDigest, EMPTY_SEMANTIC_DEPENDENCY_DIGEST, validateSemanticBootstrapHistory, type FactOutcome, type Session, type JournalPrefix, type SessionEvent, type BootstrapInvocation, type BootstrapPhase, type BootstrapResumeToken } from '@i-harness/core-session'
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
import { preparationFacts } from './bootstrap-preparation-facts.ts'
import { captureManagedReadyObservation, type ManagedReadyObservation } from './managed-document.ts'

export interface ManagedEntry {
  route?: BootstrapRoute;
  captureIO?: { claim: Awaited<ReturnType<Ownership['pinOwnership']>>; held: HeldFactOwner; issuer: IssuingFactOwner; activeIssue?: () => void; settled: boolean; released: boolean; releasing?:Promise<void> };
  document?: ReturnType<typeof createManagedDocument>; control?: BootstrapDocumentControl;
  flight?: Promise<unknown>; revoked?: boolean; revocation?: object; ready?: boolean; headerUnknown?: boolean;
  bootstrap?: { invocation: BootstrapInvocation; manifestDigest?: string; request?: BootstrapRequest; stage?: BootstrapHeaderStage; operation?: BootstrapHeaderOperation; phase: BootstrapPhase; issued: boolean; pending?: FactOutcome;
    capture?: { request: BootstrapCaptureRequest|ChildBootstrapCaptureRequest; reservation: OwnedCaptureReservation; phase: 'unreserved'|'reserving'|'reserved'|'capturing'|'captured'|'spent'; entered: boolean; ownedRequest?: BootstrapRequest } };
}
/** New-work revocation stays terminal; its identity also fences in-flight observations. */
export function markManagedEntryRevoked(entry:ManagedEntry) {
  entry.revoked=true;entry.revocation={}
  if(entry.captureIO)entry.captureIO.activeIssue=undefined
}
export function revokeManagedEntry(entry:ManagedEntry) {
  markManagedEntryRevoked(entry)
  entry.document?.revokeNewWork()
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
const stageRoute=(stage:BootstrapHeaderStage):BootstrapRoute=>stage.captureReservation?routeForReservation(stage.captureReservation):{protocol:'public',invocation:stage.invocation}
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
  if(stage.captureReservation)validateOwnedCaptureStage(stage.captureReservation,stage,state.events!.slice(0,stage.seed.seedLength) as BootstrapRequest['seed']['records'])
  const meta=state.meta!,original=JSON.parse(stage.headerBytes)
  if (meta.formatVersion !== original.formatVersion && !([11,12].includes(original.formatVersion) && meta.formatVersion > original.formatVersion && meta.formatVersion <= CURRENT_FORMAT_VERSION && readyState(state))) throw new Error('Bootstrap storage format conflict')
  for(const key of ['sessionId','createdAt','journal','parentSession','seedLength','origin','delegationDepth','subagentProtocolVersion','semanticSeed'])if(!sameBootstrapData((meta as any)[key],original[key]))throw new Error('Bootstrap birth conflict')
  if(bootstrapManifest(stage,state.events!.slice(0,stage.seed.seedLength) as BootstrapRequest['seed']['records'])!==manifest(stage))throw new Error('Bootstrap manifest conflict')
  const first=state.events![0]
  if(stage.seed.seedLength&&first?.type==='conversation/seed-manifest') {
    if(stage.seed.sourceObservation.kind!=='semantic')throw new Error('Bootstrap source binding conflict')
    const seed=semanticSeedFromRecords(meta.semanticSeed!,state.events!.slice(0,stage.seed.seedLength))
    const compiled=compileSemanticSeed({kind:'seed',seed,digest:stage.seed.digest,sourceObservationDigest:stage.seed.sourceObservation.digest})
    if(compiled.dependencyDigest!==stage.seed.dependencyDigest)throw new Error('Bootstrap dependency binding conflict')
  } else if(stage.seed.sourceObservation.kind!=='none')throw new Error('Bootstrap empty source binding conflict')
}
export function createBootstrapOwner(backend:PersistenceBackend,ownership:Ownership,documents:Map<string,ManagedEntry>,attach:(id:string,entry:ManagedEntry,session:Session,prefix:JournalPrefix)=>ReturnType<typeof createManagedDocument>,mutations:Mutations) {
  const supported=()=>ownership.lockEnabled&&!!backend.prepareBootstrapHeader&&!!backend.reconcileBootstrapHeader&&!!backend.readBootstrapState&&!!backend.confirmBootstrapFrames&&!!backend.appendOwnedBatch&&!!backend.reconcileOwnedBatch
  const captureSupported=()=>supported()&&(process.platform==='win32'||process.platform==='linux')&&!!backend.checkBootstrapCaptureRoot&&!!backend.readBootstrapCapture&&!!backend.prepareBootstrapCapture&&!!backend.settleBootstrapCaptureIO
  const childSupported=()=>captureSupported()&&!!backend.bootstrapRoutes&&['readState','readCapture','reserveCapture','resolveBirth'].every(key=>typeof (backend.bootstrapRoutes as any)[key]==='function')
  const callbackScope=new AsyncLocalStorage<{id:string;active:boolean}>()
  let captureClosed=false
  function assertOutsideCapture(id?:string) { const scope=callbackScope.getStore();if(scope?.active&&(id===undefined||scope.id===id))throw new SessionBindingObservationError('conflict') }
  function captureSelfConflict(input:unknown,wrapped=false) {
    const scope=callbackScope.getStore();if(!scope?.active)return false
    if(!input||typeof input!=='object'||utilTypes.isProxy(input))return false
    const invocation=wrapped?Object.getOwnPropertyDescriptor(input,'invocation')?.value:input
    if(!invocation||typeof invocation!=='object'||utilTypes.isProxy(invocation))return false
    return Object.getOwnPropertyDescriptor(invocation,'targetSessionId')?.value===scope.id
  }
  async function captureBundle(entry:ManagedEntry) {
    if(entry.captureIO)return entry.captureIO
    const id=entry.bootstrap!.invocation.targetSessionId,claim=await ownership.pinOwnership(id)
    const held=heldFactOwner({sessionId:id,incarnation:randomUUID()},ownership,()=>claim.assertHeld())
    const bundle:NonNullable<ManagedEntry['captureIO']>={claim,held,issuer:undefined!,settled:true,released:false}
    bundle.issuer=issuingFactOwner(held,()=>{if(!bundle.activeIssue)throw Object.assign(new Error('FACT_CANCELLED'),{code:'FACT_CANCELLED'});bundle.activeIssue()})
    entry.captureIO=bundle;return bundle
  }
  async function settleCapture(entry:ManagedEntry) {
    const io=entry.captureIO
    if(io&&!io.settled){await backend.settleBootstrapCaptureIO!(entry.bootstrap!.invocation.targetSessionId,io.held);io.settled=true}
  }
  type InspectionResource={request:BootstrapCaptureRequest|ChildBootstrapCaptureRequest;done:Promise<OwnedCaptureInspection>;claim?:Awaited<ReturnType<Ownership['pinOwnership']>>;held?:HeldFactOwner;ioStarted:boolean;ioSettled:boolean;released:boolean}
  const inspections=new Set<InspectionResource>()
  async function cleanupInspection(item:InspectionResource) {
    if(item.held&&item.ioStarted&&!item.ioSettled){await backend.settleBootstrapCaptureIO!(item.request.invocation.targetSessionId,item.held);item.ioSettled=true}
    if(item.claim&&!item.released){await item.claim.release();item.released=true}
    inspections.delete(item)
  }
  function inspectCapture(route:BootstrapCaptureRoute):Promise<OwnedCaptureInspection> {
    const request=captureBootstrapCaptureRoute(route).request
    if(captureClosed)return Promise.resolve({kind:'unavailable'})
    const item:InspectionResource={request,done:undefined!,ioStarted:false,ioSettled:false,released:false}
    inspections.add(item)
    item.done=Promise.resolve().then(async()=>{
      let result:OwnedCaptureInspection={kind:'unavailable'},failure:unknown,failed=false
      try {
        await backend.checkBootstrapCaptureRoot!()
        if(captureClosed)throw new Error('Capture inspection closed')
        item.claim=await ownership.pinOwnership(request.invocation.targetSessionId)
        item.held=heldFactOwner({sessionId:request.invocation.targetSessionId,incarnation:randomUUID()},ownership,()=>item.claim!.assertHeld())
        if(captureClosed)throw new Error('Capture inspection closed')
        item.ioStarted=true
        result=await ownership.withSessionOperation(request.invocation.targetSessionId,()=>route.protocol==='child-v1'?backend.bootstrapRoutes!.readCapture(request.invocation.targetSessionId,item.held!,route):backend.readBootstrapCapture!(request.invocation.targetSessionId,item.held!,request as BootstrapCaptureRequest))
        if(captureClosed)result={kind:'unavailable'}
        const local=documents.get(request.invocation.targetSessionId)
        if(result.kind==='absent'&&(local?.bootstrap?.issued||local?.captureIO&&!local.captureIO.settled))result={kind:'unavailable'}
      }catch(error){failed=true;failure=error;result={kind:error instanceof SessionLockConflictError?'conflict':'unavailable'}}
      try{await cleanupInspection(item)}catch(error){throw new AggregateError([...(failed?[failure]:[]),error],'Capture inspection cleanup unresolved',{cause:{invocation:request.invocation,inspection:result}})}
      return captureClosed?{kind:'unavailable'}:result
    })
    return item.done
  }
  function closeCaptureAdmission() {
    assertOutsideCapture();captureClosed=true
    for(const entry of documents.values()){if(entry.captureIO)entry.captureIO.activeIssue=undefined;if(entry.bootstrap?.capture)revokeManagedEntry(entry)}
    const original=[...inspections]
    return async()=>{
      const results=await Promise.allSettled(original.map(async item=>{await item.done.catch(()=>{});if(inspections.has(item))await cleanupInspection(item)}))
      const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[])
      if(errors.length)throw new AggregateError(errors,'Capture inspection cleanup unresolved')
    }
  }
  async function releaseCapture(entry:ManagedEntry) {
    await settleCapture(entry)
    const io=entry.captureIO
    if(!io||io.released)return
    if(io.releasing)return io.releasing
    const flight=io.claim.release().then(()=>{io.released=true}).finally(()=>{if(io.releasing===flight)io.releasing=undefined})
    io.releasing=flight
    await flight
  }
  const read=(invocation:BootstrapInvocation,route:BootstrapRoute={protocol:'public',invocation})=>typeof backend.bootstrapRoutes?.readState==='function'?backend.bootstrapRoutes.readState(route):route.protocol==='public'?backend.readBootstrapState!(invocation):Promise.resolve<BootstrapReadState>({kind:'unavailable'})
  async function prepareTarget(stage: BootstrapHeaderStage, guards: BootstrapGuards, reconcile: boolean, entry: ManagedEntry, events: readonly SessionEvent[]): Promise<boolean> {
    if (!guards.targetPreparation) return true
    if (!reconcile) current(guards, entry)
    try {
      const request = captureBootstrapTargetPreparationRequest({ invocation: stage.invocation, manifestDigest: manifest(stage) })
      const facts = preparationFacts(stage, events)
      const outcome = captureBootstrapTargetPreparationOutcome(reconcile
        ? await guards.targetPreparation.reconcile(request, facts)
        : await guards.targetPreparation.confirm(request, () => { try { current(guards, entry); return true } catch { return false } }, facts))
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
  async function adopt(entry:ManagedEntry,state:BootstrapReadState,guards:BootstrapGuards,cached?:ManagedReadyObservation,observation={revocation:entry.revocation}):Promise<BootstrapOutcome> {
    const b=entry.bootstrap!,stage=b.stage!
    cached?.assertCurrent()
    if(state.torn)return blocked(entry)
    checkBirth(stage,state)
    if (!await prepareTarget(stage, guards, true, entry, state.events!)) return blocked(entry, 'dependency-unavailable')
    cached?.assertCurrent()
    const closure=await dependencies(stage,state.events!,guards,true,entry)
    cached?.assertCurrent()
    const completion=state.events![stage.seed.seedLength]
    if(!closure||completion?.type!=='session/bootstrap'||completion.dependencyClosureDigest!==closure)return blocked(entry,'dependency-unavailable')
    const doc=entry.document??attach(b.invocation.targetSessionId,entry,buildSession(state.meta,state.events!),state.prefix!)
    const frames=framesFor(stage,state.events!)
    const held=cached?.held??entry.control!.held
    const confirmed=await ownership.withSessionOperation(b.invocation.targetSessionId,()=>backend.confirmBootstrapFrames!(b.invocation.targetSessionId,held,frames))
    cached?.assertCurrent()
    if(!isStrictFactData(confirmed)||confirmed.kind!=='committed'||!Array.isArray(confirmed.receipts)||confirmed.receipts.length!==frames.length)return blocked(entry)
    // These are confirmations of original issued frames, not new appends.
    // Apply the same key/incarnation/last-seq/prefix checks as the normal pump.
    const receipts=[]
    for(const [index,frame] of frames.entries()) {
      const checked=ownBackendOutcome({kind:'committed',receipt:confirmed.receipts[index]},frame.batch.key,held.owner,true)
      if(checked.kind!=='committed')return blocked(entry)
      receipts.push(checked.receipt)
    }
    targetCurrent(guards)
    // Confirm the original birth frames before changing only the writable header.
    if ([11,12].includes(state.meta!.formatVersion) && state.meta!.formatVersion < CURRENT_FORMAT_VERSION) await ownership.withSessionOperation(b.invocation.targetSessionId, async () => {
      if (!backend.upgradeSessionFormat) throw new Error('Bootstrap writer cannot upgrade current storage')
      const upgraded = await backend.upgradeSessionFormat(b.invocation.targetSessionId, state.meta!.formatVersion, CURRENT_FORMAT_VERSION)
      if (upgraded.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error('Bootstrap storage upgrade incomplete')
    })
    cached?.assertCurrent()
    targetCurrent(guards)
    if(entry.revocation!==observation.revocation)return blocked(entry)
    if(cached)cached.assertCurrent();else entry.control!.ready()
    entry.ready=true;b.phase='completion';entry.headerUnknown=false
    return {kind:'already-ready',document:doc,receipt:{version:1,invocation:b.invocation,manifestDigest:manifest(stage),seedLength:stage.seed.seedLength,dependencyClosureDigest:closure,
      ...(stage.seed.seedLength?{seed:receipts[0]}:{}),completion:receipts.at(-1)!,...(stage.initial?{initial:{inputId:stage.initial.inputId,seq:stage.seed.seedLength+1,startedAt:stage.initial.startedAt,expiresAt:stage.initial.expiresAt}}:{})}}
  }
  function resumeCachedReady(entry:ManagedEntry,invocation:BootstrapInvocation,guards:BootstrapGuards,route:BootstrapRoute,payload?:BootstrapRequest):Promise<BootstrapOutcome> {
    if(!entry.document)return Promise.resolve({kind:'refused',reason:'cached-unprepared'})
    let cached:ManagedReadyObservation
    try{cached=captureManagedReadyObservation(entry.document,ownership)}catch{return Promise.resolve({kind:'refused',reason:'cached-unprepared'})}
    const previous=entry.flight
    const candidate:ManagedEntry={route,document:entry.document,ready:true,bootstrap:{invocation,phase:'completion',issued:true}}
    const assertCurrent=()=>{if(documents.get(invocation.targetSessionId)!==entry||entry.revoked)throw new FactRecoveryRequiredError();cached.assertCurrent()}
    const flight=Promise.resolve().then(async():Promise<BootstrapOutcome>=>{
      try{
        await previous;assertCurrent()
        const state=await read(invocation,route);assertCurrent()
        // Cached observation changes no original namespace/publication fence.
        // In particular, usable READY bytes cannot erase a foreign sibling or
        // an unfinished/conflicting original existing-empty publication.
        if(state.foreign)return{kind:'refused',reason:'conflict'}
        if(state.captureReservation){
          if(!sameBootstrapData(routeForReservation(state.captureReservation),route))return{kind:'refused',reason:'conflict'}
          if(!sameBootstrapData(state.captureReservation.request.invocation,invocation))return{kind:'refused',reason:'conflict'}
          return blocked(candidate,'payload-required')
        }
        if(state.meta?.semanticSeed&&(state.meta.sessionId!==invocation.targetSessionId||state.meta.createdAt!==invocation.createdAt
          ||state.meta.semanticSeed.operationId!==invocation.operationId||state.meta.semanticSeed.requestDigest!==invocation.requestDigest))return{kind:'refused',reason:'conflict'}
        let stage:BootstrapHeaderStage|undefined
        if(state.stageBytes){try{stage=parseBootstrapHeaderStage(state.stageBytes)}catch{return{kind:'refused',reason:'cached-unprepared'}}}
        if(stage&&!sameBootstrapData(stage.invocation,invocation))return{kind:'refused',reason:'conflict'}
        if(stage&&!sameBootstrapData(stageRoute(stage),route))return{kind:'refused',reason:'conflict'}
        if(stage&&payload){try{buildBootstrapHeader(payload,stage)}catch{return{kind:'refused',reason:'conflict'}}}
        if(stage){candidate.bootstrap!.stage=stage;candidate.bootstrap!.manifestDigest=manifest(stage)}
        const publication=publicationStatus(state,stage)
        if(publication==='conflict')return{kind:'refused',reason:'conflict'}
        if(publication==='unknown')return blocked(candidate,stage?'unknown':'payload-required')
        if(state.kind==='unavailable')return blocked(candidate)
        if(!state.meta?.semanticSeed||!stage||!state.events||!state.prefix||!readyState(state))return{kind:'refused',reason:'cached-unprepared'}
        if(state.meta.sessionId!==invocation.targetSessionId||state.meta.createdAt!==invocation.createdAt)return{kind:'refused',reason:'conflict'}
        if(!sameBootstrapData(cached.prefix,state.prefix)||cached.view.formatVersion!==state.meta.formatVersion
          ||['semanticSeed','seedLength','parentSession','origin','delegationDepth','subagentProtocolVersion'].some(key=>!sameBootstrapData((cached.view.header as any)?.[key],(state.meta as any)[key])))return{kind:'refused',reason:'wrong-view'}
        checkBirth(stage,state);assertCurrent()
        return await adopt(candidate,state,guards,cached)
      }catch(error){
        const code=(error as {code?:string}|null|undefined)?.code
        if(code==='FACT_TARGET_UNAVAILABLE')return blocked(candidate,'dependency-unavailable')
        if(error instanceof FactRecoveryRequiredError)return{kind:'refused',reason:'wrong-view'}
        return blocked(candidate)
      }
    }).finally(()=>{if(entry.flight===flight)entry.flight=undefined})
    entry.flight=flight;return flight
  }
  async function run(entry:ManagedEntry,guards:BootstrapGuards,observation={revocation:entry.revocation}):Promise<BootstrapOutcome> {
    const b=entry.bootstrap!,id=b.invocation.targetSessionId
    let held=entry.captureIO?.held??heldFactOwner({sessionId:id,incarnation:randomUUID()},ownership,()=>{})
    if(entry.captureIO)entry.captureIO.activeIssue=()=>{current(guards,entry);b.issued=true;entry.headerUnknown=true;entry.captureIO!.settled=false}
    try {
      await settleCapture(entry)
      await ownership.withSessionOperation(id,async()=>{mutations.assertWritableBootstrap(id);await ownership.ensureOwnership(id)})
      if(b.pending&&entry.document) {
        const pending=b.pending,key='key' in pending?pending.key:'receipt' in pending?pending.receipt.key:undefined
        if(key){const outcome=await entry.document.reconcile(key);b.pending=outcome;if(outcome.kind==='committed'||outcome.kind==='absent')b.pending=undefined;else return blocked(entry)}
      }
      let state=await read(b.invocation,entry.route)
      if(state.foreign)return {kind:'refused',reason:'conflict'}
      if(entry.route?.protocol==='child-v1'&&(state.kind==='unavailable'||state.kind==='absent'))return blocked(entry)
      if(state.stagePresent||state.promotionPresent){b.issued=true;if(!state.captureReservation&&!state.stageBytes)entry.headerUnknown=true}
      if(state.captureReservation) {
        if(!sameBootstrapData(routeForReservation(state.captureReservation),entry.route))return {kind:'refused',reason:'conflict'}
        b.issued=true
        if(!sameBootstrapData(state.captureReservation.request.invocation,b.invocation))return {kind:'refused',reason:'conflict'}
        if(!b.capture)b.capture={request:state.captureReservation.request,reservation:state.captureReservation,phase:'spent',entered:true}
        if(!sameBootstrapData(b.capture.reservation,state.captureReservation))return {kind:'refused',reason:'conflict'}
        if(!b.capture.ownedRequest) {
          if(b.request&&state.captureReservation.kind==='semantic-bootstrap-capture'&&(!sameBootstrapData(b.request.metadata,state.captureReservation.request.core.metadata)||b.request.lineage.origin!=='fork'||b.request.lineage.parentSession!==state.captureReservation.request.core.sourceSessionId))return {kind:'refused',reason:'conflict'}
          b.request=undefined;entry.headerUnknown=false;return blocked(entry,'payload-required')
        }
        b.request=b.capture.ownedRequest
      }
      if(state.publicationPresent){b.issued=true;entry.headerUnknown=true}
      if(state.meta?.semanticSeed&&(state.meta.sessionId!==id||state.meta.createdAt!==b.invocation.createdAt||state.meta.semanticSeed.operationId!==b.invocation.operationId||state.meta.semanticSeed.requestDigest!==b.invocation.requestDigest))return {kind:'refused',reason:'conflict'}
      if(state.meta?.semanticSeed){b.manifestDigest=state.meta.semanticSeed.manifestDigest;b.issued=true}
      if(state.meta&&!state.meta.semanticSeed&&state.events?.length)return {kind:'refused',reason:'nonempty'}
      if(state.stageBytes) {
        b.issued=true
        try {b.stage=parseBootstrapHeaderStage(state.stageBytes);if(!sameBootstrapData(b.stage.invocation,b.invocation)||!sameBootstrapData(stageRoute(b.stage),entry.route))return {kind:'refused',reason:'conflict'}}catch {entry.headerUnknown=true}
      }
      if(b.stage?.captureReservation&&captureSupported()&&!entry.captureIO) {
        const io=await captureBundle(entry);held=io.held
        io.activeIssue=()=>{current(guards,entry);b.issued=true;entry.headerUnknown=true;io.settled=false}
      }
      if(b.issued&&!state.meta?.semanticSeed&&!state.captureReservation)entry.headerUnknown=true
      if(b.stage&&b.request) {
        try {const built=buildBootstrapHeader(b.request,b.stage);b.operation=built.operation}catch{b.request=b.capture?.ownedRequest;return {kind:'refused',reason:'conflict'}}
      }
      const publication=publicationStatus(state,b.stage)
      if(publication==='conflict')return {kind:'refused',reason:'conflict'}
      if(publication==='unknown'&&(b.stage||!b.request||!state.stageBytes))return blocked(entry,b.stage?'unknown':'payload-required')
      if(b.stage&&readyState(state))return await adopt(entry,state,guards,undefined,observation)
      if(!b.stage&&readyState(state))return blocked(entry,'payload-required')
      if(!b.request)return blocked(entry,'payload-required')
      if(!b.stage) {
        if(b.request.target.kind==='resume')return blocked(entry,'payload-required')
        if(b.request.target.kind==='existing-empty'&&!state.rawHeader)return blocked(entry,'payload-required')
        const built=buildBootstrapHeader(b.request,undefined,b.request.target.kind==='existing-empty'?JSON.parse(state.rawHeader!):undefined,b.capture?.ownedRequest?b.capture.reservation:undefined)
        b.stage=built.stage;b.operation=built.operation
      }
      if(publicationStatus(state,b.stage)!=='valid')return blocked(entry)
      b.phase='header'
      if(entry.captureIO)entry.captureIO.settled=false
      let outcome=await ownership.withSessionOperation(id,()=>backend.reconcileBootstrapHeader!(id,held,b.operation!))
      await settleCapture(entry)
      if(outcome.kind!=='committed') {
        if(outcome.kind==='conflict')return {kind:'refused',reason:'conflict'}
        current(guards,entry)
        outcome=await ownership.withSessionOperation(id,async()=>{
          if(mutations.pendingWriteBehind(id)?.hasWork)return {kind:'conflict' as const}
          const issuing=entry.captureIO?.issuer??issuingFactOwner(held,()=>{current(guards,entry);b.issued=true;entry.headerUnknown=true})
          return backend.prepareBootstrapHeader!(id,issuing,b.operation!)
        })
      }
      if(outcome.kind!=='committed') {
        if(outcome.kind==='conflict')return {kind:'refused',reason:'conflict'}
        if(!b.issued&&outcome.kind==='not-issued')return {kind:'not-issued',reason:outcome.reason}
        return blocked(entry)
      }
      entry.headerUnknown=false
      state=await read(b.invocation,entry.route)
      if(!state.meta||!state.events||!state.prefix)return blocked(entry)
      const doc=entry.document??attach(id,entry,buildSession(state.meta,state.events),state.prefix)
      b.phase='dependencies'
      if (!await prepareTarget(b.stage, guards, false, entry, b.request.seed.records)) return blocked(entry, 'dependency-unavailable')
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
        state=await read(b.invocation,entry.route)
      }
      const adopted=await adopt(entry,state,guards,undefined,observation)
      return adopted.kind==='already-ready'?{...adopted,kind:'ready'}:adopted
    } catch(error) {
      const code=(error as {code?:string}).code
      if(code==='FACT_TARGET_UNAVAILABLE')return blocked(entry,'dependency-unavailable')
      if(code==='FACT_PRECONDITION_STALE'||code==='FACT_CANCELLED')return b.issued?blocked(entry,code==='FACT_PRECONDITION_STALE'?'source-changed':'unknown'):{kind:'not-issued',reason:code==='FACT_CANCELLED'?'cancelled':'stale-source'}
      return b.issued?blocked(entry):{kind:'refused',reason:'manifest-invalid'}
    } finally { if(entry.captureIO){entry.captureIO.activeIssue=undefined;await settleCapture(entry)} }
  }
  function start(invocation:BootstrapInvocation,guards:BootstrapGuards,request?:BootstrapRequest,route:BootstrapRoute={protocol:'public',invocation}):Promise<BootstrapOutcome> {
    if(!supported())return Promise.resolve({kind:'not-issued',reason:'unsupported'})
    let captured:BootstrapInvocation,r:BootstrapRequest|undefined
    try{captured=captureBootstrapInvocation(invocation);route=captureBootstrapRoute(route);r=request?captureBootstrapRequest(request):undefined;if(!sameBootstrapData(routeInvocation(route),captured)||r&&!sameBootstrapData(r.invocation,captured))throw new Error('invocation mismatch');
      const port=Object.getOwnPropertyDescriptor(guards,'targetPreparation')
      if(port ? !('value' in port) || !port.enumerable : 'targetPreparation' in guards)throw new TypeError('Invalid target preparation')
      const targetPreparation=port?.value===undefined?undefined:captureBootstrapTargetPreparationPort(port.value)
      // Capture absence too, without ever consulting the caller's optional
      // field again. Forward the other guards with their original receiver.
      const originalGuards=guards
      guards={get signal(){return originalGuards.signal},assertCurrent(){originalGuards.assertCurrent()},get dependencies(){return originalGuards.dependencies},targetPreparation}
    }catch{return Promise.resolve({kind:'refused',reason:'manifest-invalid'})}
    const first=r?.seed.records[0]
    if(first?.type==='conversation/seed-manifest'&&first.artifacts.length&&first.origins[0]?.kind!=='session')return Promise.resolve({kind:'refused',reason:'target-policy'})
    const id=captured.targetSessionId
    if(callbackScope.getStore()?.active&&callbackScope.getStore()?.id===id)return Promise.resolve({kind:'refused',reason:'conflict'})
    if(mutations.pendingWriteBehind(id)?.hasWork)return Promise.resolve({kind:'refused',reason:'cached-unprepared'})
    let entry=documents.get(id)
    if(entry&&!entry.route&&!entry.bootstrap&&entry.document&&route.protocol==='public'&&typeof backend.bootstrapRoutes?.resolveBirth!=='function')return r?Promise.resolve({kind:'refused',reason:'cached-unprepared'}):resumeCachedReady(entry,captured,guards,route)
    if(entry&&(!entry.route||!sameBootstrapData(entry.route,route)))return Promise.resolve({kind:'refused',reason:entry.route?'conflict':'cached-unprepared'})
    if(entry&&!entry.bootstrap)return r&&route.protocol==='public'?Promise.resolve({kind:'refused',reason:'cached-unprepared'}):resumeCachedReady(entry,captured,guards,route,r)
    if(entry) {
      if(!sameBootstrapData(entry.bootstrap!.invocation,captured))return Promise.resolve({kind:'refused',reason:'conflict'})
      if(r&&entry.bootstrap!.request) {
        const previous=entry.bootstrap!.request
        const compared=r.target.kind==='resume'?{...r,target:previous.target}:r
        if(!sameBootstrapData(compared,previous)||r.target.kind==='resume'&&entry.bootstrap!.stage&&r.target.manifestDigest!==manifest(entry.bootstrap!.stage))return Promise.resolve({kind:'refused',reason:'conflict'})
      }
      if(r&&entry.bootstrap!.capture&&!entry.bootstrap!.capture.ownedRequest&&!entry.bootstrap!.stage)return Promise.resolve(entry.bootstrap!.capture.phase==='capturing'||entry.bootstrap!.capture.phase==='reserving'?{kind:'refused',reason:'conflict'}:blocked(entry,'payload-required'))
      if(entry.flight)return entry.flight as Promise<BootstrapOutcome>
      entry.bootstrap!.request??=r
    }else{entry={route,bootstrap:{invocation:captured,request:r,phase:'header',issued:false}};documents.set(id,entry)}
    const owned=entry
    const flight=run(owned,guards).finally(()=>{if(owned.flight===flight)owned.flight=undefined;if(!owned.bootstrap!.issued&&!owned.document&&documents.get(id)===owned)documents.delete(id)})
    owned.flight=flight;return flight
  }
  function captureTarget(input:BootstrapCaptureRoute,guards:BootstrapGuards,capture:()=>Promise<BootstrapRequest>):Promise<BootstrapOutcome> {
      if(!captureSupported())return Promise.resolve({kind:'not-issued',reason:'unsupported'})
      let request:BootstrapCaptureRequest|ChildBootstrapCaptureRequest, route:BootstrapCaptureRoute
      try{route=captureBootstrapCaptureRoute(input);request=route.request;if(typeof capture!=='function'||utilTypes.isProxy(capture)||utilTypes.isProxy(guards))throw new TypeError('Invalid capture callback')}catch{return Promise.resolve({kind:'refused',reason:'manifest-invalid'})}
      const birthRoute=captureBootstrapRoute(route.protocol==='public'?{protocol:'public',invocation:request.invocation}:{protocol:'child-v1',request:route.request})
      const id=request.invocation.targetSessionId
      if(callbackScope.getStore()?.active&&callbackScope.getStore()?.id===id)return Promise.resolve({kind:'refused',reason:'conflict'})
      if(captureClosed)return Promise.resolve({kind:'not-issued',reason:'cancelled'})
      let entry=documents.get(id)
      if(entry&&(!entry.route||!sameBootstrapData(entry.route,birthRoute)))return Promise.resolve({kind:'refused',reason:entry.route?'conflict':'cached-unprepared'})
      if(entry&&!entry.bootstrap)return route.protocol==='child-v1'?resumeCachedReady(entry,request.invocation,guards,birthRoute):Promise.resolve({kind:'refused',reason:'cached-unprepared'})
      if(entry) {
        if(!sameBootstrapData(entry.bootstrap!.invocation,request.invocation)||entry.bootstrap!.capture&&!sameBootstrapData(entry.bootstrap!.capture.request,request))return Promise.resolve({kind:'refused',reason:'conflict'})
        if(entry.flight)return entry.flight as Promise<BootstrapOutcome>
      }else{entry={route:birthRoute,bootstrap:{invocation:request.invocation,phase:'header',issued:false}};documents.set(id,entry)}
      const owned=entry,b=owned.bootstrap!
      const observation={revocation:owned.revocation}
      b.capture??={request,reservation:route.protocol==='public'?{version:1,kind:'semantic-bootstrap-capture',request:route.request}:{version:1,kind:'semantic-bootstrap-child-capture',request:route.request},phase:'unreserved',entered:false}
      const flight=Promise.resolve().then(async():Promise<BootstrapOutcome>=>{
        let originalFailure:unknown,originalFailed=false,callbackFailed=false
        try {
          await settleCapture(owned)
          await backend.checkBootstrapCaptureRoot!();current(guards,owned)
          const io=await captureBundle(owned);current(guards,owned)
          io.settled=false
          const inspected=await ownership.withSessionOperation(id,()=>route.protocol==='child-v1'?backend.bootstrapRoutes!.readCapture(id,io.held,route):backend.readBootstrapCapture!(id,io.held,request as BootstrapCaptureRequest))
          await settleCapture(owned)
          if(inspected.kind==='materialized')return await run(owned,guards,observation)
          if(inspected.kind==='conflict')return {kind:'refused',reason:'conflict'}
          if(b.capture!.ownedRequest){if(inspected.kind==='absent')return blocked(owned);return await run(owned,guards,observation)}
          if(inspected.kind!=='absent'||b.capture!.phase!=='unreserved'||b.issued){if(inspected.kind==='reserved'){b.issued=true;b.capture!.phase='spent'}return blocked(owned,inspected.kind==='reserved'?'payload-required':'unknown')}
          current(guards,owned);b.capture!.phase='reserving'
          io.activeIssue=()=>{current(guards,owned);mutations.assertWritableBootstrap(id);b.issued=true;io.settled=false}
          io.settled=false
          const result=await ownership.withSessionOperation(id,()=>route.protocol==='child-v1'?backend.bootstrapRoutes!.reserveCapture(id,io.issuer,route,encodeOwnedCaptureReservation(b.capture!.reservation)):backend.prepareBootstrapCapture!(id,io.issuer,encodeOwnedCaptureReservation(b.capture!.reservation)))
          io.activeIssue=undefined;await settleCapture(owned)
          if(result.kind!=='committed-new') {
            if(!b.issued&&result.kind==='not-issued'){b.capture!.phase='unreserved';return result}
            if(result.kind==='present')b.issued=true
            if(!b.issued)b.capture!.phase='unreserved'
            return result.kind==='conflict'?{kind:'refused',reason:'conflict'}:blocked(owned,result.kind==='present'?'payload-required':'unknown')
          }
          b.issued=true;b.capture!.phase='reserved';current(guards,owned);io.claim.assertHeld()
          b.capture!.entered=true;b.capture!.phase='capturing'
          const scope={id,active:true}
          let returned:BootstrapRequest
          try{returned=await callbackScope.run(scope,capture)}catch(error){callbackFailed=true;throw error}finally{scope.active=false;b.capture!.phase='spent'}
          current(guards,owned);io.claim.assertHeld()
          let r:BootstrapRequest
          try{r=captureBootstrapRequest(returned);buildBootstrapHeader(r,undefined,undefined,b.capture!.reservation)}catch{return {kind:'refused',reason:'manifest-invalid'}}
          b.capture!.ownedRequest=r;b.request=r;b.capture!.phase='captured'
          return await run(owned,guards,observation)
        } catch(error) {
          originalFailed=true;originalFailure=error
          // A local callback fault is not an owner guard outcome, even when
          // its value carries a guard code or is null/undefined/falsy.
          if(callbackFailed)throw error
          const code=(error as {code?:string}|null|undefined)?.code
          if(code==='FACT_CANCELLED'||code==='FACT_PRECONDITION_STALE')return b.issued?blocked(owned,code==='FACT_PRECONDITION_STALE'?'source-changed':'unknown'):{kind:'not-issued',reason:code==='FACT_CANCELLED'?'cancelled':'stale-source'}
          throw error
        } finally {
          if(owned.captureIO)owned.captureIO.activeIssue=undefined
          if(b.capture?.entered&&owned.captureIO)owned.captureIO.settled=false
          try{await settleCapture(owned)}catch(cleanup){throw new AggregateError([...(originalFailed?[originalFailure]:[]),cleanup],'Capture cleanup unresolved',{cause:{invocation:request.invocation}})}
        }
      }).finally(async()=>{if(owned.flight===flight)owned.flight=undefined;if(!b.issued&&!owned.document&&documents.get(id)===owned&&(!owned.captureIO||owned.captureIO.settled)){await releaseCapture(owned);documents.delete(id)}})
      owned.flight=flight;return flight
    }
  return {
    captureSupported, childSupported, assertOutsideCapture, captureSelfConflict, closeCaptureAdmission, settleCapture, releaseCapture,
    inspectBootstrapCapture:(input:BootstrapCaptureRequest)=>inspectCapture({protocol:'public',request:captureBootstrapCaptureRequest(input)}) as Promise<BootstrapCaptureInspection>,
    inspectChildBootstrapCapture:(input:ChildBootstrapCaptureRequest)=>inspectCapture({protocol:'child-v1',request:captureChildBootstrapCaptureRequest(input)}) as Promise<ChildBootstrapCaptureInspection>,
    bootstrapSemanticTargetWithCapture:(input:BootstrapCaptureRequest,guards:BootstrapGuards,capture:()=>Promise<BootstrapRequest>)=>captureTarget({protocol:'public',request:input},guards,capture),
    bootstrapChildTargetWithCapture:(input:ChildBootstrapCaptureRequest,guards:BootstrapGuards,capture:()=>Promise<BootstrapRequest>)=>captureTarget({protocol:'child-v1',request:input},guards,capture),
    resumeChildTarget:(input:ChildBootstrapCaptureRequest,guards:BootstrapGuards,payload?:BootstrapRequest)=>{let request:ChildBootstrapCaptureRequest;try{request=captureChildBootstrapCaptureRequest(input)}catch{return Promise.resolve<BootstrapOutcome>({kind:'refused',reason:'manifest-invalid'})}return start(request.invocation,guards,payload,{protocol:'child-v1',request})},
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
        if(stage&&stageRoute(stage).protocol!=='public')return {kind:'conflict',invocation:captured,needsConfirmation:true}
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
