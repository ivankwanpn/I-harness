import { open, lstat, link, rename, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { streamJsonData } from '@i-harness/core-session'
import { boundedJson, ownedPath, writeAll, retireFile, type RetireFile } from '../artifact/io.ts'
import { physicalIdentity, requireSpace } from '../artifact/quota.ts'
import { fields, data, same, hash, count } from './fork-codec.ts'

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const names = (path: string) => { const base = path.replace(/\.json$/, ''); return { journal: base + '.intent.json', rewrite: base + '.rewrite', previous: base + '.previous' } }
export async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (e) { if (absent(e)) return false; throw e } }
function* encode(owners: ReadonlySet<string>) {
  yield '['; let first = true
  for (const owner of owners) { if (!first) yield ','; first = false; yield* streamJsonData(owner, { dataOnly: true }) }
  yield ']'
}
export function ledgerIdentity(owners: ReadonlySet<string>) {
  const h = createHash('sha256').update('ih.legacy-owner-array.v1\0'); let bytes = 0
  for (const text of encode(owners)) { h.update(text); bytes += Buffer.byteLength(text); if (!Number.isSafeInteger(bytes)) throw Error('Owner ledger overflow') }
  return { digest: h.digest('hex'), count: owners.size, bytes }
}
/** Streaming JSON string-array reader; scratch space is one bounded owner ID. */
export async function readLedger(path: string, retire?: RetireFile): Promise<{ owners: Set<string>; capacity: number; identity: ReturnType<typeof ledgerIdentity> }> {
  const handle = await open(path, 'r'), owners = new Set<string>(), chunk = Buffer.alloc(8192)
  let state: 'start' | 'value' | 'string' | 'comma' | 'done' = 'start', escaped = false, token = '', position = 0, afterComma = false
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    const size = (await handle.stat()).size
    function consume(text: string) {
      for (const ch of text) {
        if (state === 'string') {
          token += ch
          if (token.length > 8192) throw Error('Invalid legacy owner identity')
          if (escaped) escaped = false
          else if (ch === '\\') escaped = true
          else if (ch === '"') {
            const owner = JSON.parse(token)
            if (typeof owner !== 'string' || !owner || Buffer.byteLength(owner) > 1024 || owners.has(owner)) throw Error('Invalid context owner ledger')
            owners.add(owner); state = 'comma'; token = ''
          }
        } else if (/^[\x20\t\r\n]$/.test(ch)) continue
        else if (state === 'start' && ch === '[') state = 'value'
        else if (state === 'value' && ch === '"') { state = 'string'; token = ch; afterComma = false }
        else if (state === 'value' && ch === ']' && !afterComma || state === 'comma' && ch === ']') state = 'done'
        else if (state === 'comma' && ch === ',') { state = 'value'; afterComma = true }
        else throw Error('Invalid context owner ledger')
      }
    }
    while (position < size) { const r = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position); if (!r.bytesRead) throw Error('Short owner ledger read'); position += r.bytesRead; consume(decoder.decode(chunk.subarray(0, r.bytesRead), { stream: true })) }
    consume(decoder.decode()); if ((state as string) !== 'done') throw Error('Incomplete owner ledger')
    return { owners, capacity: size, identity: ledgerIdentity(owners) }
  } finally { await retireFile(handle, retire) }
}
async function pad(path: string, capacity: number, appendOnly: boolean, current: () => void, retire?: RetireFile): Promise<void> {
  const h = await open(path, appendOnly ? 'r+' : 'wx+')
  try {
    const info = await h.stat({ bigint: true }); current(); requireOne(info)
    let offset = Number(info.size)
    if (offset > capacity) throw Error('Owner reserve capacity conflict')
    const spaces = Buffer.alloc(8192, 32)
    while (offset < capacity) { current(); const n = Math.min(spaces.length, capacity - offset); await writeAll(h, spaces.subarray(0, n), offset); current(); offset += n }
    await h.sync(); current()
    if ((await h.stat()).size !== capacity) throw Error('Owner reserve short allocation')
  } finally { await retireFile(h, retire) }
}
function requireOne(info: Awaited<ReturnType<typeof nativeInfo>>): string {
  const key = physicalIdentity(info)
  if (!key || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Unexpected owner file aliases or unreliable identity')
  return key
}
const nativeInfo = (path: string) => lstat(path, { bigint: true })
async function independent(path: string): Promise<string> { return requireOne(await nativeInfo(path)) }
async function predecessorPair(path: string, previous: string): Promise<void> {
  const [left, right] = await Promise.all([nativeInfo(path), nativeInfo(previous)])
  if (!physicalIdentity(left) || physicalIdentity(left) !== physicalIdentity(right) || left.nlink !== 2n || right.nlink !== 2n || !left.isFile() || !right.isFile() || left.isSymbolicLink() || right.isSymbolicLink()) throw Error('Unexpected predecessor aliases or identity')
}
async function reclaim(path: string, length: number, canonical: boolean, current: () => void, retire?: RetireFile): Promise<void> {
  const expected = await independent(path); current()
  const handle = await open(path, 'r+')
  try {
    const info = await handle.stat({ bigint: true }); current()
    if (requireOne(info) !== expected || info.size < BigInt(length)) throw Error('Original owner reclamation identity changed')
    if (canonical) {
      const chunk = Buffer.alloc(8192); let position = length
      while (position < Number(info.size)) {
        const result = await handle.read(chunk, 0, Math.min(chunk.length, Number(info.size) - position), position); current()
        if (!result.bytesRead || chunk.subarray(0, result.bytesRead).some(byte => ![9,10,13,32].includes(byte))) throw Error('Owner reclamation is not trailing JSON whitespace')
        position += result.bytesRead
      }
    }
    current(); await handle.truncate(length); await handle.sync(); current()
    const after = await handle.stat({ bigint: true }); current()
    if (requireOne(after) !== expected || after.size !== BigInt(length)) throw Error('Owner reclamation readback unknown')
  } finally { await retireFile(handle, retire) }
}
async function identities(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([lstat(a, { bigint: true }), lstat(b, { bigint: true })])
  const x = physicalIdentity(left), y = physicalIdentity(right)
  if (!x || !y || !left.isFile() || !right.isFile() || left.isSymbolicLink() || right.isSymbolicLink()) throw Error('Reliable hardlink identity unavailable')
  return x === y
}
const idle = { version: 1, kind: 'legacy-owner-idle' }
// Existing owner IDs are at most1024 UTF-8 bytes; internal operation prefixes
// add fewer than16 ASCII bytes. Finite safe counts/capacities have16 digits.
const largestIdentity = { digest: 'f'.repeat(64), count: Number.MAX_SAFE_INTEGER, bytes: Number.MAX_SAFE_INTEGER }
const JOURNAL_CAPACITY = Buffer.byteLength(JSON.stringify({ version: 1, kind: 'legacy-owner-rewrite', refId: 'ctx_' + 'f'.repeat(64), operation: '\u0001'.repeat(1040), prior: largestIdentity, next: largestIdentity, capacity: Number.MAX_SAFE_INTEGER }))
function fundingGrowth(priorCapacity: number, nextBytes: number, reserve: number, journalPresent: boolean) {
  const capacity = Math.max(priorCapacity, nextBytes)
  const additionalBytes = capacity - priorCapacity + Math.max(0, capacity - reserve) + (journalPresent ? 0 : JOURNAL_CAPACITY)
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw Error('Owner funding allocation overflow')
  return { capacity, additionalBytes }
}
async function readIntent(path: string, retire?: RetireFile): Promise<Intent | undefined> {
  if (!await exists(path)) return undefined
  const info = await nativeInfo(path); requireOne(info)
  if (info.size !== BigInt(JOURNAL_CAPACITY)) throw Error('Original owner journal capacity conflict')
  const value = await boundedJson(path, 65536, retire); data(value)
  if ((value as typeof idle).kind === idle.kind) { fields(value, ['version', 'kind']); if (value.version !== 1) throw Error('Invalid owner journal'); return undefined }
  fields(value, ['version', 'kind', 'refId', 'operation', 'prior', 'next', 'capacity'])
  const intent = value as Intent
  if (intent.version !== 1 || intent.kind !== 'legacy-owner-rewrite' || intent.refId !== basename(path, '.intent.json') || typeof intent.operation !== 'string' || !intent.operation || intent.operation.length > 1040 || !count(intent.capacity)) throw Error('Invalid owner journal')
  for (const identity of [intent.prior, intent.next]) { fields(identity, ['digest', 'count', 'bytes']); if (!hash(identity.digest) || !count(identity.count) || !count(identity.bytes) || identity.bytes > intent.capacity) throw Error('Invalid owner journal identity') }
  return intent
}
async function writeIntent(path: string, value: Intent | typeof idle, current: () => void, retire?: RetireFile): Promise<void> {
  const body = Buffer.from(JSON.stringify(value)); if (body.length > JOURNAL_CAPACITY) throw Error('Owner journal capacity exceeded')
  const wanted = Buffer.concat([body, Buffer.alloc(JOURNAL_CAPACITY - body.length, 32)])
  const handle = await open(path, 'r+')
  try {
    const info = await handle.stat({ bigint: true }); requireOne(info)
    if (info.size !== BigInt(JOURNAL_CAPACITY)) throw Error('Original owner journal funding unavailable')
    current(); await writeAll(handle, wanted, 0, () => { current(); return true }); current(); await handle.sync(); current()
    const readback = Buffer.alloc(JOURNAL_CAPACITY); let offset = 0
    while (offset < readback.length) { const r = await handle.read(readback, offset, readback.length - offset, offset); current(); if (!r.bytesRead) throw Error('Owner journal short read'); offset += r.bytesRead }
    if (!readback.equals(wanted)) throw Error('Owner journal readback failed')
  } finally { await retireFile(handle, retire) }
}
export class OwnerLedger {
  constructor(private readonly root: string, private readonly retire?: RetireFile) {}
  private read(path: string) { return readLedger(path, this.retire) }
  async tracked(path: string) { const p = names(path); return await exists(p.rewrite) || await exists(p.journal) || await exists(p.previous) }
  /** Prospective capture description only; never recovers or funds a prefix. */
  async describeFunding(path: string, next: ReadonlySet<string>, operation: string, current: () => void): Promise<{ additionalBytes: number }> {
    await ownedPath(this.root, path); current()
    const { journal, rewrite, previous } = names(path), pending = await readIntent(journal, this.retire)
    const prior = await this.read(path); current()
    if (pending) {
      if (!same(prior.identity, pending.prior) || !same(ledgerIdentity(next), pending.next) || operation !== pending.operation) throw Error('Original owner rewrite unresolved')
      if (!await exists(rewrite) || (await lstat(rewrite)).size < pending.capacity) throw Error('Original owner reserve missing')
      if (await exists(previous)) await predecessorPair(path, previous); else await independent(path)
      await independent(rewrite); current()
      throw Error('Original owner rewrite unresolved')
    }
    if (await exists(previous)) throw Error('Original predecessor phase unresolved')
    await independent(path); current()
    const present = await exists(rewrite)
    if (present) { await independent(rewrite); if (await identities(path, rewrite)) throw Error('Rewrite aliases canonical'); current() }
    return { additionalBytes: fundingGrowth(prior.capacity, ledgerIdentity(next).bytes, present ? (await lstat(rewrite)).size : 0, await exists(journal)).additionalBytes }
  }
  async fund(path: string, next: ReadonlySet<string>, quota: number, current: () => void, operation: string): Promise<void> {
    await ownedPath(this.root, path); current()
    const { journal, rewrite, previous } = names(path)
    const pending = await readIntent(journal, this.retire)
    if (pending) {
      const actual = await this.read(path)
      if (same(actual.identity, pending.next)) await this.recover(path)
      else {
        if (!same(actual.identity, pending.prior) || !same(ledgerIdentity(next), pending.next) || operation !== pending.operation) throw Error('Original owner rewrite unresolved')
        if (!await exists(rewrite) || (await lstat(rewrite)).size < pending.capacity) throw Error('Original owner reserve missing')
        if (await exists(previous)) await predecessorPair(path, previous); else await independent(path)
        await independent(rewrite); current()
        return
      }
    }
    const prior = await this.read(path); current()
    const capacity = Math.max(prior.capacity, ledgerIdentity(next).bytes)
    if (await exists(previous)) throw Error('Original predecessor phase unresolved')
    await independent(path); current()
    if (await exists(rewrite)) { await independent(rewrite); current() }
    const reserve = await exists(rewrite) ? (await lstat(rewrite)).size : 0
    const intent: Intent = { version: 1, kind: 'legacy-owner-rewrite', refId: basename(path, '.json'), operation, prior: prior.identity, next: ledgerIdentity(next), capacity }
    const journalBytes = await exists(journal) ? 0 : JOURNAL_CAPACITY
    await requireSpace(this.root, quota, fundingGrowth(prior.capacity, ledgerIdentity(next).bytes, reserve, !journalBytes).additionalBytes); current()
    // A physical hardlink on the actual canonical file is the setup proof.
    await link(path, previous); current()
    await predecessorPair(path, previous); current()
    await unlink(previous); current()
    await pad(path, capacity, true, current, this.retire); current()
    if (await exists(rewrite)) {
      if (await identities(path, rewrite)) throw Error('Rewrite aliases canonical')
      await pad(rewrite, capacity, true, current, this.retire)
    } else await pad(rewrite, capacity, false, current, this.retire)
    const readback = await this.read(path); current()
    if (!same(readback.identity, prior.identity) || readback.capacity !== capacity || (await lstat(rewrite)).size !== capacity) throw Error('Owner funding readback failed')
    if (journalBytes) {
      await pad(journal, JOURNAL_CAPACITY, false, current, this.retire); current()
    }
    await writeIntent(journal, same(prior.identity, intent.next) ? idle : intent, current, this.retire); current()
  }
  /** Recover only committed storage effects, never an absent next owner set. */
  async recover(path: string): Promise<void> {
    const { journal, rewrite, previous } = names(path), intent = await readIntent(journal, this.retire); if (!intent) return
    const actual = await this.read(path)
    if (!same(actual.identity, intent.next)) throw Error('Original owner rewrite is incomplete')
    await independent(path)
    if (actual.capacity > intent.capacity || actual.capacity < intent.next.bytes) throw Error('Original owner canonical capacity conflict')
    if (await exists(previous)) {
      if (await identities(path, previous) || await exists(rewrite)) throw Error('Ambiguous predecessor identity')
      const old = await this.read(previous)
      if (!same(old.identity, intent.prior) || old.capacity !== intent.capacity) throw Error('Foreign predecessor')
      await independent(previous)
      await rename(previous, rewrite)
    }
    if (!await exists(rewrite) || await identities(path, rewrite) || (await lstat(rewrite)).size < actual.capacity) throw Error('Owner reserve unavailable')
    await independent(rewrite)
    // Canonical first, then the independent already-funded old inode. Recovery
    // finishes a cut between these two truncations without allocating bytes.
    if (actual.capacity > intent.next.bytes) await reclaim(path, intent.next.bytes, true, () => {}, this.retire)
    if ((await lstat(rewrite)).size > intent.next.bytes) await reclaim(rewrite, intent.next.bytes, false, () => {}, this.retire)
    await writeIntent(journal, idle, () => {}, this.retire)
  }
  async replace(path: string, next: ReadonlySet<string>, operation: string, current: () => void): Promise<void> {
    await ownedPath(this.root, path); current()
    const { journal, rewrite, previous } = names(path)
    const actual = await this.read(path); current()
    const desired = ledgerIdentity(next)
    const old = await readIntent(journal, this.retire)
    if (old) {
      if (same(actual.identity, old.next)) { await this.recover(path); current(); if (same(actual.identity, desired)) return; return this.replace(path, next, operation, current) }
      if (!same(old.prior, actual.identity) || !same(old.next, desired) || old.operation !== operation) throw Error('Original owner rewrite conflicts')
    }
    if (same(actual.identity, desired)) return
    if (await exists(previous)) { if (!old) throw Error('Unknown predecessor phase'); await predecessorPair(path, previous) }
    else await independent(path)
    const capacity = actual.capacity
    if (desired.bytes > capacity || !await exists(rewrite) || (await lstat(rewrite)).size < capacity || await identities(path, rewrite)) throw Error('Owner rewrite not funded')
    const scratch = await independent(rewrite); current()
    const intent: Intent = { version: 1, kind: 'legacy-owner-rewrite', refId: basename(path, '.json'), operation, prior: actual.identity, next: desired, capacity }
    await writeIntent(journal, intent, current, this.retire); current()
    if (!await exists(previous)) { await link(path, previous); current() }
    await predecessorPair(path, previous); current()
    const h = await open(rewrite, 'r+')
    try {
      const info = await h.stat({ bigint: true }); current()
      if (requireOne(info) !== scratch || info.size !== BigInt(capacity)) throw Error('Original scratch identity/capacity changed')
      let offset = 0
      for (const text of encode(next)) { current(); const bytes = Buffer.from(text); await writeAll(h, bytes, offset); current(); offset += bytes.length }
      const spaces = Buffer.alloc(8192, 32)
      while (offset < capacity) { current(); const n = Math.min(capacity - offset, spaces.length); await writeAll(h, spaces.subarray(0, n), offset); current(); offset += n }
      await h.sync(); current()
    } finally { await retireFile(h, this.retire) }
    if (!same((await this.read(rewrite)).identity, desired)) throw Error('Owner rewrite readback failed')
    current(); await rename(rewrite, path); current()
    if (!same((await this.read(path)).identity, desired) || await identities(path, previous)) throw Error('Owner replacement unknown')
    await independent(path); await independent(previous); current()
    await rename(previous, rewrite); current()
    if (!same((await this.read(rewrite)).identity, actual.identity)) throw Error('Owner reserve restoration failed')
    // Only verified trailing JSON whitespace is reclaimed, canonical first.
    if (desired.bytes < capacity) {
      await reclaim(path, desired.bytes, true, current, this.retire)
      await reclaim(rewrite, desired.bytes, false, current, this.retire)
    }
    await writeIntent(journal, idle, current, this.retire); current()
  }
}
interface Intent { version: 1; kind: 'legacy-owner-rewrite'; refId: string; operation: string; prior: ReturnType<typeof ledgerIdentity>; next: ReturnType<typeof ledgerIdentity>; capacity: number }
