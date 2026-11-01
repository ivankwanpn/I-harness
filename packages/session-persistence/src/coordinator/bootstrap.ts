import { createArtifactCurrentGuard } from './artifact-path-association.ts'
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
import { CURRENT_FORMAT_VERSION, FactRecoveryRequiredError, encodeFactBatch, decodeFactBatch, legacyPrefixDigest, EMPTY_SEMANTIC_DEPENDENCY_DIGEST, validateSemanticBootstrapHistory, type FactOutcome, type Session, type JournalPrefix, type SessionEvent, type BootstrapInvocation, type BootstrapPhase, type BootstrapResumeToken } from '@i-harness/core-session'
import { buildSession } from '../format/validation.ts'
import { bootstrapManifest, buildBootstrapHeader, captureBootstrapInvocation, captureBootstrapRequest, parseBootstrapHeaderStage, sameBootstrapData } from './bootstrap-header.ts'
import type { BootstrapDocumentControl, BootstrapFrame, BootstrapGuards, BootstrapHeaderOperation, BootstrapHeaderStage, BootstrapInspection, BootstrapOutcome, BootstrapReadState, BootstrapRequest, HeaderOutcome } from './bootstrap-types.ts'
import type { createManagedDocument } from './managed-document.ts'
import type { PersistenceBackend, SessionMeta } from './types.ts'
import type { Ownership } from './ownership.ts'
import type { Mutations } from './mutations.ts'
import { heldFactOwner, issuingFactOwner } from './fact-owner.ts'
import { compileSemanticSeed } from '../semantic-seed.ts'
import { isStrictFactData,canonicalJsonData } from '@i-harness/core-session'
import { ownBackendOutcome } from './fact-outcome.ts'
import { captureBootstrapTargetPreparationOutcome, captureBootstrapTargetPreparationPort, captureBootstrapTargetPreparationRequest } from './bootstrap-preparation.ts'
import { preparationFacts } from './bootstrap-preparation-facts.ts'
import { captureManagedReadyObservation, type ManagedReadyObservation } from './managed-document.ts'
import type { createProcessReadLatches } from './process-read-latches.ts'
import { assertOriginalProcessMutation } from './process-read-latches.ts'
import type { createTaskDocumentTransitions } from './task-document-transition.ts'
import { captureSelectedResultsRoute, type SelectedResultsRoute } from './selected-results-route.ts'
import { selectedResultsPreparationFacts } from './selected-results-preparation.ts'
import { createSelectedCaptureAttempt } from './selected-capture-attempt.ts'
import { createColdSelectedInspection, type ColdSelectedTarget, type ColdSelectedObservation } from './cold-selected-target.ts'

