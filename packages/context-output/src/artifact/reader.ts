import { open, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import { boundedJson, ownedPath, readExact } from './io.ts'
import { validateManifest } from './manifest.ts'
import { CHUNK, dimensions, indexHeader, verifyChunk } from './index.ts'
import type { ManagedArtifactPage } from './types.ts'

/** One rooted range, at most one64KiB body chunk plus bounded output/proof. */
export async function readVerifiedArtifactBytes(root: string, directory: string, ref: ManagedArtifactRef, offset: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 65536 || !Number.isSafeInteger(offset + length) || offset + length > ref.encodedBytes) throw new Error('Artifact range unavailable')
  const paths = ['manifest.json', 'index', 'body'].map(name => resolve(directory, name))
  for (const path of paths) await ownedPath(root, path)
  const manifest = validateManifest(await boundedJson(paths[0]!, 4096), ref), shape = dimensions(ref.encodedBytes)
  if (manifest.leaves !== shape.leaves || manifest.paddedLeaves !== shape.paddedLeaves) throw new Error('Artifact index corrupt')
  const index = await open(paths[1]!, 'r'), body = await open(paths[2]!, 'r')
  try {
    const before = await body.stat(), indexBefore = await index.stat()
    if (!before.isFile() || before.size !== ref.encodedBytes || !indexBefore.isFile() || indexBefore.size !== shape.indexBytes
      || !(await readExact(index, 64, 0)).equals(indexHeader(ref.encodedBytes)) || (await readExact(index, 32, 64)).toString('hex') !== manifest.treeRoot) throw new Error('Artifact index or body corrupt')
    if (ref.encodedBytes === 0) await verifyChunk(index, 0, new Uint8Array(), 0, manifest.treeRoot, true)
    const end = offset + length, output = Buffer.alloc(length)
    let copied = 0
    for (let ordinal = Math.floor(offset / CHUNK); ordinal * CHUNK < end; ordinal++) {
      const start = ordinal * CHUNK, bytes = await readExact(body, Math.min(CHUNK, ref.encodedBytes - start), start)
      await verifyChunk(index, ordinal, bytes, ref.encodedBytes, manifest.treeRoot, true)
      const part = bytes.subarray(Math.max(0, offset - start), Math.min(bytes.length, end - start))
      part.copy(output, copied); copied += part.length
    }
    const after = await body.stat(), indexAfter = await index.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || indexBefore.dev !== indexAfter.dev || indexBefore.ino !== indexAfter.ino || indexBefore.size !== indexAfter.size || indexBefore.mtimeMs !== indexAfter.mtimeMs) throw new Error('Artifact changed while reading')
    for (const path of paths) await ownedPath(root, path)
    const physicalBody = await lstat(paths[2]!), physicalIndex = await lstat(paths[1]!)
    if (physicalBody.dev !== before.dev || physicalBody.ino !== before.ino || physicalIndex.dev !== indexBefore.dev || physicalIndex.ino !== indexBefore.ino) throw new Error('Artifact identity changed while reading')
    return output
  } finally { await body.close(); await index.close() }
}

export async function readArtifactPage(root: string, directory: string, ref: ManagedArtifactRef, offset: number, maxBytes: number): Promise<ManagedArtifactPage> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > ref.encodedBytes || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32768) throw new Error('Artifact range or budget unavailable')
  const binary = ref.codec === 'exec-frames-v1'
  const bytes = await readVerifiedArtifactBytes(root, directory, ref, offset, Math.min(ref.encodedBytes - offset, maxBytes + (binary ? 0 : 3)))
  const page = (length: number): ManagedArtifactPage => ({ ref, offset, nextOffset: offset + length < ref.encodedBytes ? offset + length : null, eof: offset + length === ref.encodedBytes,
    data: binary ? { kind: 'bytes', base64: bytes.subarray(0, length).toString('base64') } : { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)) } })
  if (!binary && bytes.length && (bytes[0]! & 0xc0) === 0x80) throw new Error('Artifact offset must be a UTF8 boundary')
  let length = Math.min(bytes.length, maxBytes)
  const boundary = () => { if (!binary) while (length > 0 && length < bytes.length && (bytes[length]! & 0xc0) === 0x80) length-- }
  boundary()
  while (Buffer.byteLength(JSON.stringify(page(length))) > maxBytes && length > 0) { length = Math.max(0, length - Math.max(1, Buffer.byteLength(JSON.stringify(page(length))) - maxBytes)); boundary() }
  if (Buffer.byteLength(JSON.stringify(page(length))) > maxBytes || !length && offset < ref.encodedBytes) throw new Error('Artifact budget leaves no room for advancing page')
  return page(length)
}
