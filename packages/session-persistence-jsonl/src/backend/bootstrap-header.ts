import { lstat, open, readFile, readdir, rename, mkdir, type FileHandle } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { canonicalJsonData } from '@i-harness/core-session'
import { readBootstrapFactJournal } from '@i-harness/core-session/internal/bootstrap'
import { isHeldFactOwner, parseBootstrapHeaderStage, parseBootstrapCaptureReservation, rawHeaderDigest, type HeldFactOwner, type BootstrapBackend, type BootstrapHeaderOperation, type HeaderOutcome } from '@i-harness/session-persistence'
import { parseHeader } from '../format.ts'
import { createBootstrapCaptureBackend } from './bootstrap-capture.ts'
import { createBootstrapCaptureIO, type BootstrapCaptureIO } from './bootstrap-capture-io.ts'
import { bootstrapPaths, bootstrapNamespace, bootstrapPathsForRoute, lookupBootstrapStage, ordinaryStageIO } from './bootstrap-stage.ts'
export { bootstrapPaths } from './bootstrap-stage.ts'
import { captureBootstrapRoute, routeInvocation, type BootstrapRoute, type BootstrapRouteBackend, type BootstrapReadState } from '@i-harness/session-persistence'
import { preserveBootstrapBirth } from './fact-journal.ts'
import { resolveSelectedBirth } from './selected-birth.ts'
import { lookupSelectedBootstrapStage } from './selected-bootstrap-stage.ts'

