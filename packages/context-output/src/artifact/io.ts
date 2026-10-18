import { open, lstat, realpath, rename } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'

export async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  if (!Number.isSafeInteger(position + bytes.length) || position < 0) throw new Error('Artifact range overflow')
  for (let offset = 0; offset < bytes.length;) {
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset)
    if (result.bytesWritten <= 0) throw new Error('Artifact write made no progress')
    offset += result.bytesWritten
  }
}
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
export async function boundedJson(path: string, budget = 65536): Promise<unknown> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > budget) throw new Error('Invalid artifact metadata')
    return JSON.parse((await readExact(handle, info.size, 0)).toString('utf8'))
  } finally { await handle.close() }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length > 65536) throw new Error('Artifact metadata exceeds limit')
  // The exact record bytes name their original transaction. A rejected sync
  // or rename resumes this same temporary record instead of issuing another.
  const temporary = `${path}.${createHash('sha256').update(bytes).digest('hex')}.pending`
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
