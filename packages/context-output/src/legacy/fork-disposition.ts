import { open, lstat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { ownedPath, ownedMkdir, readExact, writeAll, retireFile, type RetireFile } from '../artifact/io.ts'
import { requireSpace } from '../artifact/quota.ts'
import { exists } from './owner-ledger.ts'
import { recordHash } from './fork-codec.ts'
import type { LegacyRoot, LegacyCommitment } from './fork-types.ts'
import { fundingParents, nativeFundingFile, fileFields, fundingDescription, assertFundingFile, withFundingFile, sum, type FundingFile, type FundingDescription, type FundingBatchScope, type LegacyFundingBatchOwner } from './funding-batch.ts'

export type Terminal = { version: 1 | 2; kind: 'legacy-fork-revoked'; bindingDigest: string; planDigest: string }
  | ({ version: 1; kind: 'legacy-ref-expired'; workspaceId: string } & LegacyCommitment)
const wire = (generation: 0 | 1, tuple: Terminal) => Buffer.from(JSON.stringify({ version: 1, generation, status: generation === 0 ? 'live' : 'terminal', tuple }))
function encoded(generation: 0 | 1, tuple: Terminal, capacity: number): Buffer {
  const payload = wire(generation, tuple), checksum = createHash('sha256').update('ih.legacy-fork.disposition.v1\0').update(payload).digest('hex')
  const body = Buffer.concat([Buffer.from(`IHLDS01\n${payload.length}\n${checksum}\n`), payload])
  if (body.length > capacity) throw Error('Disposition slot capacity conflict')
  return Buffer.concat([body, Buffer.alloc(capacity - body.length)])
}
export function slotCapacity(tuple: Terminal): number {
  return Math.max(...([0, 1] as const).map(generation => { const payload = wire(generation, tuple); return 8 + String(payload.length).length + 1 + 64 + 1 + payload.length }))
}
export const revokedTuple = (root: LegacyRoot): Terminal => ({ version: root.version, kind: 'legacy-fork-revoked', bindingDigest: recordHash('binding', root.binding,root.version), planDigest: recordHash('plan', root,root.version) })
export const expiredTuple = (workspaceId: string, c: LegacyCommitment): Terminal => ({ version: 1, kind: 'legacy-ref-expired', workspaceId, refId: c.refId, revision: c.revision, metadataDigest: c.metadataDigest, metadataEncodedBytes: c.metadataEncodedBytes, expiresAt: c.expiresAt })
export const expiryBase = (directory: string, c: LegacyCommitment) => resolve(directory, 'legacy-expiry-v1', c.refId, c.metadataDigest, 'expiry')
async function originalSlot(directory: string, path: string, handle?: import('node:fs/promises').FileHandle): Promise<void> {
  await ownedPath(directory, path)
  const info = await lstat(path, { bigint: true })
  if (!info.isFile() || info.nlink !== 1n || info.ino === 0n) throw Error('Foreign disposition file')
  if (handle) {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== info.dev || opened.ino !== info.ino) throw Error('Disposition identity changed')
  }
}
/** Exact tuple-derived capacity is real file payload, funded by the L0 quota. */
export async function fundSlots(directory: string, base: string, tuple: Terminal, quota: number, guard: () => void, retire?: RetireFile): Promise<void> {
  const capacity = slotCapacity(tuple)
  await ownedMkdir(directory, dirname(base), guard)
  for (const generation of [0, 1] as const) {
    const path = `${base}.${generation}`, wanted = generation === 0 ? encoded(0, tuple, capacity) : Buffer.alloc(capacity)
    let handle
    if (await exists(path)) { await originalSlot(directory, path); guard(); handle = await open(path, 'r+') }
    else { await requireSpace(directory, quota, capacity); guard(); handle = await open(path, 'wx+') }
    try {
      await originalSlot(directory, path, handle); guard()
      const size = (await handle.stat()).size; guard()
      if (size > capacity || !(await readExact(handle, size, 0)).equals(wanted.subarray(0, size))) throw Error('Original disposition funding conflict')
      guard(); await requireSpace(directory, quota, capacity - size); guard()
      await originalSlot(directory, path, handle); guard()
      await writeAll(handle, wanted.subarray(size), size, () => { guard(); return true }); guard(); await handle.sync(); guard()
    } finally { await retireFile(handle, retire) }
  }
  const state = await readSlots(directory, base, tuple, retire); guard()
  if (state !== 'live') throw Error('Disposition is not live: ' + state)
}
async function inspectSlotFunding(directory: string, path: string, wanted: Buffer, guard: () => void, retire?: RetireFile): Promise<FundingFile> {
  await fundingParents(directory, path, guard); guard()
  if (!await exists(path)) { guard(); return { kind: 'absent' } }
  await originalSlot(directory, path); guard()
  const handle = await open(path, 'r')
  return withFundingFile(handle, retire, async () => {
    guard(); await originalSlot(directory, path, handle); guard()
    const info = await handle.stat({ bigint: true }); guard()
    if (info.size > BigInt(wanted.length)) throw Error('Original disposition funding conflict')
    const prefix = await readExact(handle, Number(info.size), 0); guard()
    if (!prefix.equals(wanted.subarray(0, prefix.length))) throw Error('Original disposition funding conflict')
    const file = nativeFundingFile(info, createHash('sha256').update(prefix).digest('hex'))
    await assertFundingFile(directory, path, handle, file, prefix.length, guard)
    return file
  })
}
async function slotFunding(directory: string, base: string, tuple: Terminal, guard: () => void, retire?: RetireFile) {
  const capacity = slotCapacity(tuple), files: [FundingFile, FundingFile] = [
    await inspectSlotFunding(directory, base + '.0', encoded(0, tuple, capacity), guard, retire),
    await inspectSlotFunding(directory, base + '.1', Buffer.alloc(capacity), guard, retire),
  ]
  const description = fundingDescription(base, 'slots', [tuple.kind, JSON.stringify(tuple), String(capacity), ...fileFields(files[0]), ...fileFields(files[1])], files.map((file, generation) => ({ key: String(generation), peakGrowth: capacity - (file.kind === 'file' ? file.size : 0) })))
  return { capacity, files, description }
}
export async function describeSlotFunding(directory: string, base: string, tuple: Terminal, guard: () => void, retire?: RetireFile): Promise<FundingDescription> { return (await slotFunding(directory, base, tuple, guard, retire)).description }
export async function fundSlotsInBatch(owner: LegacyFundingBatchOwner, scope: FundingBatchScope, directory: string, base: string, tuple: Terminal, guard: () => void, retire?: RetireFile): Promise<FundingDescription> {
  const { capacity, files, description } = await slotFunding(directory, base, tuple, guard, retire)
  guard()
  const allocation = owner.enter(scope, description)
  owner.assertAllocation(allocation, base); guard(); await ownedMkdir(directory, dirname(base), guard)
  for (const generation of [0, 1] as const) {
    const path = `${base}.${generation}`, prior = files[generation], wanted = generation === 0 ? encoded(0, tuple, capacity) : Buffer.alloc(capacity)
    owner.assertAllocation(allocation, base); guard()
    if (prior.kind === 'absent') owner.issued(allocation, String(generation), capacity)
    guard()
    const handle = await open(path, prior.kind === 'absent' ? 'wx+' : 'r+')
    await withFundingFile(handle, retire, async () => {
      guard(); await originalSlot(directory, path, handle); guard()
      const file = prior.kind === 'file' ? prior : nativeFundingFile(await handle.stat({ bigint: true }), '')
      let offset = prior.kind === 'file' ? prior.size : 0
      await assertFundingFile(directory, path, handle, file, offset, guard)
      if (!(await readExact(handle, offset, 0)).equals(wanted.subarray(0, offset))) throw Error('Original disposition funding conflict')
      guard()
      while (offset < capacity) {
        await assertFundingFile(directory, path, handle, file, offset, guard)
        if (!(await readExact(handle, offset, 0)).equals(wanted.subarray(0, offset))) throw Error('Original disposition funding conflict')
        guard()
        owner.issued(allocation, String(generation), description.primitives[generation]!.peakGrowth)
        guard()
        const result = await handle.write(wanted, offset, capacity - offset, offset); guard()
        if (result.bytesWritten <= 0) throw Error('Artifact write made no progress')
        offset = sum(offset, result.bytesWritten)
      }
      await assertFundingFile(directory, path, handle, file, capacity, guard)
      if (!(await readExact(handle, capacity, 0)).equals(wanted)) throw Error('Original disposition funding conflict')
      guard(); owner.issued(allocation, String(generation), 0)
      guard()
      await handle.sync(); guard()
      if (!(await readExact(handle, capacity, 0)).equals(wanted)) throw Error('Original disposition funding readback conflict')
      await assertFundingFile(directory, path, handle, file, capacity, guard)
    })
  }
  const state = await readSlots(directory, base, tuple, retire); guard()
  if (state !== 'live') throw Error('Disposition is not live: ' + state)
  guard(); owner.finish(allocation); return description
}
export async function readSlots(directory: string, base: string, tuple: Terminal, retire?: RetireFile): Promise<'live' | 'terminal' | 'unknown' | 'missing'> {
  const capacity = slotCapacity(tuple)
  async function read(path: string): Promise<Buffer | undefined> {
    if (!await exists(path)) return undefined
    await originalSlot(directory, path)
    const handle = await open(path, 'r')
    try { await originalSlot(directory, path, handle); const info = await handle.stat(); if (info.size !== capacity) throw Error('Disposition capacity mismatch'); return await readExact(handle, capacity, 0) } finally { await retireFile(handle, retire) }
  }
  try {
    const live = await read(base + '.0'), terminal = await read(base + '.1')
    if (!live || !terminal) return 'missing'
    if (!live.equals(encoded(0, tuple, capacity))) return 'unknown'
    if (terminal.equals(encoded(1, tuple, capacity))) return 'terminal'
    return terminal.every(byte => byte === 0) ? 'live' : 'unknown'
  } catch { return 'unknown' }
}
/** Inspect the original funded allocation before deterministic terminal recovery. */
export async function assertTerminalSlotIdentity(directory: string, base: string, tuple: Terminal, guard: () => void, retire?: RetireFile): Promise<number> {
  await originalSlot(directory, base + '.0'); await originalSlot(directory, base + '.1'); guard()
  const capacity = slotCapacity(tuple), active = await open(base + '.0', 'r')
  try {
    await originalSlot(directory, base + '.0', active); guard()
    if ((await active.stat()).size !== capacity || !(await readExact(active, capacity, 0)).equals(encoded(0, tuple, capacity))) throw Error('Foreign disposition identity')
  } finally { await retireFile(active, retire) }
  if ((await lstat(base + '.1')).size !== capacity) throw Error('Disposition funding changed')
  guard()
  return capacity
}
/** Explicit clear/delete/TTL authority can finish its deterministic inactive
 * tuple even after a torn write. Passive readers only inspect. */
export async function terminalSlots(directory: string, base: string, tuple: Terminal, guard: () => void, retire?: RetireFile): Promise<void> {
  const state = await readSlots(directory, base, tuple, retire); guard()
  if (state === 'terminal') return
  if (state === 'missing') throw Error('Disposition funding missing')
  const capacity = await assertTerminalSlotIdentity(directory, base, tuple, guard, retire)
  guard(); const handle = await open(base + '.1', 'r+')
  try { await originalSlot(directory, base + '.1', handle); guard(); if ((await handle.stat()).size !== capacity) throw Error('Disposition funding changed'); guard(); await writeAll(handle, encoded(1, tuple, capacity), 0, () => { guard(); return true }); guard(); await handle.sync(); guard() } finally { await retireFile(handle, retire) }
  if (await readSlots(directory, base, tuple, retire) !== 'terminal') throw Error('Disposition terminal write unknown')
  guard()
}