export async function bootstrapArtifacts(path:string):Promise<string[]> {
  const prefix=basename(path)+'.bootstrap-'
  const names=await readdir(dirname(path)).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e})
  return names.filter(n=>n.startsWith(prefix)&&/^[a-f0-9]{64}\.(stage|publish|promote)$/.test(n.slice(prefix.length)))
}
async function optional(path:string):Promise<Buffer|undefined> { try{return await readFile(path)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e} }
async function bounded(path:string,limit:number):Promise<Buffer|undefined> {
  let handle:FileHandle|undefined
  try {handle=await open(path,'r'); if((await handle.stat()).size>limit)throw new Error('Bootstrap stage exceeds byte limit');return await handle.readFile()}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}finally{await handle?.close()}
}
async function headerPrefix(path:string):Promise<Buffer|undefined> {
  let handle:FileHandle|undefined
  try {
    handle=await open(path,'r')
    const bytes=Buffer.alloc(65536);let offset=0
    while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)break;offset+=result.bytesRead;if(bytes.subarray(0,offset).includes(10))break}
    return bytes.subarray(0,offset)
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}finally{await handle?.close()}
}
function scope(id:string,owner:HeldFactOwner) {
  if(!isHeldFactOwner(owner)||owner.owner.sessionId!==id)throw new TypeError('Invalid bootstrap owner scope')
  owner.assertHeld()
}
function matchingPrefix(actual:Uint8Array,expected:Uint8Array):boolean {
  return actual.length<=expected.length&&Buffer.from(actual).equals(Buffer.from(expected.subarray(0,actual.length)))
}
function originalEmptyTarget(actual:Buffer,id:string,operation:BootstrapHeaderOperation):boolean {
  if(operation.target.kind!=='existing-empty')return false
  try {
    const end=actual.indexOf(10),meta=end>=0?parseHeader(actual.subarray(0,end).toString('utf8')):undefined
    return end===actual.length-1&&!!meta&&!meta.semanticSeed&&[11,12,13,14].includes(meta.formatVersion)&&meta.sessionId===id&&meta.createdAt===operation.invocation.createdAt
      &&rawHeaderDigest(actual)===operation.target.expectedHeaderDigest&&meta.journal?.legacyEventCount===0&&meta.journal?.legacyBodyBytes===0
      &&meta.journal?.separatorBytes===0&&meta.journal?.legacyPrefixDigest===operation.target.expectedPrefix.prefixDigest
  }catch{return false}
}
export function createBootstrapHeaderBackend(filePath:(id:string)=>string, assertNotDeleted:(kind:string,id:string)=>Promise<void>, rootPath:string,captureIO:BootstrapCaptureIO=createBootstrapCaptureIO()):Pick<BootstrapBackend,'prepareBootstrapHeader'|'reconcileBootstrapHeader'|'readBootstrapState'|'checkBootstrapCaptureRoot'|'readBootstrapCapture'|'prepareBootstrapCapture'|'settleBootstrapCaptureIO'> & {selectedCapture:Pick<ReturnType<typeof createBootstrapCaptureBackend>,'readSelectedCapture'|'reserveSelectedCapture'|'prepareSelectedHeader'|'reconcileSelectedHeader'|'confirmSelectedBirthHeader'>; bootstrapRoutes:BootstrapRouteBackend; trackHeaderOwner(id:string, owner:HeldFactOwner):void; settleTrackedHeaderIO(id:string, owner:HeldFactOwner):Promise<void>; readTrackedState(route:BootstrapRoute,owner:HeldFactOwner):Promise<BootstrapReadState>; hasTrackedHeaderDebt(id:string,owner:HeldFactOwner):boolean; trackedStageIO(id:string,owner:HeldFactOwner):import('./bootstrap-stage.ts').StageLookupIO; resolveTrackedBirth(id:string,owner:HeldFactOwner):Promise<{route:BootstrapRoute; stage:import('@i-harness/session-persistence').BootstrapHeaderStage; stageBytes:Uint8Array; digest:string} | {route:import('@i-harness/session-persistence').SelectedResultsRoute; stage:import('@i-harness/session-persistence').SelectedResultsHeaderStageV2; stageBytes:Uint8Array; digest:string} | undefined>} {
  const capture = createBootstrapCaptureBackend(filePath, assertNotDeleted, rootPath, captureIO)
  type HeaderResource = { handle: FileHandle; close: FileHandle['close']; failed: boolean; cause?: unknown }
  type HeaderLedger = { id: string; handles: Set<HeaderResource>; pending: Set<Promise<unknown>>; settling?: Promise<void> }
  const headerLedgers = new WeakMap<object, HeaderLedger>()
  const headerFlight = new AsyncLocalStorage<{ ledger: HeaderLedger; active: boolean }>()
  const sameRevision = (left: BigIntStats, right: BigIntStats) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
  function trackHeaderOwner(id:string, owner:HeldFactOwner) {
    scope(id, owner); const existing = headerLedgers.get(owner.owner)
    if (existing && existing.id !== id) throw new TypeError('Invalid bootstrap header owner')
    if (!existing) headerLedgers.set(owner.owner, { id, handles: new Set(), pending: new Set() })
  }
  async function ownedOpen(id:string, owner:HeldFactOwner, path:string, flags:string) {
    scope(id,owner); const ledger = headerLedgers.get(owner.owner), failed = ledger && [...ledger.handles].find(value => value.failed); if (failed) throw failed.cause
    const admitted = headerFlight.getStore()
    if (ledger?.settling && (!admitted?.active || admitted.ledger !== ledger)) throw new Error('Bootstrap header settlement in progress')
    const handle = await open(path, flags)
    const resource:HeaderResource = { handle, close: handle.close, failed: false }; ledger?.handles.add(resource)
    return { resource, ledger }
  }
  async function ownedClose(resource:HeaderResource, ledger?:HeaderLedger) {
    if (resource.failed && resource.handle.fd < 0) throw resource.cause
    try { await Reflect.apply(resource.close, resource.handle, []); ledger?.handles.delete(resource) }
    catch (error) { resource.failed = true; resource.cause = error; throw error }
  }
  async function ownedRead(path:string,id:string,owner:HeldFactOwner,limit?:number):Promise<Buffer|undefined> {
    if (!headerLedgers.has(owner.owner)) return limit === undefined ? optional(path) : bounded(path,limit)
    let opened:Awaited<ReturnType<typeof ownedOpen>>, pathBefore:BigIntStats
    try {
      const observed = await lstat(path,{bigint:true}); scope(id,owner)
      if (!observed.isFile() || observed.isSymbolicLink() || observed.ino <= 0n) throw new Error('Bootstrap file identity unavailable')
      pathBefore = observed; opened = await ownedOpen(id,owner,path,'r')
    } catch (error) { if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') return; throw error }
    try {
      scope(id,owner); const before = await opened.resource.handle.stat({ bigint: true }); scope(id,owner)
      if (!before.isFile() || before.ino <= 0n || !sameRevision(before,pathBefore) || before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER) || limit !== undefined && before.size > BigInt(limit)) throw new Error('Bootstrap stage exceeds byte limit or changed')
      const length = Number(before.size), bytes = Buffer.alloc(length + 1); let offset = 0
      while (offset < bytes.length) { scope(id,owner); const read = await opened.resource.handle.read(bytes, offset, Math.min(65536, bytes.length - offset), offset); if (!read.bytesRead) break; offset += read.bytesRead }
      const after = await opened.resource.handle.stat({ bigint: true }), pathAfter = await lstat(path,{bigint:true}); scope(id,owner)
      if (!pathAfter.isFile() || pathAfter.isSymbolicLink() || offset !== length || !sameRevision(after,before) || !sameRevision(pathAfter,before)) throw new Error('Bootstrap file changed')
      return bytes.subarray(0, length)
    }
    finally { await ownedClose(opened.resource,opened.ledger) }
  }
  function settleTrackedHeaderIO(id:string,owner:HeldFactOwner):Promise<void> {
    scope(id,owner); const ledger = headerLedgers.get(owner.owner); if (!ledger) return Promise.resolve()
    if (ledger.id !== id) return Promise.reject(new TypeError('Invalid bootstrap header owner'))
    if (ledger.settling) return ledger.settling
    const flight = Promise.resolve().then(async () => {
      await Promise.allSettled([...ledger.pending]); const results = await Promise.allSettled([...ledger.handles].map(resource => ownedClose(resource,ledger)))
      const errors = results.flatMap(value => value.status === 'rejected' ? [value.reason] : []); if (errors.length) throw new AggregateError(errors,'Bootstrap header cleanup unresolved')
      scope(id,owner)
    })
    ledger.settling = flight; void flight.then(() => { if (ledger.settling === flight) ledger.settling = undefined }, () => { if (ledger.settling === flight) ledger.settling = undefined }); return flight
  }
  function trackHeaderFlight<T>(id:string,owner:HeldFactOwner,work:()=>Promise<T>):Promise<T> {
    scope(id,owner); const ledger = headerLedgers.get(owner.owner); if (!ledger) return work()
    if (ledger.settling) return Promise.reject(new Error('Bootstrap header settlement in progress'))
    const context = { ledger, active: true }
    const flight = Promise.resolve().then(() => headerFlight.run(context, async () => { try { return await work() } finally { context.active = false } })); ledger.pending.add(flight)
    void flight.then(() => ledger.pending.delete(flight), () => ledger.pending.delete(flight)); return flight
  }
  function check(id:string,owner:HeldFactOwner,operation:BootstrapHeaderOperation) {
    scope(id,owner)
    const stage=parseBootstrapHeaderStage(operation.stageBytes)
    if(stage.invocation.targetSessionId!==id || canonicalJsonData(stage.invocation)!==canonicalJsonData(operation.invocation) || canonicalJsonData(stage.originalTarget)!==canonicalJsonData(operation.target)
      || !Buffer.from(stage.headerBytes).equals(Buffer.from(operation.headerBytes)))throw new TypeError('Invalid bootstrap header scope')
  }
  async function syncExact(path:string,bytes:Uint8Array,id:string,owner:HeldFactOwner):Promise<boolean> {
    const actual=await ownedRead(path,id,owner)
    if(!actual||actual.length<bytes.length||!actual.subarray(0,bytes.length).equals(Buffer.from(bytes)))return false
    if(actual.length>bytes.length){const meta=parseHeader(Buffer.from(bytes).toString('utf8'));readBootstrapFactJournal(actual.subarray(bytes.length),meta.journal!,meta.formatVersion,meta)}
    const opened=await ownedOpen(id,owner,path,'r+'), h=opened.resource.handle
    try{scope(id,owner);await h.sync();scope(id,owner)}finally{await ownedClose(opened.resource,opened.ledger).catch(()=>{})}
    return true
  }
  async function readState(input:BootstrapRoute, trackedOwner?:HeldFactOwner):Promise<BootstrapReadState> {
    const route=captureBootstrapRoute(input),invocation=routeInvocation(route)
    await assertNotDeleted('session',invocation.targetSessionId)
    const path=filePath(invocation.targetSessionId),paths=bootstrapPathsForRoute(path,route)
    const lookupIO = trackedOwner ? { namespace: () => bootstrapNamespace(path), read: (artifact:string,limit:number) => ownedRead(artifact,invocation.targetSessionId,trackedOwner,limit), assertCurrent: () => scope(invocation.targetSessionId,trackedOwner) } : ordinaryStageIO(path)
    let selected=await lookupBootstrapStage(path,{kind:'route',route},lookupIO)
    const siblings=await bootstrapNamespace(path),stagePresent=siblings.includes(basename(paths.stage)),promotionPresent=siblings.includes(basename(paths.promote)),publicationPresent=siblings.includes(basename(paths.publish))
    // Preserve the original public diagnostics for a sole retained publication
    // or promotion. This proves only the stage: B2 still receives the actual
    // artifact bytes, and only the live original captured payload can continue
    // a partial public promotion. Header/birth and all child lookups are strict.
    if(route.protocol==='public'&&(selected.kind==='conflict'||selected.kind==='unavailable')&&promotionPresent!==publicationPresent&&siblings.every(n=>[paths.stage,paths.promote,paths.publish].some(p=>n===basename(p)))){
      const io=lookupIO,artifact=promotionPresent?paths.promote:paths.publish
      const proof=await lookupBootstrapStage(path,{kind:'route',route},{...io,namespace:async()=>(await io.namespace()).filter(n=>n!==basename(artifact)),read:(p,limit)=>p===artifact?Promise.resolve(undefined):io.read(p,limit)})
      if(publicationPresent&&proof.kind==='full'||promotionPresent&&proof.kind==='reserved')selected=proof
    }
    const retained={stagePresent,promotionPresent,publicationPresent,foreign:selected.kind==='conflict',...(selected.kind==='reserved'?{captureReservation:selected.reservation}:{}),...(selected.kind==='full'?{stageBytes:selected.exactBytes}:{})}
    try {
      if(selected.kind==='conflict'||selected.kind==='unavailable')return{kind:'unavailable',...retained}
      const promotionBytes=promotionPresent?await (trackedOwner ? ownedRead(paths.promote,invocation.targetSessionId,trackedOwner,262144) : bounded(paths.promote,262144)):undefined,publicationBytes=publicationPresent?await (trackedOwner ? ownedRead(paths.publish,invocation.targetSessionId,trackedOwner,65536) : bounded(paths.publish,65536)):undefined
      const artifacts={...retained,...(promotionBytes?{promotionBytes}:{}),...(publicationBytes?{publicationBytes}:{})}
      const prefix=trackedOwner ? await ownedRead(path,invocation.targetSessionId,trackedOwner) : await headerPrefix(path)
      if(!prefix)return selected.kind==='absent'?{kind:'absent'}:{kind:'present',...artifacts}
      if(prefix.indexOf(10)<0)return{kind:'unavailable',...artifacts}
      const raw=trackedOwner ? await ownedRead(path,invocation.targetSessionId,trackedOwner) : await optional(path);if(!raw)return{kind:'unavailable',...artifacts}
      const end=raw.indexOf(10);if(end<0||end+1>65536)return{kind:'unavailable',...artifacts}
      const rawHeader=raw.subarray(0,end+1).toString('utf8'),meta=parseHeader(rawHeader),journal=readBootstrapFactJournal(raw.subarray(end+1),meta.journal!,meta.formatVersion,meta)
      return{kind:'present',...artifacts,rawHeader,meta,...journal}
    }catch{return{kind:'unavailable',...retained}}
  }
  function hasTrackedHeaderDebt(id:string,owner:HeldFactOwner) { scope(id,owner); const ledger=headerLedgers.get(owner.owner); return !!ledger && [...ledger.handles].some(resource=>resource.failed) }
  function readTrackedState(route:BootstrapRoute,owner:HeldFactOwner) {
    const id=routeInvocation(route).targetSessionId
    return trackHeaderFlight(id,owner,async()=>{ const result=await readState(route,owner); if(hasTrackedHeaderDebt(id,owner))throw new Error('Bootstrap tracked read cleanup unresolved'); return result })
  }
  function trackedStageIO(id:string,owner:HeldFactOwner) {
    scope(id,owner); const path=filePath(id)
    return { namespace:()=>trackHeaderFlight(id,owner,()=>bootstrapNamespace(path)), read:(artifact:string,limit:number)=>trackHeaderFlight(id,owner,()=>ownedRead(artifact,id,owner,limit)), assertCurrent:()=>scope(id,owner) }
  }
  function resolveTrackedBirth(id:string,owner:HeldFactOwner) {
    return trackHeaderFlight(id,owner,async()=>{
      scope(id,owner); await assertNotDeleted('session',id); const path=filePath(id), raw=await ownedRead(path,id,owner); if(!raw)throw new Error('Bootstrap parent unavailable')
      const end=raw.indexOf(10); if(end<0)throw new Error('Invalid bootstrap header'); const meta=parseHeader(raw.subarray(0,end).toString('utf8'))
      if(!meta.semanticSeed) { if((await bootstrapNamespace(path)).length)throw new Error('Foreign bootstrap namespace'); return undefined }
      const io={ namespace:()=>bootstrapNamespace(path), read:(artifact:string,limit:number)=>ownedRead(artifact,id,owner,limit), assertCurrent:()=>scope(id,owner) }
      if(meta.semanticSeed.version===3) {
        const birth=await resolveSelectedBirth(path,id,assertNotDeleted,{stage:io,readJournal:async()=>{const bytes=await ownedRead(path,id,owner);if(!bytes)throw new Error('Selected parent unavailable');return bytes}})
        if(!birth)throw new Error('Selected birth unavailable')
        const stage=await lookupSelectedBootstrapStage(path,{kind:'route',route:birth.route},io)
        if(stage.kind!=='full' || canonicalJsonData(stage.stage)!==canonicalJsonData(birth.stage))throw new Error('Selected stage changed')
        if(hasTrackedHeaderDebt(id,owner))throw new Error('Bootstrap tracked read cleanup unresolved')
        return {route:birth.route,stage:birth.stage,stageBytes:stage.exactBytes,digest:createHash('sha256').update(raw).digest('hex')}
      }
      const selected=await lookupBootstrapStage(path,{kind:'header',meta},io); if(selected.kind!=='full')throw new Error('Original bootstrap stage unavailable')
      const journal=readBootstrapFactJournal(raw.subarray(end+1),meta.journal!,meta.formatVersion,meta); if(journal.torn)throw new Error('Incomplete bootstrap history')
      await preserveBootstrapBirth(path,raw,meta,journal.events,io); scope(id,owner)
      if(hasTrackedHeaderDebt(id,owner))throw new Error('Bootstrap tracked read cleanup unresolved')
      return {route:selected.route,stage:selected.stage,stageBytes:selected.exactBytes,digest:createHash('sha256').update(raw).digest('hex')}
    })
  }
  const bootstrapRoutes:BootstrapRouteBackend={readState,readCapture:capture.readCapture,reserveCapture:capture.reserveCapture,async resolveBirth(id){
    await assertNotDeleted('session',id)
    const path=filePath(id),raw=await optional(path);if(!raw)return
    const end=raw.indexOf(10),meta=parseHeader(raw.subarray(0,end).toString('utf8'))
    if(!meta.semanticSeed)return
    const selected=await lookupBootstrapStage(path,{kind:'header',meta},ordinaryStageIO(path))
    if(selected.kind!=='full')throw new TypeError('Unique bootstrap birth unavailable')
    const journal=readBootstrapFactJournal(raw.subarray(end+1),meta.journal!,meta.formatVersion,meta)
    await preserveBootstrapBirth(path,raw,meta,journal.events)
    await assertNotDeleted('session',id)
    return{route:selected.route,stage:selected.stage}
  }}
  const result: Pick<BootstrapBackend,'prepareBootstrapHeader'|'reconcileBootstrapHeader'|'readBootstrapState'|'checkBootstrapCaptureRoot'|'readBootstrapCapture'|'prepareBootstrapCapture'|'settleBootstrapCaptureIO'> & { selectedCapture:Pick<ReturnType<typeof createBootstrapCaptureBackend>,'readSelectedCapture'|'reserveSelectedCapture'|'prepareSelectedHeader'|'reconcileSelectedHeader'|'confirmSelectedBirthHeader'>; bootstrapRoutes: BootstrapRouteBackend; trackHeaderOwner(id:string,owner:HeldFactOwner):void; settleTrackedHeaderIO(id:string,owner:HeldFactOwner):Promise<void>; readTrackedState(route:BootstrapRoute,owner:HeldFactOwner):Promise<BootstrapReadState>; hasTrackedHeaderDebt(id:string,owner:HeldFactOwner):boolean; trackedStageIO(id:string,owner:HeldFactOwner):import('./bootstrap-stage.ts').StageLookupIO; resolveTrackedBirth(id:string,owner:HeldFactOwner):Promise<{route:BootstrapRoute; stage:import('@i-harness/session-persistence').BootstrapHeaderStage; stageBytes:Uint8Array; digest:string} | {route:import('@i-harness/session-persistence').SelectedResultsRoute; stage:import('@i-harness/session-persistence').SelectedResultsHeaderStageV2; stageBytes:Uint8Array; digest:string} | undefined> } = {
    trackHeaderOwner, settleTrackedHeaderIO, readTrackedState, hasTrackedHeaderDebt, trackedStageIO, resolveTrackedBirth,
    selectedCapture:Object.freeze({readSelectedCapture:capture.readSelectedCapture,reserveSelectedCapture:capture.reserveSelectedCapture,prepareSelectedHeader:capture.prepareSelectedHeader,reconcileSelectedHeader:capture.reconcileSelectedHeader,confirmSelectedBirthHeader:capture.confirmSelectedBirthHeader}),
    checkBootstrapCaptureRoot: capture.checkBootstrapCaptureRoot,
    readBootstrapCapture: capture.readBootstrapCapture,
    prepareBootstrapCapture: capture.prepareBootstrapCapture,
    settleBootstrapCaptureIO: capture.settleBootstrapCaptureIO,
    bootstrapRoutes,
    readBootstrapState:(invocation)=>readState({protocol:'public',invocation}),
    async prepareBootstrapHeader(id,owner,operation) {
      const optional = (path:string) => ownedRead(path,id,owner), bounded = (path:string,limit:number) => ownedRead(path,id,owner,limit)
      check(id,owner,operation)
      if(parseBootstrapHeaderStage(operation.stageBytes).captureReservation)return capture.prepareCapturedHeader(id,owner,operation)
      await assertNotDeleted('session',id)
      const path=filePath(id),paths=bootstrapPaths(path,operation.invocation)
      let issued=false, cleanup=false
      const before=()=>{scope(id,owner);owner.beforeIssue();issued=true}
      const continueFile=async(path:string,bytes:Uint8Array)=>{
        const existing=await optional(path)
        if(existing && (existing.length>bytes.length||!existing.equals(Buffer.from(bytes.subarray(0,existing.length)))))throw new Error('BOOTSTRAP_CONFLICT')
        if(!existing) before()
        const opened=await ownedOpen(id,owner,path,existing?'r+':'wx'), h=opened.resource.handle
        let synced=false
        try {
          let offset=existing?.length??0
          while(offset<bytes.length){before();const result=await h.write(bytes,offset,bytes.length-offset,offset);if(result.bytesWritten<=0)throw new Error('Header write made no progress');offset+=result.bytesWritten}
          scope(id,owner);await h.sync();synced=true
        } finally {await ownedClose(opened.resource,opened.ledger).catch(error=>{if(synced)cleanup=true;else throw error})}
      }
      try {
        const siblings=await bootstrapNamespace(path)
        if(siblings.some(n=>n!==basename(paths.stage)&&n!==basename(paths.publish)))return {kind:'conflict'}
        const stage=await bounded(paths.stage,262144),publication=await bounded(paths.publish,65536),target=await optional(path)
        if(stage!==undefined&&stage.length===0)return {kind:'unknown'}
        if(stage&&!matchingPrefix(stage,operation.stageBytes))return {kind:'conflict'}
        if(publication!==undefined) {
          if(operation.target.kind==='new')return {kind:'conflict'}
          if(!stage)return {kind:'unknown'}
          if(!matchingPrefix(publication,operation.headerBytes))return {kind:'conflict'}
        }
        if(!stage&&target&&operation.target.kind==='new')return {kind:'conflict'}
        if(operation.target.kind==='new'&&target&&!matchingPrefix(target,operation.headerBytes))return {kind:'conflict'}
        if(operation.target.kind==='existing-empty'&&target&&!target.equals(Buffer.from(operation.headerBytes))) {
          if(!originalEmptyTarget(target,id,operation))return {kind:'conflict'}
        }
        if(operation.target.kind==='existing-empty'&&!target)return {kind:'conflict'}
        before();await mkdir(dirname(path),{recursive:true})
        await continueFile(paths.stage,operation.stageBytes)
        if(operation.target.kind==='new'){ await continueFile(path,operation.headerBytes); if(headerLedgers.has(owner.owner) && !await syncExact(path,operation.headerBytes,id,owner))return {kind:'unknown'} }
        else if(!await syncExact(path,operation.headerBytes,id,owner)) {
          await continueFile(paths.publish,operation.headerBytes)
          const actual=await optional(path)
          if(!actual||rawHeaderDigest(actual)!==operation.target.expectedHeaderDigest) return {kind:'conflict'}
          before();await rename(paths.publish,path)
          if(!await syncExact(path,operation.headerBytes,id,owner))return {kind:'unknown'}
        }
        const directory=await open(dirname(path),'r').catch(()=>undefined)
        if(directory){try{await directory.sync()}catch{}finally{await directory.close().catch(()=>{})}}
        return {kind:'committed',headerDigest:rawHeaderDigest(operation.headerBytes),...(cleanup?{cleanupDiagnostic:'file-close-failed' as const}:{})}
      } catch(error) {
        const code=(error as {code?:string} | null | undefined)?.code
        if((error as Error | null | undefined)?.message==='BOOTSTRAP_CONFLICT'||code==='EEXIST')return {kind:'conflict'}
        if(!issued&&(code==='FACT_CANCELLED'||code==='FACT_PRECONDITION_STALE'))return {kind:'not-issued',reason:code==='FACT_CANCELLED'?'cancelled':'stale-source'}
        return {kind:issued?'unknown':'absent'}
      }
    },
    async reconcileBootstrapHeader(id,owner,operation):Promise<HeaderOutcome> {
      const optional = (path:string) => ownedRead(path,id,owner), bounded = (path:string,limit:number) => ownedRead(path,id,owner,limit)
      check(id,owner,operation)
      if(parseBootstrapHeaderStage(operation.stageBytes).captureReservation)return capture.reconcileCapturedHeader(id,owner,operation)
      await assertNotDeleted('session',id)
      const path=filePath(id),paths=bootstrapPaths(path,operation.invocation)
      try {
        const siblings=await bootstrapNamespace(path)
        if(siblings.some(n=>n!==basename(paths.stage)&&n!==basename(paths.publish)&&n!==basename(paths.promote)))return {kind:'conflict'}
        const stage=await bounded(paths.stage,262144)
        if(!stage)return {kind:'unknown'}
        if(!stage.equals(Buffer.from(operation.stageBytes))) {
          try { const reservation=parseBootstrapCaptureReservation(stage);if(canonicalJsonData(reservation)===canonicalJsonData(parseBootstrapHeaderStage(operation.stageBytes).captureReservation))return {kind:'unknown'} }catch{}
          return {kind:stage.length<operation.stageBytes.length&&stage.equals(Buffer.from(operation.stageBytes.subarray(0,stage.length)))?'unknown':'conflict'}
        }
        const publication=await bounded(paths.publish,65536)
        if(publication!==undefined) {
          if(operation.target.kind==='new'||!matchingPrefix(publication,operation.headerBytes))return {kind:'conflict'}
          if(publication.length<operation.headerBytes.length)return {kind:'unknown'}
        }
        const target=await optional(path)
        if(!target)return {kind:'unknown'}
        if(originalEmptyTarget(target,id,operation))return {kind:'unknown'}
        if(target.length<operation.headerBytes.length)return {kind:target.equals(Buffer.from(operation.headerBytes.subarray(0,target.length)))?'unknown':'conflict'}
        let liveBytes=Buffer.from(operation.headerBytes)
        if(!target.subarray(0,liveBytes.length).equals(liveBytes)) {
          const original=JSON.parse(liveBytes.toString('utf8'))
          if(original.formatVersion!==13)return {kind:'conflict'}
          const upgraded=Buffer.from(canonicalJsonData({...original,formatVersion:14})+'\n')
          if(!target.subarray(0,upgraded.length).equals(upgraded))return {kind:'conflict'}
          liveBytes=upgraded
        }
        if(!await syncExact(path,liveBytes,id,owner))return {kind:'unknown'}
        return {kind:'committed',headerDigest:rawHeaderDigest(liveBytes)}
      } catch{return {kind:'unknown'}}
    },
  }
  const originalPrepare = result.prepareBootstrapHeader!, originalReconcile = result.reconcileBootstrapHeader!
  result.prepareBootstrapHeader = (id,owner,operation) => trackHeaderFlight(id,owner,() => Reflect.apply(originalPrepare,result,[id,owner,operation]))
  result.reconcileBootstrapHeader = (id,owner,operation) => trackHeaderFlight(id,owner,() => Reflect.apply(originalReconcile,result,[id,owner,operation]))
  return result
}
