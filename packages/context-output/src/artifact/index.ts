import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { readExact, writeAll } from './io.ts'

export const CHUNK = 65536
const u64 = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Artifact integer overflow'); const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes }
export const leafHash = (index: number, bytes: Uint8Array): Buffer => createHash('sha256').update(Buffer.from([0])).update(u64(index)).update(u64(bytes.length)).update(bytes).digest()
const paddingHash = (index: number): Buffer => createHash('sha256').update(Buffer.from([2])).update(u64(index)).digest()
const branchHash = (left: Uint8Array, right: Uint8Array): Buffer => createHash('sha256').update(Buffer.from([1])).update(left).update(right).digest()
export function dimensions(encodedBytes: number) {
  u64(encodedBytes)
  const leaves = Math.max(1, Math.ceil(encodedBytes / CHUNK)), paddedLeaves = 2 ** Math.ceil(Math.log2(leaves)), nodes = 2 * paddedLeaves - 1
  const indexBytes = 64 + 32 * nodes
  if (![leaves, paddedLeaves, nodes, indexBytes].every(Number.isSafeInteger)) throw new Error('Artifact index overflow')
  return { leaves, paddedLeaves, nodes, indexBytes }
}
export function indexHeader(encodedBytes: number): Buffer {
  const { leaves, paddedLeaves, nodes } = dimensions(encodedBytes), bytes = Buffer.alloc(64)
  bytes.write('IHARTIDX', 0, 'ascii'); bytes.writeUInt32BE(1, 8); bytes.writeUInt32BE(64, 12); bytes.writeUInt32BE(CHUNK, 16)
  for (const [offset, value] of [[24, encodedBytes], [32, leaves], [40, paddedLeaves], [48, nodes]] as const) u64(value).copy(bytes, offset)
  return bytes
}
export async function buildIndex(path: string, leavesPath: string, encodedBytes: number): Promise<string> {
  const dimensionsForBody = dimensions(encodedBytes), { leaves, paddedLeaves } = dimensionsForBody
  const input = await open(leavesPath, 'r'), output = await open(path, 'w+')
  try {
    await writeAll(output, indexHeader(encodedBytes), 0)
    for (let index = 0; index < paddedLeaves; index++) await writeAll(output, index < leaves ? await readExact(input, 32, index * 32) : paddingHash(index), 64 + 32 * (paddedLeaves + index - 1))
    for (let node = paddedLeaves - 1; node >= 1; node--) {
      const children = await readExact(output, 64, 64 + 32 * (2 * node - 1))
      await writeAll(output, branchHash(children.subarray(0, 32), children.subarray(32)), 64 + 32 * (node - 1))
    }
    await output.sync()
    return (await readExact(output, 32, 64)).toString('hex')
  } finally { await input.close(); await output.close() }
}
export async function verifyChunk(index: FileHandle, ordinal: number, bytes: Uint8Array, encodedBytes: number, root: string, headerVerified = false): Promise<void> {
  const { paddedLeaves, indexBytes } = dimensions(encodedBytes)
  if (!headerVerified && ((await index.stat()).size !== indexBytes || !(await readExact(index, 64, 0)).equals(indexHeader(encodedBytes)))) throw new Error('Artifact index corrupt')
  let node = paddedLeaves + ordinal, hash = leafHash(ordinal, bytes)
  if (!(await readExact(index, 32, 64 + 32 * (node - 1))).equals(hash) || !headerVerified && (await readExact(index, 32, 64)).toString('hex') !== root) throw new Error('Artifact index corrupt')
  while (node > 1) {
    const siblingNode = node % 2 ? node - 1 : node + 1
    const sibling = await readExact(index, 32, 64 + 32 * (siblingNode - 1))
    hash = node % 2 ? branchHash(sibling, hash) : branchHash(hash, sibling)
    node = Math.floor(node / 2)
  }
  if (hash.toString('hex') !== root) throw new Error('Artifact content corrupt')
}
