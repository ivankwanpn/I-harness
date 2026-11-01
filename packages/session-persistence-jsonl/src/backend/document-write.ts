import { randomUUID } from 'node:crypto'
import { link, lstat, open, rename, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import type { TaskDocumentAck, TaskDocumentWrite, TaskWriteOutcome } from '@i-harness/session-persistence'
async function publishDocument(temp: string, path: string, mode: 'replace' | 'initialize') { if (mode === 'replace') await rename(temp, path); else await link(temp, path) }

/** Original generic document publication; owned operations will share this owner. */
export async function writeLegacyDocument(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(data) + '\n', { encoding: 'utf-8' })
  await publishDocument(tmp, path, 'replace')
}

type Identity = { dev: bigint; ino: bigint }
type Resource = { handle: FileHandle; close: FileHandle['close']; failed: boolean; cause?: unknown }
const sameIdentity = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino
const meaningful = (value: Identity) => typeof value.dev === 'bigint' && typeof value.ino === 'bigint' && value.ino > 0n
class Conflict extends Error {}
/** One retained candidate. Replacement excludes cooperative writers via the original lease. */
export function createOwnedDocumentWrite(input: { path: string; bytes: Uint8Array; preimage?: { bytes: Uint8Array; identity: Identity }; maxBytes?: number | null; guard(): void; verifyRoot(): Promise<void> }) {
  if (input.maxBytes !== null && input.bytes.byteLength > (input.maxBytes ?? 64 * 1024 * 1024)) throw new RangeError('Task document too large')
  if (input.preimage && !meaningful(input.preimage.identity)) throw new Error('Task document identity unavailable')
  const bytes = Buffer.from(input.bytes), before = input.preimage && { bytes: Buffer.from(input.preimage.bytes), identity: input.preimage.identity }, temp = `${input.path}.${randomUUID()}.tmp`
  const resources = new Set<Resource>()
  let tempIdentity: Identity | undefined, phase: 'staged'|'temp'|'closed'|'issued'|'published'|'acknowledged' = 'staged', result: TaskWriteOutcome | undefined, issueFlight: Promise<TaskWriteOutcome> | undefined, active: Promise<TaskWriteOutcome> | undefined, reconcileFlight: Promise<TaskWriteOutcome> | undefined, ack: TaskDocumentAck | undefined, terminal = false, tempCleanupPending = false
  const guard = () => input.guard()
  async function closeResource(resource: Resource) {
    if (resource.failed && resource.handle.fd < 0) throw resource.cause
    try { await Reflect.apply(resource.close, resource.handle, []); resources.delete(resource) } catch (error) { resource.failed = true; resource.cause = error; throw error }
  }
  let cleanupFlight: Promise<void> | undefined
  function settleResources(): Promise<void> {
    if (cleanupFlight) return cleanupFlight
    const pending = Promise.resolve().then(cleanupResources)
    cleanupFlight = pending
    void pending.then(() => { if (cleanupFlight === pending) cleanupFlight = undefined }, () => { if (cleanupFlight === pending) cleanupFlight = undefined })
    return pending
  }
  async function cleanupResources() {
    let failed = false, cause: unknown; for (const resource of resources) try { await closeResource(resource) } catch (error) { if (!failed) { failed = true; cause = error } }; if (failed) throw cause
    if (tempCleanupPending) {
      try { const stat = await lstat(temp, { bigint: true }); if (!tempIdentity || !sameIdentity(stat, tempIdentity)) throw new Conflict(); await unlink(temp) }
      catch (error) { if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') throw error }
      tempCleanupPending = false
    }
    if (result?.kind === 'committed' && result.cleanupPending) result = Object.freeze({ ...result, cleanupPending: false })
  }
  async function openOwned(path: string, flags: 'wx'|'r+'|'r') { guard(); const handle = await open(path, flags), resource = { handle, close: handle.close, failed: false }; resources.add(resource); return resource }
  async function usingResource<T>(resource: Resource, work: () => Promise<T>): Promise<T> {
    let result: T | undefined, failed = false, cause: unknown
    try { result = await work() } catch (error) { failed = true; cause = error }
    try { await closeResource(resource) } catch (error) { if (failed) throw new AggregateError([cause, error], 'Task write and close failed'); throw error }
    if (failed) throw cause
    return result as T
  }
  async function readBounded(resource: Resource, identity: Identity, limit: number) {
    guard(); const before = await resource.handle.stat({ bigint: true }); guard()
    if (!before.isFile() || !sameIdentity(before, identity) || before.size < 0n || before.size > BigInt(limit)) throw new Conflict()
    const buffer = Buffer.alloc(limit + 1); let offset = 0
    while (offset < buffer.length) {
      guard()
      const read = await resource.handle.read(buffer, offset, Math.min(65536, buffer.length - offset), offset); guard()
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await resource.handle.stat({ bigint: true }); guard()
    if (!sameIdentity(after, identity) || after.size !== before.size || offset !== Number(before.size) || offset > limit) throw new Conflict()
    return buffer.subarray(0, offset)
  }
  async function readOwned(path: string, identity: Identity, limit: number) {
    const resource = await openOwned(path, 'r')
    const value = await usingResource(resource, () => readBounded(resource, identity, limit))
    guard(); return value
  }
  async function exact(path: string, expected: Uint8Array, identity: Identity) {
    guard(); await input.verifyRoot(); guard(); const stat = await lstat(path, { bigint: true }); guard(); if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, identity) || stat.size !== BigInt(expected.byteLength)) throw new Conflict()
    const data = await readOwned(path, identity, expected.byteLength); guard(); const after = await lstat(path, { bigint: true }); guard(); if (!sameIdentity(after, identity) || after.size !== BigInt(expected.byteLength) || !data.equals(Buffer.from(expected))) throw new Conflict()
  }
  async function confirmCandidate(): Promise<TaskWriteOutcome> {
    if (!tempIdentity) throw new Error('Original candidate identity unavailable')
    await exact(input.path, bytes, tempIdentity)
    const resource = await openOwned(input.path, 'r+')
    let failed = false, cause: unknown
    try { guard(); const data = await readBounded(resource, tempIdentity, bytes.length); guard(); if (!data.equals(bytes)) throw new Conflict(); guard(); await resource.handle.sync(); guard(); await exact(input.path, bytes, tempIdentity); ack ??= Object.freeze({}) as TaskDocumentAck; phase = 'acknowledged'; result = Object.freeze({ kind: 'committed', ack, durability: 'file-synced-process-restart-v1', cleanupPending: false }) } catch (error) { failed = true; cause = error }
    try { await closeResource(resource) } catch (error) { if (result?.kind === 'committed') result = Object.freeze({ ...result, cleanupPending: true }); else if (failed) throw new AggregateError([cause, error], 'Task confirmation and close failed'); else throw error }
    if (failed) throw cause
    return result!
  }
  async function inspectFinal(): Promise<'candidate'|'preimage'|'absent'> {
    try { guard(); const stat = await lstat(input.path, { bigint: true }); guard(); if (tempIdentity && sameIdentity(stat, tempIdentity)) { await exact(input.path, bytes, tempIdentity); return 'candidate' }; if (before && sameIdentity(stat, before.identity)) { await exact(input.path, before.bytes, before.identity); return 'preimage' }; throw new Conflict() }
    catch (error) { if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') return 'absent'; throw error }
  }
  async function attempt(publish: boolean): Promise<TaskWriteOutcome> {
    try {
      guard(); if (!publish && (resources.size || tempCleanupPending)) return result = Object.freeze({ kind: 'unknown', cause: new Error('Original cleanup pending'), cleanupPending: true })
      if (publish) await settleResources(); guard(); await input.verifyRoot(); guard()
      if (terminal) return result!
      if (phase === 'issued' || phase === 'published') { const state = await inspectFinal(); if (state === 'candidate') { const outcome = await confirmCandidate(); if (!before) { tempCleanupPending = true; if (resources.size) result = Object.freeze({ ...outcome, cleanupPending: true }); else try { await settleResources() } catch { result = Object.freeze({ ...outcome, cleanupPending: true }) } }; return result! }; if (!publish) return result = Object.freeze({ kind: 'unknown', cause: new Error('Publication not observed'), cleanupPending: false }); if (state !== (before ? 'preimage' : 'absent')) throw new Conflict() }
      if (!publish) return result = Object.freeze({ kind: 'unknown', cause: new Error('No publication issued'), cleanupPending: false })
      if (phase === 'staged') { const resource = await openOwned(temp, 'wx'); phase = 'temp'; await usingResource(resource, async () => { guard(); tempIdentity = await resource.handle.stat({ bigint: true }); guard(); if (!meaningful(tempIdentity)) throw new Error('Task candidate identity unavailable'); let offset = 0; while (offset < bytes.length) { guard(); const write = await resource.handle.write(bytes, offset, bytes.length - offset, offset); guard(); if (!write.bytesWritten) throw new Error('Task write made no progress'); offset += write.bytesWritten }; await resource.handle.sync(); guard() }); phase = 'closed' }
      if (phase === 'temp') {
        if (!tempIdentity) throw new Error('Missing original temp identity')
        const stat = await lstat(temp, { bigint: true }); guard(); if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, tempIdentity) || stat.size > BigInt(bytes.length)) throw new Conflict()
        const current = await readOwned(temp, tempIdentity, bytes.length); if (current.length > bytes.length || !current.equals(bytes.subarray(0, current.length))) throw new Conflict()
        const resource = await openOwned(temp, 'r+'); await usingResource(resource, async () => { guard(); const stat = await resource.handle.stat({ bigint: true }); guard(); if (!sameIdentity(stat, tempIdentity!)) throw new Conflict(); let offset = current.length; while (offset < bytes.length) { guard(); const write = await resource.handle.write(bytes, offset, bytes.length - offset, offset); guard(); if (!write.bytesWritten) throw new Error('Task write made no progress'); offset += write.bytesWritten }; await resource.handle.sync(); guard() }); phase = 'closed'
      }
      if (!tempIdentity) throw new Error('Missing original temp identity')
      await exact(temp, bytes, tempIdentity)
      if (before) { try { await exact(input.path, before.bytes, before.identity) } catch (error) { if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') throw new Conflict(); throw error } }
      else { try { await lstat(input.path, { bigint: true }); guard(); throw new Conflict() } catch (error) { if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') throw error } }
      guard(); phase = 'issued'
      try { await publishDocument(temp, input.path, before ? 'replace' : 'initialize'); phase = 'published' }
      catch (error) { if (!before && (error as NodeJS.ErrnoException | null | undefined)?.code === 'EEXIST') throw new Conflict(); throw error }
      const outcome = await confirmCandidate()
      if (!before && outcome.kind === 'committed') { tempCleanupPending = true; if (resources.size) result = Object.freeze({ ...outcome, cleanupPending: true }); else try { await settleResources() } catch { result = Object.freeze({ ...outcome, cleanupPending: true }) } }
      return result!
    } catch (cause) {
      if (cause instanceof Conflict) { terminal = true; return result = Object.freeze({ kind: 'conflict', cleanupPending: resources.size > 0 }) }
      return result = Object.freeze({ kind: 'unknown', cause, cleanupPending: resources.size > 0 })
    }
  }
  const launch = (publish: boolean) => { if (active) return active; const pending = Promise.resolve().then(() => attempt(publish)); active = pending; void pending.then(() => { if (active === pending) active = undefined }, () => { if (active === pending) active = undefined }); return pending }
  const handle: TaskDocumentWrite = Object.freeze({
    issue() { if (this !== handle) return Promise.reject(new TypeError('Invalid write receiver')); if (active) return active; return issueFlight ??= launch(true) },
    reconcile() { if (this !== handle) return Promise.reject(new TypeError('Invalid write receiver')); if (active) return active; if (result?.kind === 'committed' || terminal) return Promise.resolve(result!); return reconcileFlight ??= launch(false) },
    retry() { if (this !== handle) return Promise.reject(new TypeError('Invalid write receiver')); if (active) return active; if (result?.kind === 'committed') { const pending = Promise.resolve().then(async () => { await settleResources(); return result! }); active = pending; void pending.then(() => { if (active === pending) active = undefined }, () => { if (active === pending) active = undefined }); return pending }; if (terminal) return Promise.resolve(result!); reconcileFlight = undefined; return launch(true) },
    outcome() { if (this !== handle) throw new TypeError('Invalid write receiver'); return result },
  })
  return { handle, async settle() { if (active) await active; await settleResources() } }
}
