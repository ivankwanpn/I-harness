import { open, lstat, realpath, rename, readdir, link, unlink, mkdir } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { isMetadataData } from './metadata-data.ts'
export type RetireFile = (handle: FileHandle) => Promise<void>
export const retireFile = (handle: FileHandle, retire?: RetireFile): Promise<void> => retire ? retire(handle) : handle.close()

export async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number, current: () => boolean = () => true): Promise<void> {
  if (!Number.isSafeInteger(position + bytes.length) || position < 0) throw new Error('Artifact range overflow')
  for (let offset = 0; offset < bytes.length;) {
    if (!current()) throw new Error('Artifact metadata continuation stopped')
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset)
    if (result.bytesWritten <= 0) throw new Error('Artifact write made no progress')
    offset += result.bytesWritten
  }
}
const pendingPath = (path: string, bytes: Buffer) => `${path}.${createHash('sha256').update(bytes).digest('hex')}.pending`
export async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  if (!Number.isSafeInteger(position + length) || position < 0 || length < 0) throw new Error('Artifact range overflow')
  const bytes = Buffer.alloc(length)
  for (let offset = 0; offset < length;) {
    const result = await handle.read(bytes, offset, length - offset, position + offset)
    if (result.bytesRead <= 0) throw new Error('Artifact short read')
    offset += result.bytesRead
  }
  return bytes
}
export async function boundedJson(path: string, budget = 65536, retire?: RetireFile): Promise<unknown> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > budget) throw new Error('Invalid artifact metadata')
    return JSON.parse((await readExact(handle, info.size, 0)).toString('utf8'))
  } finally { await retireFile(handle, retire) }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length > 65536) throw new Error('Artifact metadata exceeds limit')
  // The exact record bytes name their original transaction. A rejected sync
  // or rename resumes this same temporary record instead of issuing another.
  const temporary = pendingPath(path, bytes)
  let existing: FileHandle | undefined
  try {
    existing = await open(path, 'r+')
    const info = await existing.stat()
    if (info.size > 65536) throw new Error('Artifact metadata corrupt')
    if (info.size === bytes.length && (await readExact(existing, info.size, 0)).equals(bytes)) { await existing.sync(); return }
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
  finally { await existing?.close() }
  let handle: FileHandle
  try { handle = await open(temporary, 'wx+') }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; handle = await open(temporary, 'r+') }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > bytes.length || info.size && !(await readExact(handle, info.size, 0)).equals(bytes.subarray(0, info.size))) throw new Error('Artifact metadata transaction conflict')
    await writeAll(handle, bytes.subarray(info.size), info.size)
    await handle.sync()
  } finally { await handle.close() }
  await rename(temporary, path)
}

/** Physical disposition only. Callers retain their own lifetime/policy checks.
 * A confirmed final can coexist with retained exact pending work; diagnostics
 * preserve that fact without performing cleanup during confirmation. */
export type ImmutableMetadataOutcome = { kind: 'confirmed' | 'absent' | 'unknown' | 'conflict' | 'not-issued'; diagnostics?: readonly string[] }
class MetadataConflict extends Error {}
function immutableBytes(value: unknown): Buffer {
  if (!isMetadataData(value)) throw new MetadataConflict('Artifact metadata is not strict data')
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new MetadataConflict('Artifact metadata unavailable')
  const bytes = Buffer.from(encoded)
  if (bytes.length > 65536) throw new MetadataConflict('Artifact metadata exceeds limit')
  return bytes
}
async function inspectImmutable(root: string, path: string, bytes: Buffer, retire?: RetireFile): Promise<{ final: boolean; pending: boolean }> {
  const temporary = pendingPath(path, bytes)
  try {
    if (resolve(dirname(path)) === resolve(root)) {
      const info = await lstat(root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Artifact path unavailable')
    } else await ownedPath(root, dirname(path))
  }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { final: false, pending: false }; throw cause }
  const prefix = basename(path) + '.'
  // All siblings in this transaction namespace are retained and accounted for,
  // including foreign hashes and malformed pending names.
  for (const name of await readdir(dirname(path))) {
    if (name.startsWith(prefix) && name.endsWith('.pending') && resolve(dirname(path), name) !== temporary) throw new MetadataConflict('Foreign artifact metadata transaction')
  }
  async function inspect(target: string, partial: boolean): Promise<boolean> {
    let handle: FileHandle | undefined
    try {
      await ownedPath(root, target); handle = await open(target, 'r')
      const info = await handle.stat()
      if (!info.isFile() || info.size > bytes.length || !partial && info.size !== bytes.length
        || !(await readExact(handle, info.size, 0)).equals(bytes.subarray(0, info.size))) throw new MetadataConflict('Immutable artifact metadata conflict')
      return true
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause }
    finally { if (handle) await retireFile(handle, retire) }
  }
  return { final: await inspect(path, false), pending: await inspect(temporary, true) }
}
async function syncImmutable(root: string, path: string, bytes: Buffer, retire?: RetireFile): Promise<string[]> {
  await ownedPath(root, path)
  // Windows FlushFileBuffers requires a writable handle; no bytes are written.
  const handle = await open(path, 'r+')
  let failure: unknown
  const diagnostics: string[] = []
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== bytes.length || !(await readExact(handle, info.size, 0)).equals(bytes)) throw new MetadataConflict('Immutable artifact metadata conflict')
    await handle.sync()
  } catch (cause) { failure = cause }
  try { await retireFile(handle, retire) }
  catch (cause) { diagnostics.push('Post-sync metadata handle cleanup: ' + (cause instanceof Error ? cause.message : String(cause))) }
  if (failure) throw failure
  return diagnostics
}
function confirmed(diagnostics: readonly string[]): ImmutableMetadataOutcome { return { kind: 'confirmed', ...(diagnostics.length ? { diagnostics } : {}) } }
function metadataFailure(cause: unknown): ImmutableMetadataOutcome { return { kind: cause instanceof MetadataConflict ? 'conflict' : 'unknown', diagnostics: [cause instanceof Error ? cause.message : String(cause)] } }
export async function confirmAtomicJson(root: string, path: string, value: unknown, retire?: RetireFile): Promise<ImmutableMetadataOutcome> {
  try {
    const bytes = immutableBytes(value), state = await inspectImmutable(root, path, bytes, retire)
    if (!state.final) return { kind: state.pending ? 'unknown' : 'absent' }
    const diagnostics = await syncImmutable(root, path, bytes, retire)
    if (state.pending) diagnostics.push('Retained exact pending metadata')
    return confirmed(diagnostics)
  } catch (cause) { return metadataFailure(cause) }
}
/** Run under the existing artifact mutation lease. Never replaces a known
 * conflicting final or pending file. Each create/write/link/unlink checks current
 * after the immediately preceding await; partial issuance remains unknown. */
