import { createHash } from 'node:crypto'
import { lstat, open, opendir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ownedPath } from '../artifact/io.ts'
import { physicalIdentity } from '../artifact/quota.ts'
import { failuresTogether } from '../workspace-mutation.ts'
import type { ContextStore } from '../store.ts'

const absent = (failure: unknown) => (failure as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT'
const frame = (...values: string[]) => values.map(value => `${Buffer.byteLength(value)}:${value}`).join('')

/** Actual bytes, never timestamps. Every native reader uses the original store debt. */
export async function originalFileWitness(store: ContextStore, path: string, guard: () => void): Promise<string> {
  guard(); await ownedPath(store.directory, path); guard()
  const handle = await open(path, 'r'), failures: unknown[] = []
  let result!: string
  try {
    const info = await handle.stat({ bigint: true }); guard()
    const identity = physicalIdentity(info)
    if (!identity || !info.isFile() || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Original file identity unavailable')
    const hash = createHash('sha256'), chunk = Buffer.alloc(65536)
    let offset = 0
    while (offset < Number(info.size)) {
      const read = await handle.read(chunk, 0, Math.min(chunk.length, Number(info.size) - offset), offset); guard()
      if (!read.bytesRead) throw Error('Original witness short read')
      hash.update(chunk.subarray(0, read.bytesRead)); offset += read.bytesRead
    }
    const after = await lstat(path, { bigint: true }); guard()
    if (!after.isFile() || after.isSymbolicLink() || physicalIdentity(after) !== identity || after.size !== info.size || after.nlink !== info.nlink) throw Error('Original witness identity changed')
    result = frame(identity, String(info.nlink), String(info.size), hash.digest('hex'))
  } catch (failure) { failures.push(failure) }
  try { await store.retireLegacyFile(handle) } catch (failure) { failures.push(failure) }
  failuresTogether(failures, 'Original witness read and cleanup failed'); guard(); return result
}

/** Only caller-selected original namespaces; callers never include blobs or SQLite. */
export async function originalNamespaceWitness(store: ContextStore, namespaces: readonly string[], guard: () => void): Promise<string> {
  const hash = createHash('sha256').update('ih.legacy-original-inventory.v1\0')
  async function walk(path: string, name: string): Promise<void> {
    guard()
    let info
    try { info = await lstat(path, { bigint: true }) } catch (failure) { if (absent(failure)) { hash.update(frame(name, 'absent')); return }; throw failure }
    guard(); await ownedPath(store.directory, path); guard()
    if (info.isFile()) { hash.update(frame(name, 'file', await originalFileWitness(store, path, guard))); return }
    if (!info.isDirectory() || info.isSymbolicLink() || !physicalIdentity(info)) throw Error('Original namespace identity unavailable')
    const directory = await opendir(path), failures: unknown[] = [], names: string[] = []
    try { for (;;) { const entry = await directory.read(); guard(); if (!entry) break; names.push(entry.name) } }
    catch (failure) { failures.push(failure) }
    try { await store.retireLegacyDirectory(directory) } catch (failure) { failures.push(failure) }
    failuresTogether(failures, 'Original namespace read and cleanup failed'); guard()
    hash.update(frame(name, 'directory', physicalIdentity(info)!))
    for (const child of names.sort()) await walk(resolve(path, child), `${name}/${child}`)
  }
  for (const name of namespaces) await walk(resolve(store.directory, name), name)
  return hash.digest('hex')
}