export interface ManagedEntry {
  coldFinalization?:import('./cold-finalization-types.ts').ColdFinalization;
  revokeColdFinalization?:()=>void;
  metadataRevision?: object;
  coldSelected?: ReturnType<typeof createColdSelectedInspection>;
  selected?: {cold?:true;route:SelectedResultsRoute;identity:object;taskBarrier?:ReturnType<ReturnType<typeof createTaskDocumentTransitions>['bootstrap']>;attempt?:ReturnType<typeof createSelectedCaptureAttempt>;lane?:Readonly<{kind:'selected-lane'}>;frames?:BootstrapFrame[];receipts?:import('@i-harness/core-session').FactReceipt[];resultReceipt?:import('../selected-results-fork-contract.ts').ForkReceiptSummaryV2;pending?:number;closure?:string;capture?:()=>Promise<unknown>;issued:boolean;headerAttempted?:boolean;headerIssued?:boolean;header?:HeaderOutcome;processToken?:ReturnType<ReturnType<typeof createProcessReadLatches>['beginMutation']>};
  route?: BootstrapRoute;
  captureIO?: { claim: Awaited<ReturnType<Ownership['pinOwnership']>>; held: HeldFactOwner; issuer: IssuingFactOwner; activeIssue?: () => void; settled: boolean; released: boolean; releasing?:Promise<void> };
  document?: ReturnType<typeof createManagedDocument>; control?: BootstrapDocumentControl; cachedTaskBarrier?: ReturnType<ReturnType<typeof createTaskDocumentTransitions>['bootstrap']>;
  flight?: Promise<unknown>; revoked?: boolean; revocation?: object; ready?: boolean; headerUnknown?: boolean;
  bootstrap?: { invocation: BootstrapInvocation; manifestDigest?: string; request?: BootstrapRequest; stage?: BootstrapHeaderStage; operation?: BootstrapHeaderOperation; phase: BootstrapPhase; issued: boolean; pending?: FactOutcome; taskBarrier?: ReturnType<ReturnType<typeof createTaskDocumentTransitions>['bootstrap']>; headerOutcome?: import('./bootstrap-types.ts').HeaderOutcome;
    capture?: { request: BootstrapCaptureRequest|ChildBootstrapCaptureRequest; reservation: OwnedCaptureReservation; phase: 'unreserved'|'reserving'|'reserved'|'capturing'|'captured'|'spent'; entered: boolean; ownedRequest?: BootstrapRequest } };
}
/** New-work revocation stays terminal; its identity also fences in-flight observations. */
export function markManagedEntryRevoked(entry:ManagedEntry) {
  entry.revokeColdFinalization?.()
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
  if (meta.formatVersion !== original.formatVersion && !([11,12].includes(original.formatVersion) && meta.formatVersion > original.formatVersion && meta.formatVersion <= CURRENT_FORMAT_VERSION && readyState(state)) && !(original.formatVersion===13 && meta.formatVersion===14 && readyState(state))) throw new Error('Bootstrap storage format conflict')
  for(const key of ['sessionId','createdAt','journal','parentSession','seedLength','origin','delegationDepth','subagentProtocolVersion','semanticSeed'])if(!sameBootstrapData((meta as any)[key],original[key]))throw new Error('Bootstrap birth conflict')
  if(bootstrapManifest(stage,state.events!.slice(0,stage.seed.seedLength) as BootstrapRequest['seed']['records'])!==manifest(stage))throw new Error('Bootstrap manifest conflict')
  const first=state.events![0]
  if(stage.seed.seedLength&&first?.type==='conversation/seed-manifest') {
    if(stage.seed.sourceObservation.kind!=='semantic')throw new Error('Bootstrap source binding conflict')
    const seed=semanticSeedFromRecords(meta.semanticSeed!,state.events!.slice(0,stage.seed.seedLength))
    if(seed.version!==1&&seed.version!==2)throw new TypeError('Legacy bootstrap birth required')
    const compiled=compileSemanticSeed({kind:'seed',seed,digest:stage.seed.digest,sourceObservationDigest:stage.seed.sourceObservation.digest})
    if(compiled.dependencyDigest!==stage.seed.dependencyDigest)throw new Error('Bootstrap dependency binding conflict')
  } else if(stage.seed.sourceObservation.kind!=='none')throw new Error('Bootstrap empty source binding conflict')
}
const originalBootstrapEntries = new WeakMap<object, { id: string; documents: Map<string, ManagedEntry> }>()
export function assertOriginalBootstrapEntry(entry: object, id: string): void {
  const record = originalBootstrapEntries.get(entry)
  if (!record || record.id !== id || record.documents.get(id) !== entry) throw new TypeError('Invalid original bootstrap entry')
}
export function createBootstrapOwner(backend:PersistenceBackend,ownership:Ownership,documents:Map<string,ManagedEntry>,attach:(id:string,entry:ManagedEntry,session:Session,prefix:JournalPrefix)=>ReturnType<typeof createManagedDocument>,mutations:Mutations,processLatches?:ReturnType<typeof createProcessReadLatches>,transitions?:ReturnType<typeof createTaskDocumentTransitions>,activateSelected?:(id:string,entry:ManagedEntry)=>void,prepareActivateSelected?:(id:string,entry:ManagedEntry)=>()=>void) {
  const supported=()=>ownership.lockEnabled&&!!backend.prepareBootstrapHeader&&!!backend.reconcileBootstrapHeader&&!!backend.readBootstrapState&&!!backend.confirmBootstrapFrames&&!!backend.appendOwnedBatch&&!!backend.reconcileOwnedBatch
  const captureSupported=()=>supported()&&(process.platform==='win32'||process.platform==='linux')&&!!backend.checkBootstrapCaptureRoot&&!!backend.readBootstrapCapture&&!!backend.prepareBootstrapCapture&&!!backend.settleBootstrapCaptureIO
  const childSupported=()=>captureSupported()&&!!backend.bootstrapRoutes&&['readState','readCapture','reserveCapture','resolveBirth'].every(key=>typeof (backend.bootstrapRoutes as any)[key]==='function')
  const callbackScope=new AsyncLocalStorage<{id:string;active:boolean}>()
  const bootstrapWitnesses = new Map<string, { token: ReturnType<NonNullable<typeof processLatches>['beginMutation']>; active: number; retained: boolean; ready: boolean; unknown: boolean }>()
  function trackBootstrap(invocation: BootstrapInvocation, run: () => Promise<BootstrapOutcome>): Promise<BootstrapOutcome> {
    if (!processLatches) return run()
    const key = JSON.stringify([invocation.version, invocation.targetSessionId, invocation.operationId, invocation.createdAt, invocation.requestDigest])
    let witness = bootstrapWitnesses.get(key)
    if (!witness) { witness = { token: processLatches.beginMutation({ sessionIds: [invocation.targetSessionId], documentKeys: [], kind: 'other' }), active: 0, retained: false, ready: false, unknown: false }; bootstrapWitnesses.set(key, witness) }
    const owned = witness; owned.active++
    const ownsIssuedWork = () => {
      const original = documents.get(invocation.targetSessionId)?.bootstrap
      return !!original?.issued && sameBootstrapData(original.invocation, invocation)
    }
    let result: Promise<BootstrapOutcome>
    try { result = run() } catch (error) { result = Promise.reject(error) }
    return result.then(outcome => {
      if (outcome.kind === 'ready' || outcome.kind === 'already-ready') owned.ready = true
      else if (ownsIssuedWork()) { owned.retained = true; owned.ready = false }
      return outcome
    }, error => { if (ownsIssuedWork()) owned.retained = true; else owned.unknown = true; owned.ready = false; throw error }).finally(() => {
      owned.active--
      if (!owned.active && (owned.ready || !owned.retained)) { owned.token.end(owned.unknown ? 'unknown' : 'settled'); bootstrapWitnesses.delete(key) }
    })
  }
  let captureClosed=false
  const coldTargets = new WeakMap<object, ReturnType<typeof createColdSelectedInspection>>()
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
    const id=(entry.bootstrap?.invocation??entry.selected!.route.request.invocation).targetSessionId, existing=entry.bootstrap?.taskBarrier
    const claim=existing ? existing.transferClaim() : await ownership.pinOwnership(id)
    const held=existing ? existing.held() : heldFactOwner({sessionId:id,incarnation:randomUUID()},ownership,createArtifactCurrentGuard(()=>claim.assertHeld()))
    const bundle:NonNullable<ManagedEntry['captureIO']>={claim,held,issuer:undefined!,settled:true,released:false}
    bundle.issuer=issuingFactOwner(held,()=>{if(!bundle.activeIssue)throw Object.assign(new Error('FACT_CANCELLED'),{code:'FACT_CANCELLED'});bundle.activeIssue()})
    entry.captureIO=bundle;return bundle
  }
  async function settleCapture(entry:ManagedEntry) {
    const io=entry.captureIO
    if(io&&!io.settled){await backend.settleBootstrapCaptureIO!((entry.bootstrap?.invocation??entry.selected!.route.request.invocation).targetSessionId,io.held);io.settled=true}
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
        item.held=heldFactOwner({sessionId:request.invocation.targetSessionId,incarnation:randomUUID()},ownership,createArtifactCurrentGuard(()=>item.claim!.assertHeld()))
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
    for(const entry of documents.values()){if(entry.captureIO)entry.captureIO.activeIssue=undefined;if(entry.bootstrap?.capture||entry.selected)revokeManagedEntry(entry)}
    const original=[...inspections]
    return async()=>{
      const results=await Promise.allSettled(original.map(async item=>{await item.done.catch(()=>{});if(inspections.has(item))await cleanupInspection(item)}))
      const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[])
      if(errors.length)throw new AggregateError(errors,'Capture inspection cleanup unresolved')
    }
  }
  async function releaseCapture(entry:ManagedEntry) {
    await entry.coldFinalization?.retryClose()
    const retireColdWitness=()=>{
      if(entry.selected?.cold&&entry.selected.processToken){entry.selected.processToken.end('settled');entry.selected.processToken=undefined}
    }
    // The task transition borrows this exact claim. Its original file and
    // document-lease cleanup must finish before the capture owner retires it.
    await entry.bootstrap?.taskBarrier?.retryClose()
    await entry.selected?.taskBarrier?.retryClose()
    await entry.cachedTaskBarrier?.retryClose()
    await settleCapture(entry)
    const io=entry.captureIO
    if(!io||io.released){retireColdWitness();return}
    if(io.releasing)return io.releasing
    const flight=io.claim.release().then(()=>{io.released=true;retireColdWitness()}).finally(()=>{if(io.releasing===flight)io.releasing=undefined})
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
  async function adopt(entry:ManagedEntry,state:BootstrapReadState,guards:BootstrapGuards,cached?:ManagedReadyObservation,observation={revocation:entry.revocation},taskEntry:ManagedEntry=entry):Promise<BootstrapOutcome> {
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
    if (transitions && !b.taskBarrier?.completed) {
      if (![11,12,13,CURRENT_FORMAT_VERSION].includes(state.meta!.formatVersion) || !state.stageBytes) return blocked(entry)
      b.taskBarrier ??= transitions.bootstrap(b.invocation.targetSessionId,taskEntry,entry.route ?? {protocol:'public',invocation:b.invocation},'completed',entry.captureIO ? {claim:entry.captureIO.claim,held:entry.captureIO.held} : undefined)
      b.taskBarrier.setMode('completed'); b.taskBarrier.setGuard(() => { if (guards.signal?.aborted || taskEntry.revoked) throw Object.assign(new Error('FACT_CANCELLED'),{code:'FACT_CANCELLED'}); cached?.assertCurrent(); targetCurrent(guards) })
      try {
        await b.taskBarrier.prepare(); await b.taskBarrier.settleHeader()
        let headerOutcome = b.taskBarrier.headerOutcome ?? b.headerOutcome
        if (!b.taskBarrier.headerCommitted || headerOutcome?.kind !== 'committed') {
          const operation:BootstrapHeaderOperation = { invocation:stage.invocation, target:stage.originalTarget, stageBytes:state.stageBytes, headerBytes:Buffer.from(stage.headerBytes) }
          if (entry.captureIO) entry.captureIO.settled = false
          headerOutcome = await b.taskBarrier.runHeader(h => backend.reconcileBootstrapHeader!(b.invocation.targetSessionId,h,operation))
          await settleCapture(entry)
          if (headerOutcome.kind !== 'committed') return blocked(entry)
          b.headerOutcome = headerOutcome; b.taskBarrier.markHeaderCommitted()
        }
        if (state.meta!.formatVersion < CURRENT_FORMAT_VERSION || b.taskBarrier.upgradePending) await b.taskBarrier.upgrade()
        await b.taskBarrier.finishHeader()
      } catch { return blocked(entry) }
    }
    // Confirm the original birth frames before changing only the writable header.
    if (!transitions && [11,12].includes(state.meta!.formatVersion) && state.meta!.formatVersion < CURRENT_FORMAT_VERSION) await ownership.withSessionOperation(b.invocation.targetSessionId, async () => {
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
        if (transitions) { originalBootstrapEntries.set(entry,{id:invocation.targetSessionId,documents}); if (entry.cachedTaskBarrier?.retired) entry.cachedTaskBarrier = undefined; entry.cachedTaskBarrier ??= transitions.bootstrap(invocation.targetSessionId,entry,route,undefined); candidate.bootstrap!.taskBarrier = entry.cachedTaskBarrier; entry.cachedTaskBarrier.setGuard(() => { if (guards.signal?.aborted) throw Object.assign(new Error('FACT_CANCELLED'),{code:'FACT_CANCELLED'}); assertCurrent() }); await entry.cachedTaskBarrier.openOwner() }
        const state=entry.cachedTaskBarrier ? await entry.cachedTaskBarrier.readState() : await read(invocation,route);assertCurrent()
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
        const result = await adopt(candidate,state,guards,cached,undefined,entry); if (entry.cachedTaskBarrier?.completed) entry.cachedTaskBarrier = undefined; return result
      }catch(error){
        const code=(error as {code?:string}|null|undefined)?.code
        if(code==='FACT_TARGET_UNAVAILABLE')return blocked(candidate,'dependency-unavailable')
        if(error instanceof FactRecoveryRequiredError)return{kind:'refused',reason:'wrong-view'}
        return blocked(candidate)
      }
    }).finally(async()=>{ if(entry.flight===flight)entry.flight=undefined; if(entry.cachedTaskBarrier && !entry.cachedTaskBarrier.completed && !entry.cachedTaskBarrier.taskIssued) { await entry.cachedTaskBarrier.close(); entry.cachedTaskBarrier=undefined } })
    entry.flight=flight;return flight
  }
  async function run(entry:ManagedEntry,guards:BootstrapGuards,observation={revocation:entry.revocation}):Promise<BootstrapOutcome> {
    const b=entry.bootstrap!,id=b.invocation.targetSessionId
    // Target currentness is a post-preparation capability for this invocation.
    // Header/task ownership must be acquired before the project can prepare it.
    let targetPrepared = false
    if (documents.get(id) !== entry) throw new Error('Invalid original bootstrap entry')
    originalBootstrapEntries.set(entry,{id,documents})
    let held=entry.captureIO?.held??heldFactOwner({sessionId:id,incarnation:randomUUID()},ownership,()=>{})
    if(entry.captureIO)entry.captureIO.activeIssue=()=>{if (b.taskBarrier?.mode) b.taskBarrier.markHeaderIssued();current(guards,entry);b.issued=true;entry.headerUnknown=true;entry.captureIO!.settled=false}
    try {
      // Reconcile only the original completed Task14 birth; this path cannot issue work.
      if (entry.document && b.stage && b.taskBarrier?.completed) {
        if (b.pending) {
          const pending = b.pending, key = 'key' in pending ? pending.key : 'receipt' in pending ? pending.receipt.key : undefined
          if (!key) return blocked(entry)
          const outcome = await entry.document.reconcile(key)
          b.pending = outcome
          if (outcome.kind !== 'committed') return blocked(entry)
          b.pending = undefined
        }
        const state = await read(b.invocation,entry.route)
        if (!readyState(state)) return blocked(entry)
        return await adopt(entry,state,guards,undefined,observation)
      }
      await settleCapture(entry)
      await ownership.withSessionOperation(id,async()=>{mutations.assertWritableBootstrap(id);await ownership.ensureOwnership(id)})
      if (transitions) {
        if (b.taskBarrier?.retired || b.taskBarrier?.completed) b.taskBarrier = undefined
        b.taskBarrier ??= transitions.bootstrap(id,entry,entry.route ?? {protocol:'public',invocation:b.invocation},undefined,entry.captureIO ? {claim:entry.captureIO.claim,held:entry.captureIO.held} : undefined)
        b.taskBarrier.setGuard(() => { if (guards.signal?.aborted || entry.revoked) throw Object.assign(new Error('FACT_CANCELLED'),{code:'FACT_CANCELLED'}); if (targetPrepared) targetCurrent(guards) }); await b.taskBarrier.openOwner(); held = b.taskBarrier.held()
      }
      if(b.pending&&entry.document) {
        const pending=b.pending,key='key' in pending?pending.key:'receipt' in pending?pending.receipt.key:undefined
        if(key){const outcome=await entry.document.reconcile(key);b.pending=outcome;if(outcome.kind==='committed'||outcome.kind==='absent')b.pending=undefined;else return blocked(entry)}
      }
      let state=b.taskBarrier ? await b.taskBarrier.readState() : await read(b.invocation,entry.route)
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
        io.activeIssue=()=>{if (b.taskBarrier?.mode) b.taskBarrier.markHeaderIssued();current(guards,entry);b.issued=true;entry.headerUnknown=true;io.settled=false}
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
      const predecessorBirth = !!state.meta?.semanticSeed && state.meta.formatVersion === 13 && !b.taskBarrier?.mode
      if (transitions && !predecessorBirth) {
        if (!b.taskBarrier?.mode && (b.request.target.kind === 'resume' || b.request.target.kind === 'new' && !!state.meta)) return {kind:'not-issued',reason:'unsupported'}
        const barrier = b.taskBarrier; if (!barrier) return blocked(entry)
        barrier.setMode(b.request.target.kind === 'existing-empty' ? 'existing-empty' : 'new'); barrier.setGuard(() => { if (barrier.headerWasIssued) { if (guards.signal?.aborted || entry.revoked) throw Object.assign(new Error('FACT_CANCELLED'),{code:'FACT_CANCELLED'}) } else current(guards,entry); if (targetPrepared) targetCurrent(guards) })
        try { await barrier.prepare(); held = barrier.held(); await barrier.settleHeader() }
        catch (error) { const conflict = barrier.taskConflict; if (!barrier.taskIssued || conflict) { await barrier.close(); b.taskBarrier = undefined }; return conflict ? {kind:'refused',reason:'conflict'} : blocked(entry) }
      }
      b.phase='header'
      if(entry.captureIO)entry.captureIO.settled=false
      let outcome = !predecessorBirth && b.taskBarrier?.headerCommitted && b.taskBarrier.headerOutcome?.kind === 'committed' ? b.taskBarrier.headerOutcome : !predecessorBirth && b.taskBarrier ? await b.taskBarrier.runHeader(h => backend.reconcileBootstrapHeader!(id,h,b.operation!)) : await ownership.withSessionOperation(id,()=>backend.reconcileBootstrapHeader!(id,held,b.operation!))
      await settleCapture(entry)
      if(outcome.kind!=='committed') {
        if(outcome.kind==='conflict')return {kind:'refused',reason:'conflict'}
        current(guards,entry)
        const issue = async (headerHeld: HeldFactOwner, beforeIssue: () => void) => {
          if(mutations.pendingWriteBehind(id)?.hasWork)return {kind:'conflict' as const}
          const issuing=entry.captureIO?.issuer??issuingFactOwner(headerHeld,()=>{beforeIssue();current(guards,entry);b.issued=true;entry.headerUnknown=true})
          return backend.prepareBootstrapHeader!(id,issuing,b.operation!)
        }
        outcome = !predecessorBirth && b.taskBarrier ? await b.taskBarrier.runHeader(issue) : await ownership.withSessionOperation(id,()=>issue(held,()=>{}))
      }
      if(outcome.kind!=='committed') {
        if(outcome.kind==='conflict')return {kind:'refused',reason:'conflict'}
        if(!b.issued&&outcome.kind==='not-issued')return {kind:'not-issued',reason:outcome.reason}
        return blocked(entry)
      }
      if (predecessorBirth && b.taskBarrier) { try { await b.taskBarrier.settleHeader() } catch { return blocked(entry) } }
      if (!predecessorBirth && b.taskBarrier) { b.headerOutcome = outcome; b.taskBarrier.markHeaderCommitted() }
      entry.headerUnknown=false
      state=b.taskBarrier && !b.taskBarrier.completed ? await b.taskBarrier.readState() : await read(b.invocation,entry.route)
      if(!state.meta||!state.events||!state.prefix)return blocked(entry)
      const doc=entry.document??attach(id,entry,buildSession(state.meta,state.events),state.prefix)
      b.phase='dependencies'
      if (!await prepareTarget(b.stage, guards, false, entry, b.request.seed.records)) return blocked(entry, 'dependency-unavailable')
      targetPrepared = true
      // Keep the original task/header operation through a blocked preparation.
      // A warm retry must not classify its already-issued birth as a new target.
      if (!predecessorBirth && b.taskBarrier) { try { await b.taskBarrier.finishHeader() } catch { return blocked(entry) } }
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
        state=b.taskBarrier && !b.taskBarrier.completed ? await b.taskBarrier.readState() : await read(b.invocation,entry.route)
      }
      const adopted=await adopt(entry,state,guards,undefined,observation)
      return adopted.kind==='already-ready'?{...adopted,kind:'ready'}:adopted
    } catch(error) {
      const code=(error as {code?:string}|null|undefined)?.code
      if(code==='FACT_TARGET_UNAVAILABLE')return blocked(entry,'dependency-unavailable')
      if(code==='FACT_PRECONDITION_STALE'||code==='FACT_CANCELLED')return b.issued?blocked(entry,code==='FACT_PRECONDITION_STALE'?'source-changed':'unknown'):{kind:'not-issued',reason:code==='FACT_CANCELLED'?'cancelled':'stale-source'}
      return b.issued || b.taskBarrier?.taskIssued ? blocked(entry) : {kind:'refused',reason:'manifest-invalid'}
    } finally { if(entry.captureIO){entry.captureIO.activeIssue=undefined;await settleCapture(entry)}; if (b.taskBarrier && b.issued && entry.headerUnknown) await b.taskBarrier.allowObservation(); if (b.taskBarrier && !b.taskBarrier.completed && !b.taskBarrier.taskIssued && !b.issued) { await b.taskBarrier.close(); b.taskBarrier = undefined } }
  }
  function start(invocation:BootstrapInvocation,guards:BootstrapGuards,request?:BootstrapRequest,route:BootstrapRoute={protocol:'public',invocation}):Promise<BootstrapOutcome> {
    let captured: BootstrapInvocation
    try { captured = captureBootstrapInvocation(invocation) } catch { return Promise.resolve({ kind: 'refused', reason: 'manifest-invalid' }) }
    return trackBootstrap(captured, () => startInner(invocation, guards, request, route))
  }
  function startInner(invocation:BootstrapInvocation,guards:BootstrapGuards,request?:BootstrapRequest,route:BootstrapRoute={protocol:'public',invocation}):Promise<BootstrapOutcome> {
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
    const flight=run(owned,guards).finally(()=>{if(owned.flight===flight)owned.flight=undefined;if(!owned.bootstrap!.issued&&!owned.bootstrap!.taskBarrier&&!owned.document&&documents.get(id)===owned)documents.delete(id)})
    owned.flight=flight;return flight
  }
  function captureTarget(input:BootstrapCaptureRoute,guards:BootstrapGuards,capture:()=>Promise<BootstrapRequest>):Promise<BootstrapOutcome> {
      let route: BootstrapCaptureRoute
      try { route = captureBootstrapCaptureRoute(input) } catch { return Promise.resolve({ kind: 'refused', reason: 'manifest-invalid' }) }
      return trackBootstrap(route.request.invocation, () => captureTargetInner(input, guards, capture))
  }
  function captureTargetInner(input:BootstrapCaptureRoute,guards:BootstrapGuards,capture:()=>Promise<BootstrapRequest>):Promise<BootstrapOutcome> {
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
  function prepareSelectedCapture(input:SelectedResultsRoute,identity:object,guard:()=>void,capture:()=>Promise<unknown>) {
    if (!transitions) throw new Error('TASK_TRANSITION_UNSUPPORTED')
    const route=captureSelectedResultsRoute(input),id=route.request.invocation.targetSessionId
    const selected=(backend as PersistenceBackend & {selectedCapture?:Parameters<typeof createSelectedCaptureAttempt>[0]&{prepareSelectedHeader(id:string,owner:IssuingFactOwner,route:SelectedResultsRoute,operation:BootstrapHeaderOperation,onHeaderIssue?:()=>void):Promise<HeaderOutcome>;reconcileSelectedHeader(id:string,owner:HeldFactOwner,route:SelectedResultsRoute,operation:BootstrapHeaderOperation):Promise<HeaderOutcome>}}).selectedCapture
    if(!selected||typeof selected.prepareSelectedHeader!=='function'||typeof selected.reconcileSelectedHeader!=='function'||!backend.settleBootstrapCaptureIO||!backend.checkBootstrapCaptureRoot)throw new TypeError('Selected capture unavailable')
    if(typeof guard!=='function'||typeof capture!=='function'||utilTypes.isProxy(guard)||utilTypes.isProxy(capture))throw TypeError('Invalid selected capture')
    if(captureClosed)throw Error('Selected capture closed')
    let entry=documents.get(id)
    if(entry&&(!entry.selected||entry.selected.identity!==identity||!sameBootstrapData(entry.selected.route,route)))throw Error('Selected target conflict')
    if(!entry){entry={selected:{route,identity,issued:false,processToken:processLatches?.beginMutation({sessionIds:[id],documentKeys:[],kind:'other'})}};documents.set(id,entry)}
    const owned=entry,selectedEntry=owned.selected!
    if(selectedEntry.capture&&selectedEntry.capture!==capture)throw Error('Original selected capture required')
    selectedEntry.capture??=capture
    return
  }
  function captureSelected(input:SelectedResultsRoute,identity:object,guard:()=>void,capture:()=>Promise<unknown>) {
    prepareSelectedCapture(input,identity,guard,capture)
    const route=captureSelectedResultsRoute(input),id=route.request.invocation.targetSessionId,owned=documents.get(id)!,selectedEntry=owned.selected!
    const selected=(backend as PersistenceBackend & {selectedCapture:Parameters<typeof createSelectedCaptureAttempt>[0]&{prepareSelectedHeader(id:string,owner:IssuingFactOwner,route:SelectedResultsRoute,operation:BootstrapHeaderOperation,onHeaderIssue?:()=>void):Promise<HeaderOutcome>;reconcileSelectedHeader(id:string,owner:HeldFactOwner,route:SelectedResultsRoute,operation:BootstrapHeaderOperation):Promise<HeaderOutcome>}}).selectedCapture
    if(owned.flight)return owned.flight as ReturnType<ReturnType<typeof createSelectedCaptureAttempt>['capture']>
    const check=()=>{if(captureClosed||owned.revoked)throw Error('Selected capture revoked');guard()}
    const flight=Promise.resolve().then(async()=>{
      await settleCapture(owned);check();await backend.checkBootstrapCaptureRoot!();check()
      const io=await captureBundle(owned);check()
      selectedEntry.attempt??=createSelectedCaptureAttempt({reserveSelectedCapture(...args){io.settled=false;return selected.reserveSelectedCapture(...args)}},io.issuer,route,capture)
      io.activeIssue=()=>{check();mutations.assertWritableBootstrap(id);selectedEntry.issued=true;io.settled=false}
      try{
        const state=await ownership.withSessionOperation(id,()=>selectedEntry.attempt!.capture());await settleCapture(owned);check()
        if(state.kind==='captured'){
          const journal=(backend as PersistenceBackend & {selectedJournal?:{bindCapturedLane(id:string,owner:IssuingFactOwner,route:SelectedResultsRoute,stage:import('./selected-results-header.ts').SelectedResultsHeaderStageV2,records:unknown,attempt:object,prior?:Readonly<{kind:'selected-lane'}>):Readonly<{kind:'selected-lane'}>}}).selectedJournal
          if(!journal)throw TypeError('Selected journal unavailable')
          check();const lane=journal.bindCapturedLane(id,io.issuer,route,state.stage,state.seed.records,selectedEntry.attempt!,selectedEntry.lane);check()
          if(selectedEntry.lane&&selectedEntry.lane!==lane)throw Error('Original selected lane changed')
          selectedEntry.lane=lane
        }
        if(state.kind==='captured'&&(selectedEntry.header?.kind!=='committed'||!!selectedEntry.taskBarrier&&!selectedEntry.taskBarrier.completed)){
          const operation:BootstrapHeaderOperation={invocation:route.request.invocation,target:{kind:'new'},stageBytes:Buffer.from(state.stageBytes),headerBytes:Buffer.from(state.headerBytes)}
          if (transitions) {
            originalBootstrapEntries.set(owned,{id,documents})
            selectedEntry.taskBarrier ??= transitions.bootstrap(id,owned,route,'new',{claim:io.claim,held:io.held})
            selectedEntry.taskBarrier.setGuard(check)
            try { await selectedEntry.taskBarrier.prepare() }
            catch (error) { if (!selectedEntry.taskBarrier.taskIssued || selectedEntry.taskBarrier.taskConflict) { await selectedEntry.taskBarrier.close(); selectedEntry.taskBarrier=undefined }; throw error }
          }
          const reconcile=selectedEntry.headerIssued===true
          if(selectedEntry.header?.kind!=='committed'&&(!selectedEntry.headerAttempted||reconcile||selectedEntry.header?.kind==='not-issued'||selectedEntry.header?.kind==='unknown'&&!selectedEntry.headerIssued)){
            selectedEntry.headerAttempted=true;io.settled=false
            const issue = (held:HeldFactOwner,beforeIssue:()=>void) => {
              io.activeIssue=()=>{beforeIssue();check();mutations.assertWritableBootstrap(id);selectedEntry.issued=true;io.settled=false}
              return reconcile?selected.reconcileSelectedHeader(id,held,route,operation):selected.prepareSelectedHeader(id,io.issuer,route,operation,()=>{selectedEntry.headerIssued=true})
            }
            selectedEntry.header=selectedEntry.taskBarrier ? await selectedEntry.taskBarrier.runHeader(issue) : await ownership.withSessionOperation(id,()=>issue(io.held,()=>{}))
            await settleCapture(owned);check()
          }
          if (selectedEntry.header?.kind==='committed' && selectedEntry.taskBarrier) { selectedEntry.taskBarrier.markHeaderCommitted(); await selectedEntry.taskBarrier.finishHeader() }
        }
        return state
      }
      finally{io.activeIssue=undefined;await settleCapture(owned)}
    }).finally(()=>{if(owned.flight===flight)owned.flight=undefined})
    owned.flight=flight;return flight
  }
  function publishSelected(input:SelectedResultsRoute,identity:object,guard:()=>void,target:()=>void,closure:string) {
    const route=captureSelectedResultsRoute(input),id=route.request.invocation.targetSessionId,entry=documents.get(id),selected=entry?.selected,io=entry?.captureIO
    if(!entry||!selected||selected.identity!==identity||!io||io.released||!selected.lane||!sameBootstrapData(route,selected.route)||!selected.headerIssued||selected.header?.kind!=='committed'||!/^[a-f0-9]{64}$/.test(closure))return Promise.resolve({kind:'blocked' as const})
    if(entry.flight)return Promise.resolve({kind:'blocked' as const})
    const state=selected.attempt?.inspect();if(!state||state.kind!=='captured')return Promise.resolve({kind:'blocked' as const})
    const journal=(backend as PersistenceBackend & {selectedJournal?:{
      prepareCapturedCompletion(id:string,owner:HeldFactOwner,lane:Readonly<{kind:'selected-lane'}>,frame:BootstrapFrame):void;
      appendOwnedBatch(id:string,owner:IssuingFactOwner,lane:Readonly<{kind:'selected-lane'}>,prefix:JournalPrefix,batch:BootstrapFrame['batch']):Promise<import('./fact-types.ts').BackendFactOutcome>;
      reconcileOwnedBatch(id:string,owner:HeldFactOwner,lane:Readonly<{kind:'selected-lane'}>,prefix:JournalPrefix,batch:BootstrapFrame['batch']):Promise<import('./fact-types.ts').BackendFactOutcome>;
      confirmFrames(id:string,owner:HeldFactOwner,lane:Readonly<{kind:'selected-lane'}>,frames:readonly BootstrapFrame[]):Promise<{kind:'committed';receipts:import('@i-harness/core-session').FactReceipt[]}|{kind:'unknown'|'conflict'}>;
      readJournalPrefix(id:string,owner:HeldFactOwner,lane:Readonly<{kind:'selected-lane'}>):Promise<JournalPrefix>;
    }}).selectedJournal
    if(!journal)return Promise.resolve({kind:'blocked' as const})
    const check=()=>{if(captureClosed||entry.revoked)throw Error('Selected target revoked');guard();target();io.held.assertHeld()}
    const flight=Promise.resolve().then(async()=>{
      check();await settleCapture(entry);check();if(entry.ready&&entry.document&&selected.resultReceipt)return {kind:'ready' as const,document:entry.document,receipt:selected.resultReceipt}
      const initial=emptyPrefix(),seedBatch=encodeFactBatch('bootstrap:'+route.request.invocation.operationId+':seed',initial.prefixDigest,state.seed.records),seedPrefix={eventCount:seedBatch.key.count,bodyBytes:seedBatch.bytes.length,prefixDigest:decodeFactBatch(seedBatch.bytes).prefixDigest}
      const complete:SessionEvent={type:'session/bootstrap',version:1,seq:state.seed.records.length,operationId:route.request.invocation.operationId,manifestDigest:JSON.parse(state.headerBytes).semanticSeed.manifestDigest,dependencyClosureDigest:closure,seedLength:state.seed.records.length}
      const completion=encodeFactBatch('bootstrap:'+route.request.invocation.operationId+':complete',seedPrefix.prefixDigest,[complete]),frames:BootstrapFrame[]=[{prefix:initial,batch:seedBatch},{prefix:seedPrefix,batch:completion}]
      if(selected.closure!==undefined&&selected.closure!==closure)throw Error('Selected dependency closure changed')
      if(selected.frames&&selected.frames.some((frame,index)=>!sameBootstrapData(frame.prefix,frames[index]!.prefix)||!Buffer.from(frame.batch.bytes).equals(Buffer.from(frames[index]!.batch.bytes))))throw Error('Selected frame changed')
      selected.closure??=closure;selected.frames??=frames;selected.receipts??=[]
      journal.prepareCapturedCompletion(id,io.held,selected.lane!,selected.frames[1]!);check()
      for(let index=selected.receipts.length;index<2;index++){
        const frame=selected.frames[index]!;let issued=false
        if(selected.pending!==undefined){
          if(selected.pending!==index)return {kind:'blocked' as const}
          io.settled=false;const recovered=await ownership.withSessionOperation(id,()=>journal.reconcileOwnedBatch(id,io.held,selected.lane!,frame.prefix,frame.batch));await settleCapture(entry);check()
          const checked=ownBackendOutcome(recovered,frame.batch.key,io.held.owner,true)
          if(checked.kind==='committed'){selected.receipts.push(checked.receipt);selected.pending=undefined;continue}
          if(checked.kind!=='absent')return {kind:'blocked' as const};selected.pending=undefined
        }
        io.activeIssue=()=>{check();mutations.assertWritableBootstrap(id);selected.issued=true;issued=true;selected.pending=index;io.settled=false}
        let raw:import('./fact-types.ts').BackendFactOutcome
        try{io.settled=false;raw=await ownership.withSessionOperation(id,()=>journal.appendOwnedBatch(id,io.issuer,selected.lane!,frame.prefix,frame.batch))}finally{io.activeIssue=undefined}
        await settleCapture(entry);const result=ownBackendOutcome(raw,frame.batch.key,io.held.owner,issued)
        if(result.kind!=='committed'){if(issued)selected.pending=index;return {kind:'blocked' as const}}
        selected.receipts.push(result.receipt);selected.pending=undefined;check()
      }
      io.settled=false;const confirmed=await ownership.withSessionOperation(id,()=>journal.confirmFrames(id,io.held,selected.lane!,selected.frames!));await settleCapture(entry);check()
      if(confirmed.kind!=='committed'||confirmed.receipts.length!==2)return {kind:'blocked' as const}
      for(let i=0;i<2;i++){const verified=ownBackendOutcome({kind:'committed',receipt:confirmed.receipts[i]},selected.frames[i]!.batch.key,io.held.owner,true);if(verified.kind!=='committed'||!sameBootstrapData(verified.receipt,selected.receipts[i]))return {kind:'blocked' as const}}
      io.settled=false;const prefix=await ownership.withSessionOperation(id,()=>journal.readJournalPrefix(id,io.held,selected.lane!));await settleCapture(entry);check()
      const expected={eventCount:seedPrefix.eventCount+completion.key.count,bodyBytes:seedPrefix.bodyBytes+completion.bytes.length,prefixDigest:decodeFactBatch(completion.bytes).prefixDigest}
      if(!sameBootstrapData(prefix,expected))return {kind:'blocked' as const}
      const doc=entry.document??attach(id,entry,buildSession(JSON.parse(state.headerBytes),[...(JSON.parse(canonicalJsonData(state.seed.records)) as SessionEvent[]),complete]),prefix)
      if(!entry.control?.bindSelected)return {kind:'blocked' as const}
      await entry.control.bindSelected();check();const facts=selectedResultsPreparationFacts(state.stage,state.seed.records)
      selected.resultReceipt=Object.freeze({version:2,invocation:route.request.invocation,manifestDigest:facts.manifestDigest,seedLength:facts.seedLength,dependencyClosureDigest:closure,seedDigest:facts.seedDigest,sourceObservation:facts.sourceObservation,results:facts.semantic.results})
      io.claim.retainLive();entry.control.ready();entry.ready=true;activateSelected?.(id,entry);selected.processToken?.end('settled');selected.processToken=undefined
      return {kind:'ready' as const,document:doc,receipt:selected.resultReceipt}
    }).catch(()=>({kind:'blocked' as const})).finally(async()=>{io.activeIssue=undefined;try{await settleCapture(entry)}finally{if(entry.flight===flight)entry.flight=undefined}})
    entry.flight=flight;return flight
  }
  /** Cold admission retains the original entry and owner, but does not release
   * readiness until the completed-target transition and target qualification. */
  function inspectColdSelected(input:SelectedResultsRoute):Promise<{kind:'qualification-required';target:ColdSelectedTarget}|{kind:'conflict'|'blocked'}> {
    if (!transitions) return Promise.reject(new Error('TASK_TRANSITION_UNSUPPORTED'))
    const route=captureSelectedResultsRoute(input),id=route.request.invocation.targetSessionId
    assertColdInspectionAdmission(id)
    assertOutsideCapture(id)
    let entry=documents.get(id)
    if(entry) {
      if(!entry.selected||!sameBootstrapData(entry.selected.route,route))return Promise.resolve({kind:'conflict'})
      if(entry.revoked||captureClosed)return Promise.resolve({kind:'blocked'})
      if(entry.flight)return entry.flight.then(()=>({kind:'blocked' as const}),()=>({kind:'blocked' as const}))
      if(entry.document) {
        try { entry.coldSelected?.assertCurrent() } catch { return Promise.resolve({kind:'blocked'}) }
        return Promise.resolve(entry.coldSelected ? {kind:'qualification-required',target:entry.coldSelected.target} : {kind:'blocked'})
      }
      if(!entry.selected.cold)return Promise.resolve({kind:'conflict'})
    }
    if(captureClosed||!backend.settleBootstrapCaptureIO||!backend.checkBootstrapCaptureRoot)return Promise.resolve({kind:'blocked'})
    const journal=(backend as PersistenceBackend & {selectedJournal?:{inspectCheckedBirth(route:SelectedResultsRoute,held:HeldFactOwner):Promise<
      {kind:'unavailable'|'conflict'}|{kind:'checked';birth:{stage:import('./selected-results-header.ts').SelectedResultsHeaderStageV2;facts:ReturnType<typeof selectedResultsPreparationFacts>};history:{events:SessionEvent[];prefix:JournalPrefix};meta:SessionMeta}
    >}}).selectedJournal
    if(!journal)return Promise.resolve({kind:'blocked'})
    if(!entry){entry={selected:{cold:true,route,identity:Object.freeze({}),issued:false,processToken:processLatches?.beginMutation({sessionIds:[id],documentKeys:[],kind:'other'})}};documents.set(id,entry)}
    const owned=entry
    const check=()=>{if(captureClosed||owned.revoked||documents.get(id)!==owned)throw new FactRecoveryRequiredError()}
    const flight=Promise.resolve().then(async()=>{
      await backend.checkBootstrapCaptureRoot!();check();const io=await captureBundle(owned);await settleCapture(owned);check()
      io.settled=false
      let result=await ownership.withSessionOperation(id,()=>journal.inspectCheckedBirth(route,io.held))
      await settleCapture(owned);check()
      if(result.kind!=='checked')return {kind:result.kind==='conflict'?'conflict' as const:'blocked' as const}
      if(transitions&&!owned.selected?.taskBarrier?.completed){
        originalBootstrapEntries.set(owned,{id,documents})
        const selected=owned.selected!; selected.taskBarrier ??= transitions.bootstrap(id,owned,route,'completed',{claim:io.claim,held:io.held})
        const barrier=selected.taskBarrier;barrier.setGuard(check);await barrier.prepare();check()
        const capture=(backend as PersistenceBackend & {selectedCapture?:{confirmSelectedBirthHeader(id:string,held:HeldFactOwner,route:SelectedResultsRoute,operation:BootstrapHeaderOperation,version:number):Promise<HeaderOutcome>}}).selectedCapture
        if(!capture)throw new FactRecoveryRequiredError()
        const stage=result.birth.stage,operation:BootstrapHeaderOperation={invocation:stage.invocation,target:stage.originalTarget,stageBytes:Buffer.from(canonicalJsonData(stage)+'\n'),headerBytes:Buffer.from(stage.headerBytes)}
        if(!barrier.headerCommitted){
          io.settled=false;const header=await barrier.runHeader(held=>capture.confirmSelectedBirthHeader(id,held,route,operation,result.kind==='checked'?result.meta.formatVersion:-1));await settleCapture(owned);check()
          if(header.kind!=='committed')throw new FactRecoveryRequiredError()
          barrier.markHeaderCommitted()
        }
        if(result.meta.formatVersion<CURRENT_FORMAT_VERSION||barrier.upgradePending)await barrier.upgrade()
        await barrier.finishHeader();check()
        io.settled=false;const current=await ownership.withSessionOperation(id,()=>journal.inspectCheckedBirth(route,io.held));await settleCapture(owned);check()
        if(current.kind!=='checked'||current.meta.formatVersion!==CURRENT_FORMAT_VERSION||!sameBootstrapData(current.birth.stage,result.birth.stage)||!sameBootstrapData(current.history.events,result.history.events)||!sameBootstrapData(current.history.prefix,result.history.prefix))throw new FactRecoveryRequiredError()
        result=current
      }
      const {birth,history}=result,completion=history.events[birth.stage.seed.seedLength]
      if(!completion||completion.type!=='session/bootstrap')return {kind:'blocked' as const}
      const facts=birth.facts,meta=result.meta
      const doc=attach(id,owned,buildSession(meta,history.events),history.prefix)
      await owned.control!.bindSelected!();check()
      owned.selected!.resultReceipt=Object.freeze({version:2,invocation:birth.stage.invocation,manifestDigest:facts.manifestDigest,seedLength:facts.seedLength,dependencyClosureDigest:completion.dependencyClosureDigest,seedDigest:facts.seedDigest,sourceObservation:facts.sourceObservation,results:facts.semantic.results})
      const originalControl=owned.control!,prepareReady=originalControl.prepareReady,originalClaim=owned.captureIO!.claim,retainLive=originalClaim.retainLive,originalToken=owned.selected!.processToken
      const inspection=createColdSelectedInspection(owned,route,birth,history.prefix,meta,{
        assertCurrent:check,assertOutside:()=>assertOutsideCapture(id),settle:()=>settleCapture(owned),
        commit(){
          check();const io=owned.captureIO!,control=owned.control!,selected=owned.selected!,token=selected.processToken
          if(control!==originalControl||!prepareReady||control.prepareReady!==prepareReady||io.claim!==originalClaim||originalClaim.retainLive!==retainLive||token!==originalToken||!prepareActivateSelected||!token||!selected.taskBarrier?.completed||!io.settled||io.released||io.releasing||owned.flight||owned.ready)throw new FactRecoveryRequiredError()
          io.held.assertHeld();io.claim.assertHeld();assertOriginalProcessMutation(token)
          const ready=Reflect.apply(prepareReady,originalControl,[]),activate=prepareActivateSelected(id,owned),document=owned.document!,receipt=selected.resultReceipt!
          Reflect.apply(retainLive,originalClaim,[]);ready();owned.ready=true;activate();token.end('settled');selected.processToken=undefined
          return Object.freeze({kind:'ready' as const,document,receipt})
        },
        async enter<T>(work:()=>Promise<T>):Promise<T>{const scope={id,active:true};try{return await callbackScope.run(scope,work)}finally{scope.active=false}},
      })
      owned.coldSelected=inspection;coldTargets.set(inspection.target,inspection)
      void doc
      return {kind:'qualification-required' as const,target:inspection.target}
    }).catch(()=>({kind:'blocked' as const})).finally(async()=>{
      try {
        await settleCapture(owned)
        if(!owned.document&&!owned.selected?.taskBarrier) {
          await releaseCapture(owned)
          if(documents.get(id)===owned)documents.delete(id)
        }
      } finally {if(owned.flight===flight)owned.flight=undefined}
    })
    owned.flight=flight;return flight
  }
  function coldSelectedRoute(target:object) {
    const original=coldTargets.get(target);if(!original)throw new TypeError('Original cold selected target required')
    assertOutsideCapture(original.route.request.invocation.targetSessionId);original.assertCurrent();if(documents.get(original.route.request.invocation.targetSessionId)?.coldFinalization)throw new FactRecoveryRequiredError();return original.route
  }
  function assertColdInspectionAdmission(id:string){assertOutsideCapture(id);if(documents.get(id)?.coldFinalization)throw new FactRecoveryRequiredError()}
  async function useColdSelected<T>(target:object,work:(observation:ColdSelectedObservation)=>Promise<T>):Promise<T> {
    const original=coldTargets.get(target);if(!original)throw new TypeError('Original cold selected target required')
    if(typeof work!=='function'||utilTypes.isProxy(work))throw new TypeError('Invalid cold target callback')
    return original.use(work)
  }
  function inspectSelected(input:SelectedResultsRoute,identity:object) {
    const route=captureSelectedResultsRoute(input),id=route.request.invocation.targetSessionId,entry=documents.get(id),selected=entry?.selected,io=entry?.captureIO
    if(!entry||entry.revoked||!selected||selected.identity!==identity||!sameBootstrapData(selected.route,route)||!io||io.released||!selected.lane||!selected.headerIssued||selected.header?.kind!=='committed')throw Error('Original selected target unavailable')
    const state=selected.attempt?.inspect();if(!state||state.kind!=='captured')throw Error('Original selected capture unavailable')
    io.held.assertHeld();return Object.freeze({invocation:route.request.invocation,manifestDigest:JSON.parse(state.headerBytes).semanticSeed.manifestDigest as string,facts:selectedResultsPreparationFacts(state.stage,state.seed.records),seed:state.seed,stage:state.stage})
  }
  async function releaseSelected(input:SelectedResultsRoute,identity:object) {
    const route=captureSelectedResultsRoute(input),entry=documents.get(route.request.invocation.targetSessionId)
    if(!entry||!entry.selected||entry.selected.identity!==identity)return
    if(!sameBootstrapData(entry.selected.route,route))throw Error('Selected target conflict')
    entry.captureIO&&(entry.captureIO.activeIssue=undefined)
    await entry.flight?.catch(()=>{});if(entry.selected.pending!==undefined){await reconcileSelected(entry.selected.route,identity);if(entry.selected.pending!==undefined)throw new FactRecoveryRequiredError()}
    if(entry.selected.taskBarrier && !entry.selected.taskBarrier.completed) await entry.selected.taskBarrier.close()
    await releaseCapture(entry)
    entry.selected.processToken?.end(entry.selected.issued?'unknown':'settled');entry.selected.processToken=undefined
    if(!entry.selected.issued&&!entry.document&&documents.get(route.request.invocation.targetSessionId)===entry)documents.delete(route.request.invocation.targetSessionId)
  }
  function reconcileSelected(input:SelectedResultsRoute,identity:object):Promise<HeaderOutcome> {
    const route=captureSelectedResultsRoute(input),id=route.request.invocation.targetSessionId,entry=documents.get(id),selected=entry?.selected,io=entry?.captureIO
    const backendSelected=(backend as PersistenceBackend & {selectedCapture?:{reconcileSelectedHeader(id:string,owner:HeldFactOwner,route:SelectedResultsRoute,operation:BootstrapHeaderOperation):Promise<HeaderOutcome>}}).selectedCapture
    if(!entry||!selected||selected.identity!==identity||!io||io.released||!backendSelected||!sameBootstrapData(selected.route,route))return Promise.resolve({kind:'unknown'})
    if(entry.flight)return Promise.resolve({kind:'unknown'})
    const captured=selected.attempt?.inspect();if(!captured||captured.kind!=='captured'||!selected.headerIssued)return Promise.resolve({kind:'unknown'})
    const operation:BootstrapHeaderOperation={invocation:route.request.invocation,target:{kind:'new'},stageBytes:Buffer.from(captured.stageBytes),headerBytes:Buffer.from(captured.headerBytes)}
    const flight=Promise.resolve().then(async()=>{await settleCapture(entry);io.held.assertHeld();io.settled=false;try{
      if(selected.pending!==undefined&&selected.frames&&selected.lane){
        const journal=(backend as PersistenceBackend & {selectedJournal?:{reconcileOwnedBatch(id:string,owner:HeldFactOwner,lane:Readonly<{kind:'selected-lane'}>,prefix:JournalPrefix,batch:BootstrapFrame['batch']):Promise<import('./fact-types.ts').BackendFactOutcome>}}).selectedJournal
        if(!journal)return {kind:'unknown' as const};const index=selected.pending,frame=selected.frames[index]!
        const outcome=await ownership.withSessionOperation(id,()=>journal.reconcileOwnedBatch(id,io.held,selected.lane!,frame.prefix,frame.batch)),checked=ownBackendOutcome(outcome,frame.batch.key,io.held.owner,true)
        if(checked.kind==='committed'){selected.receipts??=[];if(selected.receipts.length!==index)return {kind:'unknown' as const};selected.receipts.push(checked.receipt);selected.pending=undefined;return selected.header??{kind:'unknown' as const}}
        if(checked.kind==='absent'){selected.pending=undefined;return {kind:'absent' as const}}
        return {kind:checked.kind==='conflict'?'conflict' as const:'unknown' as const}
      }
      const barrier=selected.taskBarrier
      const outcome=barrier && !barrier.completed ? await barrier.runHeader(held=>backendSelected.reconcileSelectedHeader(id,held,route,operation)) : await ownership.withSessionOperation(id,()=>backendSelected.reconcileSelectedHeader(id,io.held,route,operation))
      selected.header=outcome
      if(outcome.kind==='committed' && barrier && !barrier.completed){barrier.markHeaderCommitted();await settleCapture(entry);await barrier.finishHeader()}
      return outcome
    }finally{await settleCapture(entry)}}).finally(()=>{if(entry.flight===flight)entry.flight=undefined})
    entry.flight=flight;return flight
  }
  const originalColdBootstrap=Object.freeze({capture(target:ColdSelectedTarget){if(this!==originalColdBootstrap)throw TypeError('Original cold bootstrap receiver required');const original=coldTargets.get(target);if(!original)throw TypeError('Original cold selected target required');return original.captureAccess()}})
  return {
    originalColdBootstrap,
    assertColdInspectionAdmission,prepareSelectedCapture,captureSelected,inspectSelected,inspectColdSelected,coldSelectedRoute,useColdSelected,publishSelected,releaseSelected,reconcileSelected,
    captureSupported, childSupported, assertOutsideCapture, captureSelfConflict, closeCaptureAdmission, settleCapture, releaseCapture, trackBootstrapInvocation: trackBootstrap,
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