export async function continueAtomicJson(root: string, path: string, value: unknown, current: () => boolean, retire?: RetireFile): Promise<ImmutableMetadataOutcome> {
  try {
    const bytes = immutableBytes(value), temporary = pendingPath(path, bytes), state = await inspectImmutable(root, path, bytes, retire)
    if (state.final) {
      const diagnostics = await syncImmutable(root, path, bytes, retire)
      if (state.pending) diagnostics.push('Retained exact pending metadata')
      return confirmed(diagnostics)
    }
    if (!current()) return { kind: state.pending ? 'unknown' : 'not-issued' }
    let handle: FileHandle
    try { handle = await open(temporary, 'wx+') }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      await ownedPath(root, temporary)
      handle = await open(temporary, 'r+')
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > bytes.length || !(await readExact(handle, info.size, 0)).equals(bytes.subarray(0, info.size))) throw new MetadataConflict('Immutable artifact metadata transaction conflict')
      await writeAll(handle, bytes.subarray(info.size), info.size, current)
      if (!current()) return { kind: 'unknown' }
      await handle.sync()
    } finally { await retireFile(handle, retire) }
    const beforePublication = await inspectImmutable(root, path, bytes, retire)
    if (beforePublication.final) return confirmed([...(await syncImmutable(root, path, bytes, retire)), 'Retained exact pending metadata'])
    if (!current()) return { kind: 'unknown' }
    // link is atomic and refuses an existing destination. Unlike rename it
    // cannot clobber a final inserted after the preceding absence check.
    // Unsupported links have no overwriting fallback; pending work survives.
    try { await link(temporary, path) }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      const state = await inspectImmutable(root, path, bytes, retire)
      if (!state.final) return { kind: 'unknown' }
    }
    const diagnostics = await syncImmutable(root, path, bytes, retire)
    const finalState = await inspectImmutable(root, path, bytes, retire)
    if (!finalState.final) return { kind: 'unknown', diagnostics: [...diagnostics, 'Final metadata disappeared before cleanup'] }
    // Cleanup never changes an already confirmed physical final into absence
    // or policy denial. Preserve cleanup uncertainty as diagnostic information.
    try {
      if (!current()) diagnostics.push('Retained exact pending metadata after currentness changed')
      else if (finalState.pending) await unlink(temporary)
    } catch (cause) { diagnostics.push('Retained metadata cleanup: ' + (cause instanceof Error ? cause.message : String(cause))) }
    return confirmed(diagnostics)
  } catch (cause) { return metadataFailure(cause) }
}
/** All path components are checked before opening authoritative bytes. */
export async function ownedPath(root: string, path: string): Promise<void> {
  const base = resolve(root), target = resolve(path)
  if (!target.startsWith(base + sep)) throw new Error('Artifact path unavailable')
  let current = target
  while (current !== base) {
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error('Artifact path unavailable')
    current = dirname(current)
  }
  const resolved = await realpath(target), realBase = await realpath(base)
  if (!resolved.startsWith(realBase + sep)) throw new Error('Artifact path unavailable')
}
/** Validate each existing ancestor before creating the next owned component. */
export async function ownedMkdir(root: string, path: string, guard: () => void): Promise<void> {
  const base = resolve(root), target = resolve(path)
  if (!target.startsWith(base + sep)) throw Error('Artifact path unavailable')
  const parents: string[] = []
  for (let current = target; current !== base; current = dirname(current)) parents.push(current)
  for (const current of parents.reverse()) {
    if (dirname(current) !== base) await ownedPath(base, dirname(current))
    guard()
    try { await mkdir(current) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    guard(); await ownedPath(base, current); guard()
    if (!(await lstat(current)).isDirectory()) throw Error('Artifact directory unavailable')
    guard()
  }
}
