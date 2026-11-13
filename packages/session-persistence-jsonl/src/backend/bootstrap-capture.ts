import { assertSelectedCurrentHeader } from './selected-current-header.ts'
import { resolveSelectedBirth } from './selected-birth.ts'
import { readdir, rename, stat, lstat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { basename, dirname } from 'node:path'
import { types } from 'node:util'
import { canonicalJsonData } from '@i-harness/core-session'
import { parseBootstrapCaptureReservation, parseBootstrapHeaderStage, rawHeaderDigest, type HeldFactOwner, type IssuingFactOwner, type BootstrapCaptureInspection, type BootstrapCaptureRequest, type BootstrapCaptureReserveOutcome, type BootstrapHeaderOperation, type HeaderOutcome } from '@i-harness/session-persistence'
import { sameImmutableBootstrapHeader, bootstrapPathsForRoute, bootstrapNamespace, lookupBootstrapStage } from './bootstrap-stage.ts'
export { bootstrapNamespace } from './bootstrap-stage.ts'
import { captureBootstrapCaptureRoute, parseOwnedCaptureReservation, encodeOwnedCaptureReservation, routeForReservation, type BootstrapCaptureRoute, type OwnedCaptureInspection } from '@i-harness/session-persistence'
import { captureSelectedResultsRoute, parseSelectedResultsReservation, parseSelectedResultsHeaderStage, type SelectedResultsRoute, type SelectedResultsReservationV1, type SelectedResultsHeaderStageV2 } from '@i-harness/session-persistence'
import { lookupSelectedBootstrapStage } from './selected-bootstrap-stage.ts'
import { selectedBootstrapPaths } from './selected-results-route-path.ts'

type SelectedCaptureInspection = {kind:'absent'} | {kind:'reserved';reservation:SelectedResultsReservationV1} | {kind:'materialized';route:SelectedResultsRoute;stage:SelectedResultsHeaderStageV2} | {kind:'conflict'|'unavailable'}

import { createBootstrapCaptureIO, type BootstrapCaptureIO, type CaptureLedger as Ledger, type CaptureResource as Resource } from './bootstrap-capture-io.ts'
import { createPublicationOwner, type PublicationOwner } from './publication.ts'
// Capture caller containers without evaluating properties or proxy traps.
function selectedFields<K extends string>(input:unknown,keys:readonly K[]):Record<K,unknown> {
  if(!input||typeof input!=='object'||types.isProxy(input))throw new TypeError('Invalid selected header operation')
  const prototype=Object.getPrototypeOf(input)
  if(prototype!==Object.prototype&&prototype!==null)throw new TypeError('Invalid selected header operation')
  const descriptors=Object.getOwnPropertyDescriptors(input),ownKeys=Reflect.ownKeys(descriptors)
  if(ownKeys.length!==keys.length||ownKeys.some(key=>typeof key!=='string'||!keys.includes(key as K)))throw new TypeError('Invalid selected header operation')
  const captured=Object.create(null) as Record<K,unknown>
  for(const key of keys){
    const descriptor=descriptors[key]
    if(!descriptor||!descriptor.enumerable||!('value' in descriptor)||descriptor.value===undefined)throw new TypeError('Invalid selected header operation')
    captured[key]=descriptor.value
  }
  return captured
}
const selectedByteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'length')!.get!
const selectedByteSet=Uint8Array.prototype.set
function selectedByteSnapshot(input:unknown,limit:number):Buffer {
  if(types.isProxy(input)||!types.isUint8Array(input))throw new TypeError('Invalid selected header bytes')
  // Intrinsics ignore shadowed length/valueOf/buffer fields on real typed data.
  const length=selectedByteLength.call(input)
  if(length>limit)throw new TypeError('Invalid selected header bytes')
  const snapshot=Buffer.allocUnsafe(length)
  selectedByteSet.call(snapshot,input)
  return snapshot
}
export function createBootstrapCaptureBackend(filePath: (id: string) => string, assertNotDeleted: (kind: string, id: string) => Promise<void>, rootPath: string, captureIO: BootstrapCaptureIO = createBootstrapCaptureIO(), publication: PublicationOwner = createPublicationOwner(rootPath)) {
  const { scope, tracked, acquire, close, bytes, settleBootstrapCaptureIO } = captureIO
  // A retry confirms the same original path revision under the retained owner.
  // Equal bytes on a replacement inode cannot mint a new acknowledgment.
  const selectedBirthRevisions = new WeakMap<object, Map<string, { chain: string; revision: BigIntStats }>>()
  async function checkBootstrapCaptureRoot() {
    const info = await stat(rootPath)
    if (!info.isDirectory()) throw new Error('Capture storage root unavailable')
    await readdir(rootPath)
  }
  function assertLookupCleanup(ledger:Ledger) {
    if(!ledger.handles.size)return
    const failed=[...ledger.handles].find(resource=>Object.hasOwn(resource,'error'))
    if(failed)throw failed.error
    throw new Error('Capture lookup cleanup unresolved')
  }
  async function readCapture(id:string,owner:HeldFactOwner,input:BootstrapCaptureRoute):Promise<OwnedCaptureInspection> {
    const route=captureBootstrapCaptureRoute(input),request=route.request
    if(id!==request.invocation.targetSessionId)throw new TypeError('Capture target mismatch')
    return tracked<OwnedCaptureInspection>(id,owner,async ledger=>{
      const guard=()=>scope(id,owner),path=filePath(id)
      try {
        guard();await checkBootstrapCaptureRoot();guard();await assertNotDeleted('session',id);guard()
        const selected=await lookupBootstrapStage(path,{kind:'route',route:route.protocol==='public'?{protocol:'public',invocation:request.invocation}:{protocol:'child-v1',request:route.request}}, {namespace:()=>bootstrapNamespace(path),read:(path,limit)=>bytes(ledger,path,limit,guard),assertCurrent:guard})
        assertLookupCleanup(ledger)
        let target=false;try{await stat(path);target=true}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
        guard();await assertNotDeleted('session',id);await checkBootstrapCaptureRoot();guard()
        if(selected.kind==='reserved')return target?{kind:'unavailable'}:canonicalJsonData(selected.reservation.request)===canonicalJsonData(request)?{kind:'reserved',reservation:selected.reservation} as OwnedCaptureInspection:{kind:'conflict'}
        if(selected.kind==='full')return selected.stage.captureReservation&&canonicalJsonData(selected.stage.captureReservation.request)!==canonicalJsonData(request)?{kind:'conflict'}:{kind:'materialized'}
        if(selected.kind==='absent')return target?{kind:'unavailable'}:{kind:'absent'}
        return {kind:selected.kind}
      }catch(error){ledger.diagnostics.push(error);if(ledger.handles.size)throw error;return{kind:'unavailable'}}
    })
  }
  const readBootstrapCapture=(id:string,owner:HeldFactOwner,request:BootstrapCaptureRequest)=>readCapture(id,owner,{protocol:'public',request}) as Promise<BootstrapCaptureInspection>;
  async function readSelectedCapture(id:string,owner:HeldFactOwner,input:SelectedResultsRoute):Promise<SelectedCaptureInspection> {
    const route=captureSelectedResultsRoute(input)
    if(id!==route.request.invocation.targetSessionId)throw new TypeError('Capture target mismatch')
    return tracked(id,owner,async ledger=>{
      const guard=()=>scope(id,owner),path=filePath(id)
      try {
        guard();await checkBootstrapCaptureRoot();guard();await assertNotDeleted('session',id);guard()
        const selected=await lookupSelectedBootstrapStage(path,{kind:'route',route},{namespace:()=>bootstrapNamespace(path),read:(p,limit)=>bytes(ledger,p,limit,guard),assertCurrent:guard})
        guard();assertLookupCleanup(ledger)
        let target=false;try{await stat(path);target=true}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
        guard();await assertNotDeleted('session',id);guard();await checkBootstrapCaptureRoot();guard()
        if(selected.kind==='reserved')return target?{kind:'unavailable'}:{kind:'reserved',reservation:selected.reservation}
        if(selected.kind==='full')return {kind:'materialized',route:selected.route,stage:selected.stage}
        if(selected.kind==='absent')return target?{kind:'unavailable'}:{kind:'absent'}
        return {kind:selected.kind}
      }catch(error){ledger.diagnostics.push(error);if(ledger.handles.size)throw error;return {kind:'unavailable'}}
    })
  }
  async function writeExact(ledger: Ledger, path: string, expected: Uint8Array, owner: IssuingFactOwner, existing: Buffer | undefined, onIssue: () => void = () => {}, onAcquire: () => void = () => {}) {
    const guard = () => scope(ledger.id, owner), before = () => { guard(); owner.beforeIssue(); onIssue() }
    if (existing && (existing.length > expected.length || !existing.equals(Buffer.from(expected.subarray(0, existing.length))))) throw new Error('BOOTSTRAP_CONFLICT')
    before(); const resource = await acquire(ledger, path, existing === undefined ? 'wx' : 'r+')
    try {
      onAcquire()
      guard(); let offset = existing?.length ?? 0
      while (offset < expected.length) { before(); const result = await resource.handle.write(expected, offset, expected.length - offset, offset); guard(); if (result.bytesWritten <= 0) throw new Error('Capture write made no progress'); offset += result.bytesWritten }
      before(); await resource.handle.sync(); guard()
      const actual = await bytes(ledger, path, expected.length, guard)
      if (!actual?.equals(Buffer.from(expected))) throw new Error('Capture readback mismatch')
    } finally { await close(ledger, resource) }
  }
  async function reserveSelectedCapture(id:string,owner:IssuingFactOwner,input:SelectedResultsRoute,inputBytes:Uint8Array):Promise<BootstrapCaptureReserveOutcome> {
    const route=captureSelectedResultsRoute(input)
    if(types.isProxy(inputBytes)||!(inputBytes instanceof Uint8Array)||inputBytes.byteLength>262144)throw new TypeError('Invalid reservation bytes')
    const reservationBytes=Buffer.from(inputBytes),reservation=parseSelectedResultsReservation(reservationBytes)
    if(id!==route.request.invocation.targetSessionId||id!==reservation.request.invocation.targetSessionId)throw new TypeError('Capture target mismatch')
    if(canonicalJsonData(route.request)!==canonicalJsonData(reservation.request))throw new TypeError('Reservation route mismatch')
    scope(id,owner)
    if(typeof owner.beforeIssue!=='function')throw new TypeError('Invalid capture issuer')
    return tracked(id,owner,async ledger=>{
      let issued=false,acquired=false
      const guard=()=>scope(id,owner)
      try {
        guard();await checkBootstrapCaptureRoot();guard();await assertNotDeleted('session',id);guard()
        const paths=selectedBootstrapPaths(filePath(id),route)
        const state=await readSelectedCapture(id,owner,route);guard()
        if(state.kind==='reserved')return {kind:'present'}
        if(state.kind!=='absent')return {kind:state.kind==='conflict'||state.kind==='materialized'?'conflict':'unknown'}
        await writeExact(ledger,paths.stage,reservationBytes,owner,undefined,()=>{issued=true},()=>{acquired=true})
        guard();await assertNotDeleted('session',id);guard();await checkBootstrapCaptureRoot();guard()
        return {kind:'committed-new'}
      }catch(error){
        ledger.diagnostics.push(error)
        let code:unknown
        try {code=error!==null&&(typeof error==='object'||typeof error==='function')?(error as NodeJS.ErrnoException).code:undefined}catch{}
        if(!issued&&(code==='FACT_CANCELLED'||code==='FACT_PRECONDITION_STALE'))return {kind:'not-issued',reason:code==='FACT_CANCELLED'?'cancelled':'stale-source'}
        if(issued&&!acquired&&code==='EEXIST'){
          try {const state=await readSelectedCapture(id,owner,route);guard();return {kind:state.kind==='reserved'?'present':state.kind==='conflict'||state.kind==='materialized'?'conflict':'unknown'}}
          catch(inspectError){ledger.diagnostics.push(inspectError)}
        }
        return {kind:'unknown'}
      }
    })
  }
  async function reserveCapture(id: string, owner: IssuingFactOwner, input: BootstrapCaptureRoute, reservationBytes: Uint8Array): Promise<BootstrapCaptureReserveOutcome> {
    const route=captureBootstrapCaptureRoute(input), reservation = parseOwnedCaptureReservation(reservationBytes)
    if(canonicalJsonData(route.request)!==canonicalJsonData(reservation.request)||(route.protocol==='child-v1')!==(reservation.kind==='semantic-bootstrap-child-capture'))throw new TypeError('Reservation route mismatch')
    if (reservation.request.invocation.targetSessionId !== id) throw new TypeError('Capture target mismatch')
    return tracked(id, owner, async ledger => {
      let issued = false
      const guard = () => scope(id, owner)
      try {
        await checkBootstrapCaptureRoot(); await assertNotDeleted('session', id); guard()
        const paths = bootstrapPathsForRoute(filePath(id), routeForReservation(reservation))
        // Recheck the complete namespace immediately before the exclusive issue.
        const state = await readCapture(id, owner, route)
        if (state.kind === 'reserved') return { kind: 'present' }
        if (state.kind !== 'absent') return { kind: state.kind === 'conflict' || state.kind === 'materialized' ? 'conflict' : 'unknown' }
        await writeExact(ledger, paths.stage, reservationBytes, owner, undefined, () => { issued = true })
        await assertNotDeleted('session', id); await checkBootstrapCaptureRoot(); guard()
        // Windows optional directory flush is intentionally skipped. This is
        // process-interruption/restart qualification, not power-loss safety.
        return { kind: 'committed-new' }
      } catch (error) {
        ledger.diagnostics.push(error)
        const code = (error as NodeJS.ErrnoException).code
        if (!issued && (code === 'FACT_CANCELLED' || code === 'FACT_PRECONDITION_STALE')) return { kind: 'not-issued', reason: code === 'FACT_CANCELLED' ? 'cancelled' : 'stale-source' }
        if (code === 'EEXIST') { const actual = await readCapture(id, owner, route); return { kind: actual.kind === 'reserved' ? 'present' : actual.kind === 'conflict' ? 'conflict' : 'unknown' } }
        return { kind: 'unknown' }
      }
    })
  }
  async function prepareCapturedHeader(id: string, owner: IssuingFactOwner, operation: BootstrapHeaderOperation): Promise<HeaderOutcome> {
    const full = parseBootstrapHeaderStage(operation.stageBytes), reservation = full.captureReservation!
    return tracked(id, owner, async ledger => {
      const path = filePath(id), paths = bootstrapPathsForRoute(path, routeForReservation(reservation)), guard = () => scope(id, owner)
      try {
        await checkBootstrapCaptureRoot(); await assertNotDeleted('session', id); guard()
        const route=routeForReservation(reservation),selected=await lookupBootstrapStage(path,{kind:'route',route},{namespace:()=>bootstrapNamespace(path),read:(p,limit)=>bytes(ledger,p,limit,guard),assertCurrent:guard})
        assertLookupCleanup(ledger)
        if(selected.kind==='conflict')return{kind:'conflict'}
        if(route.protocol==='child-v1'&&selected.kind!=='full'&&selected.kind!=='reserved')return{kind:'unknown'}
        const siblings = await bootstrapNamespace(path)
        if (siblings.some(name => name !== basename(paths.stage) && name !== basename(paths.promote))) return { kind: 'conflict' }
        const stage = await bytes(ledger, paths.stage, 262144, guard)
        if (!stage) return { kind: 'unknown' }
        if (!stage.equals(Buffer.from(operation.stageBytes))) {
          if (!stage.equals(Buffer.from(encodeOwnedCaptureReservation(reservation)))) return { kind: 'conflict' }
          const pending = await bytes(ledger, paths.promote, 262144, guard)
          await writeExact(ledger, paths.promote, operation.stageBytes, owner, pending)
          const original = await bytes(ledger, paths.stage, 262144, guard)
          if (!original?.equals(stage)) return { kind: 'conflict' }
          guard(); owner.beforeIssue(); await rename(paths.promote, paths.stage); guard()
          const promoted = await bytes(ledger, paths.stage, 262144, guard)
          if (!promoted?.equals(Buffer.from(operation.stageBytes))) return { kind: 'unknown' }
        }
        const target = await bytes(ledger, path, 65536, guard)
        if (target === undefined) await publication.begin(id, path)
        await writeExact(ledger, path, operation.headerBytes, owner, target)
        await assertNotDeleted('session', id); guard()
        return { kind: 'committed', headerDigest: rawHeaderDigest(operation.headerBytes) }
      } catch (error) { ledger.diagnostics.push(error);return { kind: (error as Error).message === 'BOOTSTRAP_CONFLICT' ? 'conflict' : 'unknown' } }
    })
  }
  async function reconcileCapturedHeader(id:string,owner:HeldFactOwner,operation:BootstrapHeaderOperation):Promise<HeaderOutcome> {
    return tracked(id,owner,async ledger=>{
      const full=parseBootstrapHeaderStage(operation.stageBytes),path=filePath(id),paths=bootstrapPathsForRoute(path,routeForReservation(full.captureReservation!)),guard=()=>scope(id,owner)
      try {
        await checkBootstrapCaptureRoot();await assertNotDeleted('session',id);guard()
        const route=routeForReservation(full.captureReservation!),selected=await lookupBootstrapStage(path,{kind:'route',route},{namespace:()=>bootstrapNamespace(path),read:(p,limit)=>bytes(ledger,p,limit,guard),assertCurrent:guard})
        assertLookupCleanup(ledger)
        if(selected.kind==='conflict')return{kind:'conflict'}
        if(route.protocol==='child-v1'&&selected.kind!=='full'&&selected.kind!=='reserved')return{kind:'unknown'}
        const siblings=await bootstrapNamespace(path)
        if(siblings.some(name=>name!==basename(paths.stage)&&name!==basename(paths.promote)))return {kind:'conflict'}
        const stage=await bytes(ledger,paths.stage,262144,guard)
        if(!stage)return {kind:'unknown'}
        if(!stage.equals(Buffer.from(operation.stageBytes))) {
          const reservation=parseOwnedCaptureReservation(stage),expected=parseBootstrapHeaderStage(operation.stageBytes).captureReservation
          return {kind:canonicalJsonData(reservation)===canonicalJsonData(expected)?'unknown':'conflict'}
        }
        if(siblings.includes(basename(paths.promote)))return {kind:'unknown'}
        let resource:Resource
        try{resource=await acquire(ledger,path,'r+')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {kind:'unknown'};throw error}
        try {
          guard()
          const buffer = Buffer.alloc(65536)
          let offset = 0, end = -1
          while (offset < buffer.length && end < 0) {
            const read = await resource.handle.read(buffer, offset, buffer.length-offset, offset)
            guard()
            if (!read.bytesRead) break
            end = buffer.indexOf(10, offset)
            offset += read.bytesRead
            if (end >= offset) end = -1
          }
          if (end < 0) {
            const partial = buffer.subarray(0,offset)
            const originalBytes = Buffer.from(operation.headerBytes)
            return {kind:offset < buffer.length && partial.length < originalBytes.length && partial.equals(originalBytes.subarray(0,partial.length)) ? 'unknown' : 'conflict'}
          }
          const expected = buffer.subarray(0,end+1)
          let live: Record<string, unknown>, original: Record<string, unknown>
          try { live = JSON.parse(expected.toString('utf8')); original = JSON.parse(Buffer.from(operation.headerBytes).toString('utf8')) }
          catch { return {kind:'conflict'} }
          if (!live || typeof live !== 'object' || !sameImmutableBootstrapHeader(live,original)) return {kind:'conflict'}
          await resource.handle.sync();guard();await assertNotDeleted('session',id)
          return {kind:'committed',headerDigest:rawHeaderDigest(expected)}
        }finally{await close(ledger,resource)}
      }catch(error){ledger.diagnostics.push(error);return {kind:'unknown'}}
    })
  }
  function selectedOperation(id:string,owner:HeldFactOwner,input:SelectedResultsRoute,operation:BootstrapHeaderOperation) {
    const route=captureSelectedResultsRoute(input)
    const captured=selectedFields(operation,['invocation','target','stageBytes','headerBytes'])
    const invocationKeys=['version','operationId','targetSessionId','createdAt','requestDigest'] as const
    const invocation=selectedFields(captured.invocation,invocationKeys),target=selectedFields(captured.target,['kind'])
    if(target.kind!=='new'||invocationKeys.some(key=>invocation[key]!==route.request.invocation[key])||id!==route.request.invocation.targetSessionId)throw new TypeError('Selected header mismatch')
    const stageBytes=selectedByteSnapshot(captured.stageBytes,262144),headerBytes=selectedByteSnapshot(captured.headerBytes,65536),stage=parseSelectedResultsHeaderStage(stageBytes)
    if(canonicalJsonData(route.request)!==canonicalJsonData(stage.captureReservation.request)||!headerBytes.equals(Buffer.from(stage.headerBytes)))throw new TypeError('Selected header mismatch')
    scope(id,owner)
    return {route,stageBytes,headerBytes,reservationBytes:Buffer.from(canonicalJsonData(stage.captureReservation)+'\n')}
  }
  async function selectedHeader(id:string,owner:HeldFactOwner,input:SelectedResultsRoute,operation:BootstrapHeaderOperation,issue:boolean,onHeaderIssue?:()=>void):Promise<HeaderOutcome> {
    const captured=selectedOperation(id,owner,input,operation)
    if(issue&&typeof (owner as IssuingFactOwner).beforeIssue!=='function')throw new TypeError('Invalid capture issuer')
    if(onHeaderIssue!==undefined&&(typeof onHeaderIssue!=='function'||types.isProxy(onHeaderIssue)))throw new TypeError('Invalid header issue observer')
    return tracked(id,owner,async ledger=>{
      const guard=()=>scope(id,owner),path=filePath(id),paths=selectedBootstrapPaths(path,captured.route),issuer=owner as IssuingFactOwner
      let issued=false
      try {
        guard();await checkBootstrapCaptureRoot();guard();await assertNotDeleted('session',id);guard()
        const selected=await lookupSelectedBootstrapStage(path,{kind:'route',route:captured.route},{namespace:()=>bootstrapNamespace(path),read:(p,limit)=>bytes(ledger,p,limit,guard),assertCurrent:guard})
        assertLookupCleanup(ledger);guard()
        if(selected.kind==='conflict')return {kind:'conflict'}
        if(selected.kind!=='reserved'&&selected.kind!=='full')return {kind:'unknown'}
        if(selected.kind==='reserved') {
          if(!Buffer.from(selected.exactBytes).equals(captured.reservationBytes))return {kind:'conflict'}
          const pending=selected.promotionBytes&&Buffer.from(selected.promotionBytes)
          if(pending&&!captured.stageBytes.subarray(0,pending.length).equals(pending))return {kind:'conflict'}
          if(!issue)return {kind:'unknown'}
          const target=await bytes(ledger,path,65536,guard);if(target!==undefined)return {kind:'unknown'}
          await writeExact(ledger,paths.promote,captured.stageBytes,issuer,pending,()=>{issued=true})
          const original=await bytes(ledger,paths.stage,262144,guard)
          if(!original?.equals(captured.reservationBytes))return {kind:'conflict'}
          guard();issuer.beforeIssue();issued=true;await rename(paths.promote,paths.stage);guard()
          if(!(await bytes(ledger,paths.stage,262144,guard))?.equals(captured.stageBytes))return {kind:'unknown'}
        } else if(!Buffer.from(selected.exactBytes).equals(captured.stageBytes))return {kind:'conflict'}
        const target=await bytes(ledger,path,65536,guard)
        if(target&&!captured.headerBytes.subarray(0,target.length).equals(target))return {kind:'conflict'}
        if(issue&&target===undefined)await publication.begin(id,path)
        // Stage promotion uses the same owner and ledger, but only this original
        // target write boundary can record target-header issuance provenance.
        if(issue)await writeExact(ledger,path,captured.headerBytes,issuer,target,()=>{issued=true;onHeaderIssue?.()})
        else {
          if(!target||!target.equals(captured.headerBytes))return {kind:'unknown'}
          const resource=await acquire(ledger,path,'r+')
          try {guard();const actual=await resource.handle.readFile();guard();if(!actual.equals(captured.headerBytes))return {kind:'conflict'};await resource.handle.sync();guard()}finally{await close(ledger,resource)}
        }
        await assertNotDeleted('session',id);guard();await checkBootstrapCaptureRoot();guard()
        return {kind:'committed',headerDigest:rawHeaderDigest(captured.headerBytes)}
      }catch(error){ledger.diagnostics.push(error);let code:unknown;try{code=error!==null&&(typeof error==='object'||typeof error==='function')?(error as NodeJS.ErrnoException).code:undefined}catch{};if(issue&&!issued&&(code==='FACT_CANCELLED'||code==='FACT_PRECONDITION_STALE'))return {kind:'not-issued',reason:code==='FACT_CANCELLED'?'cancelled':'stale-source'};return {kind:'unknown'}}
    })
  }
  const prepareSelectedHeader=(id:string,owner:IssuingFactOwner,route:SelectedResultsRoute,operation:BootstrapHeaderOperation,onHeaderIssue?:()=>void)=>selectedHeader(id,owner,route,operation,true,onHeaderIssue)
  const reconcileSelectedHeader=(id:string,owner:HeldFactOwner,route:SelectedResultsRoute,operation:BootstrapHeaderOperation)=>selectedHeader(id,owner,route,operation,false)
  async function confirmSelectedBirthHeader(id:string,owner:HeldFactOwner,route:SelectedResultsRoute,operation:BootstrapHeaderOperation,liveVersion:number):Promise<HeaderOutcome> {
    const captured=selectedOperation(id,owner,route,operation)
    const original=JSON.parse(captured.headerBytes.toString('utf8'))
    if(liveVersion!==original.formatVersion && !(original.formatVersion===13 && liveVersion===14))throw new TypeError('Selected header version changed')
    let liveHeader:Buffer|undefined
    return tracked(id,owner,async ledger=>{
      const guard=()=>scope(id,owner),path=filePath(id)
      try {
        guard();await assertNotDeleted('session',id)
        const birth=await resolveSelectedBirth(path,id,assertNotDeleted,{
          stage:{namespace:()=>bootstrapNamespace(path),read:(p,limit)=>bytes(ledger,p,limit,guard),assertCurrent:guard},
          async readJournal(){const resource=await acquire(ledger,path,'r');try{guard();const raw=await resource.handle.readFile();guard();return raw}finally{await close(ledger,resource)}}
        });guard()
        if(!birth||!Buffer.from(canonicalJsonData(birth.stage)+'\n').equals(captured.stageBytes))return {kind:'conflict'}

        const sameRevision=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs
        const parents=async()=>{
          const chain:string[]=[];let parent=dirname(path),foundRoot=false
          for(;;){
            const info=await lstat(parent,{bigint:true});guard()
            if(!info.isDirectory()||info.isSymbolicLink()||info.ino<=0n)throw Error('Selected header root unavailable')
            chain.push(`${info.dev}/${info.ino}`);if(parent===rootPath)foundRoot=true
            const next=dirname(parent);if(next===parent)break;parent=next
          }
          if(!foundRoot)throw Error('Selected header outside original root')
          return chain.join(':')
        }
        const observedChain=await parents(),observedPath=await lstat(path,{bigint:true});guard()
        const key=rawHeaderDigest(captured.stageBytes)+':'+liveVersion
        let revisions=selectedBirthRevisions.get(owner.owner)
        if(!revisions){revisions=new Map();selectedBirthRevisions.set(owner.owner,revisions)}
        let originalRevision=revisions.get(key)
        if(!originalRevision){originalRevision={chain:observedChain,revision:observedPath};revisions.set(key,originalRevision)}
        const {chain,revision:originalPath}=originalRevision
        if(!originalPath.isFile()||originalPath.isSymbolicLink()||originalPath.ino<=0n)throw Error('Selected header identity unavailable')
        const current=async()=>{
          guard();const actual=await lstat(path,{bigint:true});guard()
          if(!actual.isFile()||actual.isSymbolicLink()||!sameRevision(originalPath,actual)||chain!==await parents())throw Error('Selected header path changed')
          await assertNotDeleted('session',id);guard()
        }
        const stage=await lookupSelectedBootstrapStage(path,{kind:'route',route:captured.route},{namespace:()=>bootstrapNamespace(path),read:(p,limit)=>bytes(ledger,p,limit,guard),assertCurrent:guard})
        if(stage.kind!=='full'||!Buffer.from(stage.exactBytes).equals(captured.stageBytes))return {kind:'conflict'}
        await current();assertLookupCleanup(ledger)
        const resource=await acquire(ledger,path,'r+')
        try {
          const read=async()=>{
            await current();const before=await resource.handle.stat({bigint:true});guard()
            if(!before.isFile()||!sameRevision(originalPath,before))throw Error('Selected header handle changed')
            const value=Buffer.alloc(65536);let offset=0
            while(offset<value.length){const result=await resource.handle.read(value,offset,value.length-offset,offset);guard();if(!result.bytesRead)break;offset+=result.bytesRead;if(value.subarray(0,offset).includes(10))break}
            const after=await resource.handle.stat({bigint:true});guard();await current()
            if(!sameRevision(originalPath,after))throw Error('Selected header revision changed')
            const end=value.subarray(0,offset).indexOf(10)
            if(end<0)throw TypeError('Invalid bounded selected header')
            const header=value.subarray(0,end+1),meta=assertSelectedCurrentHeader(birth.stage,JSON.parse(header.toString('utf8')))
            if(meta.formatVersion!==liveVersion)return false
            if(!liveHeader){liveHeader=Buffer.from(header);return true}
            return header.equals(liveHeader)
          }
          if(!await read())return {kind:'conflict'}
          await resource.handle.sync();guard();if(!await read())return {kind:'conflict'}
        } finally { await close(ledger,resource) }
        await current();return {kind:'committed',headerDigest:rawHeaderDigest(liveHeader!)}
      } catch(error) { ledger.diagnostics.push(error);return {kind:'unknown'} }
    })
  }
  const prepareBootstrapCapture=(id:string,owner:IssuingFactOwner,value:Uint8Array)=>{const reservation=parseBootstrapCaptureReservation(value);return reserveCapture(id,owner,{protocol:'public',request:reservation.request},value)}
  return { readCapture, reserveCapture, readSelectedCapture, reserveSelectedCapture, prepareSelectedHeader, reconcileSelectedHeader, confirmSelectedBirthHeader, checkBootstrapCaptureRoot, readBootstrapCapture, prepareBootstrapCapture, settleBootstrapCaptureIO, prepareCapturedHeader, reconcileCapturedHeader }
}
