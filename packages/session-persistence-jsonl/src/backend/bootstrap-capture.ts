import { open, readdir, rename, stat, type FileHandle } from 'node:fs/promises'
import { basename } from 'node:path'
import { canonicalJsonData } from '@i-harness/core-session'
import { isHeldFactOwner, parseBootstrapCaptureReservation, parseBootstrapHeaderStage, rawHeaderDigest, type HeldFactOwner, type IssuingFactOwner, type BootstrapCaptureInspection, type BootstrapCaptureRequest, type BootstrapCaptureReserveOutcome, type BootstrapHeaderOperation, type HeaderOutcome } from '@i-harness/session-persistence'
import { bootstrapPathsForRoute, bootstrapNamespace, lookupBootstrapStage } from './bootstrap-stage.ts'
export { bootstrapNamespace } from './bootstrap-stage.ts'
import { captureBootstrapCaptureRoute, parseOwnedCaptureReservation, encodeOwnedCaptureReservation, routeForReservation, type BootstrapCaptureRoute, type OwnedCaptureInspection } from '@i-harness/session-persistence'
import { captureSelectedResultsRoute, type SelectedResultsRoute, type SelectedResultsReservationV1, type SelectedResultsHeaderStageV2 } from '@i-harness/session-persistence'
import { lookupSelectedBootstrapStage } from './selected-bootstrap-stage.ts'

type SelectedCaptureInspection = {kind:'absent'} | {kind:'reserved';reservation:SelectedResultsReservationV1} | {kind:'materialized';route:SelectedResultsRoute;stage:SelectedResultsHeaderStageV2} | {kind:'conflict'|'unavailable'}

type Resource = { handle: FileHandle; error?: unknown; consumed?: boolean }
type Ledger = { id: string; owner: HeldFactOwner['owner']; pending: Set<Promise<unknown>>; handles: Set<Resource>; settled: boolean; diagnostics: unknown[] }
export function createBootstrapCaptureBackend(filePath: (id: string) => string, assertNotDeleted: (kind: string, id: string) => Promise<void>, rootPath: string) {
  const ledgers = new WeakMap<object, Ledger>()
  function scope(id: string, owner: HeldFactOwner) {
    if (!isHeldFactOwner(owner) || owner.owner.sessionId !== id) throw new TypeError('Invalid capture IO owner')
    owner.assertHeld()
  }
  function tracked<T>(id: string, owner: HeldFactOwner, work: (ledger: Ledger) => Promise<T>): Promise<T> {
    scope(id, owner)
    let ledger = ledgers.get(owner.owner)
    if (!ledger) { ledger = { id, owner: owner.owner, pending: new Set(), handles: new Set(), settled: false, diagnostics: [] }; ledgers.set(owner.owner, ledger) }
    ledger.settled = false
    const actual = ledger, flight = Promise.resolve().then(() => work(actual))
    actual.pending.add(flight)
    void flight.finally(() => actual.pending.delete(flight)).catch(() => {})
    return flight
  }
  async function acquire(ledger: Ledger, path: string, flags: string): Promise<Resource> {
    const handle = await open(path, flags)
    const resource: Resource = { handle }; ledger.handles.add(resource)
    return resource
  }
  async function close(ledger: Ledger, resource: Resource) {
    if (resource.consumed) throw resource.error
    try { await resource.handle.close(); ledger.handles.delete(resource); resource.error = undefined }
    catch (error) { resource.error = error; resource.consumed = resource.handle.fd < 0; throw error }
  }
  async function bytes(ledger: Ledger, path: string, limit: number, guard: () => void): Promise<Buffer | undefined> {
    let resource: Resource
    try { resource = await acquire(ledger, path, 'r') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    try { guard(); if ((await resource.handle.stat()).size > limit) throw new Error('Capture stage exceeds limit'); guard(); const value = await resource.handle.readFile(); guard(); return value }
    finally { await close(ledger, resource) }
  }
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
  async function writeExact(ledger: Ledger, path: string, expected: Uint8Array, owner: IssuingFactOwner, existing: Buffer | undefined, onIssue: () => void = () => {}) {
    const guard = () => scope(ledger.id, owner), before = () => { guard(); owner.beforeIssue(); onIssue() }
    if (existing && (existing.length > expected.length || !existing.equals(Buffer.from(expected.subarray(0, existing.length))))) throw new Error('BOOTSTRAP_CONFLICT')
    before(); const resource = await acquire(ledger, path, existing === undefined ? 'wx' : 'r+')
    try {
      guard(); let offset = existing?.length ?? 0
      while (offset < expected.length) { before(); const result = await resource.handle.write(expected, offset, expected.length - offset, offset); guard(); if (result.bytesWritten <= 0) throw new Error('Capture write made no progress'); offset += result.bytesWritten }
      before(); await resource.handle.sync(); guard()
      const actual = await bytes(ledger, path, expected.length, guard)
      if (!actual?.equals(Buffer.from(expected))) throw new Error('Capture readback mismatch')
    } finally { await close(ledger, resource) }
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
          guard();const actual=Buffer.alloc(operation.headerBytes.length);let offset=0
          while(offset<actual.length){const read=await resource.handle.read(actual,offset,actual.length-offset,offset);guard();if(!read.bytesRead)break;offset+=read.bytesRead}
          if(offset!==actual.length||!actual.equals(Buffer.from(operation.headerBytes)))return {kind:Buffer.from(operation.headerBytes).subarray(0,offset).equals(actual.subarray(0,offset))?'unknown':'conflict'}
          await resource.handle.sync();guard();await assertNotDeleted('session',id)
          return {kind:'committed',headerDigest:rawHeaderDigest(operation.headerBytes)}
        }finally{await close(ledger,resource)}
      }catch(error){ledger.diagnostics.push(error);return {kind:'unknown'}}
    })
  }
  async function settleBootstrapCaptureIO(id: string, owner: HeldFactOwner) {
    scope(id, owner)
    const ledger = ledgers.get(owner.owner)
    if (!ledger || ledger.id !== id) throw new TypeError('Original capture IO owner required')
    await Promise.allSettled([...ledger.pending])
    const results = await Promise.allSettled([...ledger.handles].map(resource => close(ledger, resource)))
    scope(id, owner)
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Original capture IO cleanup unresolved')
    ledger.settled = true
  }
  const prepareBootstrapCapture=(id:string,owner:IssuingFactOwner,value:Uint8Array)=>{const reservation=parseBootstrapCaptureReservation(value);return reserveCapture(id,owner,{protocol:'public',request:reservation.request},value)}
  return { readCapture, reserveCapture, readSelectedCapture, checkBootstrapCaptureRoot, readBootstrapCapture, prepareBootstrapCapture, settleBootstrapCaptureIO, prepareCapturedHeader, reconcileCapturedHeader }
}
