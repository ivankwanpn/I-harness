import { open, readdir, rename, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { canonicalJsonData } from '@i-harness/core-session'
import { isHeldFactOwner, captureBootstrapCaptureRequest, parseBootstrapCaptureReservation, encodeBootstrapCaptureReservation, parseBootstrapHeaderStage, rawHeaderDigest, type HeldFactOwner, type IssuingFactOwner, type BootstrapCaptureInspection, type BootstrapCaptureRequest, type BootstrapCaptureReserveOutcome, type BootstrapHeaderOperation, type HeaderOutcome } from '@i-harness/session-persistence'
import { bootstrapPaths } from './bootstrap-header.ts'

/** Namespace discovery is deliberately broader than the owned deletion inventory. */
export async function bootstrapNamespace(path: string): Promise<string[]> {
  const prefix = basename(path) + '.bootstrap-'
  return (await readdir(dirname(path))).filter(name => name.startsWith(prefix))
}
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
  async function readBootstrapCapture(id: string, owner: HeldFactOwner, input: BootstrapCaptureRequest): Promise<BootstrapCaptureInspection> {
    const request = captureBootstrapCaptureRequest(input)
    if (id !== request.invocation.targetSessionId) throw new TypeError('Capture target mismatch')
    return tracked(id, owner, async ledger => {
      const guard = () => scope(id, owner), path = filePath(id), paths = bootstrapPaths(path, request.invocation)
      try {
        guard(); await checkBootstrapCaptureRoot(); guard(); await assertNotDeleted('session', id); guard()
        const siblings = await bootstrapNamespace(path); guard()
        const known = new Set([basename(paths.stage), basename(paths.promote), basename(paths.publish)])
        if (siblings.some(name => !/^[a-f0-9]{64}\.(stage|promote|publish)$/.test(name.slice((basename(path) + '.bootstrap-').length)))) return { kind: 'unavailable' }
        if (siblings.some(name => !known.has(name))) return { kind: 'conflict' }
        const stage = await bytes(ledger, paths.stage, 262144, guard), promote = await bytes(ledger, paths.promote, 262144, guard), publish = await bytes(ledger, paths.publish, 65536, guard)
        // Presence of an ordinary target also fences an empty/foreign target.
        let target = false
        try { await stat(path); target = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        guard(); await assertNotDeleted('session', id); await checkBootstrapCaptureRoot(); guard()
        if (stage !== undefined) {
          try {
            const reservation = parseBootstrapCaptureReservation(stage)
            if (canonicalJsonData(reservation.request) !== canonicalJsonData(request)) return { kind: 'conflict' }
            if (target || publish !== undefined) return { kind: 'unavailable' }
            if (promote !== undefined) { const full = parseBootstrapHeaderStage(promote); if (canonicalJsonData(full.captureReservation) !== canonicalJsonData(reservation)) return { kind: 'conflict' } }
            return { kind: 'reserved', reservation }
          } catch {
            if(promote!==undefined)return {kind:'unavailable'}
            try { const full = parseBootstrapHeaderStage(stage); return canonicalJsonData(full.invocation) === canonicalJsonData(request.invocation) && (!full.captureReservation || canonicalJsonData(full.captureReservation.request) === canonicalJsonData(request)) ? { kind: 'materialized' } : { kind: 'conflict' } } catch { return { kind: 'unavailable' } }
          }
        }
        if (target || promote !== undefined || publish !== undefined) return { kind: 'unavailable' }
        return { kind: 'absent' }
      } catch (error) {
        ledger.diagnostics.push(error)
        // Resource cleanup errors cannot be converted to usable routing facts.
        if (ledger.handles.size) throw error
        return { kind: 'unavailable' }
      }
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
  async function prepareBootstrapCapture(id: string, owner: IssuingFactOwner, reservationBytes: Uint8Array): Promise<BootstrapCaptureReserveOutcome> {
    const reservation = parseBootstrapCaptureReservation(reservationBytes)
    if (reservation.request.invocation.targetSessionId !== id) throw new TypeError('Capture target mismatch')
    return tracked(id, owner, async ledger => {
      let issued = false
      const guard = () => scope(id, owner)
      try {
        await checkBootstrapCaptureRoot(); await assertNotDeleted('session', id); guard()
        const paths = bootstrapPaths(filePath(id), reservation.request.invocation)
        // Recheck the complete namespace immediately before the exclusive issue.
        const state = await readBootstrapCapture(id, owner, reservation.request)
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
        if (code === 'EEXIST') { const actual = await readBootstrapCapture(id, owner, reservation.request); return { kind: actual.kind === 'reserved' ? 'present' : actual.kind === 'conflict' ? 'conflict' : 'unknown' } }
        return { kind: 'unknown' }
      }
    })
  }
  async function prepareCapturedHeader(id: string, owner: IssuingFactOwner, operation: BootstrapHeaderOperation): Promise<HeaderOutcome> {
    const full = parseBootstrapHeaderStage(operation.stageBytes), reservation = full.captureReservation!
    return tracked(id, owner, async ledger => {
      const path = filePath(id), paths = bootstrapPaths(path, operation.invocation), guard = () => scope(id, owner)
      try {
        await checkBootstrapCaptureRoot(); await assertNotDeleted('session', id); guard()
        const siblings = await bootstrapNamespace(path)
        if (siblings.some(name => name !== basename(paths.stage) && name !== basename(paths.promote))) return { kind: 'conflict' }
        const stage = await bytes(ledger, paths.stage, 262144, guard)
        if (!stage) return { kind: 'unknown' }
        if (!stage.equals(Buffer.from(operation.stageBytes))) {
          if (!stage.equals(Buffer.from(encodeBootstrapCaptureReservation(reservation)))) return { kind: 'conflict' }
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
      const path=filePath(id),paths=bootstrapPaths(path,operation.invocation),guard=()=>scope(id,owner)
      try {
        await checkBootstrapCaptureRoot();await assertNotDeleted('session',id);guard()
        const siblings=await bootstrapNamespace(path)
        if(siblings.some(name=>name!==basename(paths.stage)&&name!==basename(paths.promote)))return {kind:'conflict'}
        const stage=await bytes(ledger,paths.stage,262144,guard)
        if(!stage)return {kind:'unknown'}
        if(!stage.equals(Buffer.from(operation.stageBytes))) {
          const reservation=parseBootstrapCaptureReservation(stage),expected=parseBootstrapHeaderStage(operation.stageBytes).captureReservation
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
  return { checkBootstrapCaptureRoot, readBootstrapCapture, prepareBootstrapCapture, settleBootstrapCaptureIO, prepareCapturedHeader, reconcileCapturedHeader }
}
