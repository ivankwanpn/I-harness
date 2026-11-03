import assert from 'node:assert/strict'
import fs, { type FileHandle } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export const cuts = ['body-sync', 'leaves-sync', 'index-sync', 'staged-rename', 'manifest-rename', 'first-pin', 'first-access', 'committed-rename', 'second-pin', 'second-access'] as const
export type Cut = typeof cuts[number]
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export interface Transition { cut: Cut; path: string; native: 'sync' | 'rename'; success: true; transaction?: string; text?: string }

/** Each wrapper delegates the real syscall first. No fabricated disk failure. */
export async function installPublicationProbe(parent: string, taskDocument: string, onTransition: (row: Transition) => Promise<void>) {
  const nativeOpen = fs.open, nativeRename = fs.rename
  const paths = new WeakMap<FileHandle, string>()
  const probe = await nativeOpen(resolve(process.env.IH_CONFIG_DIR!, 'native-probe'), 'w+')
  const prototype = Object.getPrototypeOf(probe) as FileHandle, nativeSync = prototype.sync
  await probe.close()
  const transitions: Transition[] = []
  let selectedDirectory: string | undefined
  const seen = async (row: Transition) => { transitions.push(row); await onTransition(row) }
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await nativeOpen(...args)
    paths.set(handle, resolve(String(args[0])))
    return handle
  }) as typeof fs.open
  prototype.sync = async function (this: FileHandle) {
    await nativeSync.call(this)
    const path = paths.get(this)
    if (!path || !path.replaceAll('\\', '/').includes('/managed-v1/ctxv1_')) return
    const name = basename(path)
    if (!['body', 'leaves', 'index'].includes(name)) return
    selectedDirectory ??= dirname(path)
    assert.equal(dirname(path), selectedDirectory, 'one actual original artifact')
    await seen({ cut: `${name}-sync` as Cut, path, native: 'sync', success: true })
  }
  fs.rename = (async (...args: Parameters<typeof fs.rename>) => {
    const destination = resolve(String(args[1])), transaction = resolve(String(args[0]))
    const managed = destination.replaceAll('\\', '/').includes('/managed-v1/ctxv1_')
    // Capture the actual bounded pending record before the native rename.
    const text = managed ? await fs.readFile(transaction, 'utf8') : undefined
    await nativeRename(...args)
    if (!managed) return
    assert(text && Buffer.byteLength(text) <= 65536)
    assert.equal(transaction, `${destination}.${hash(text)}.pending`)
    const record = JSON.parse(text) as { phase?: string; documentId?: string; pinId?: string }
    const name = basename(destination)
    let cut: Cut | undefined
    if (name === 'operation.json' && record.phase === 'staged') cut = 'staged-rename'
    else if (name === 'operation.json' && record.phase === 'committed') cut = 'committed-rename'
    else if (name === 'manifest.json') cut = 'manifest-rename'
    else if (basename(dirname(destination)) === 'pins') {
      assert.equal(name, hash(record.documentId!) + '.json')
      if (record.documentId === taskDocument) cut = 'first-pin'
      else if (record.documentId === parent) cut = 'second-pin'
    } else if (basename(dirname(destination)) === 'access') {
      assert.equal(name, hash(parent) + '.json')
      if (record.pinId === hash(taskDocument)) cut = 'first-access'
      else if (record.pinId === hash(parent)) cut = 'second-access'
    }
    if (cut) await seen({ cut, path: destination, transaction, text, native: 'rename', success: true })
  }) as typeof fs.rename
  syncBuiltinESMExports()
  return { transitions, restore() { fs.open = nativeOpen; fs.rename = nativeRename; prototype.sync = nativeSync; syncBuiltinESMExports() } }
}
