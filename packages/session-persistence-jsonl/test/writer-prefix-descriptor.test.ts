import { appendFile, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeFactBatch, encodeFactBatch, legacyPrefixDigest } from '@i-harness/core-session'
import { RecoveryArchiveMismatch } from '@i-harness/session-persistence/internal/native-fact-writer'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { heldFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createFactJournalBackend } from '../src/backend/fact-journal.ts'

type Trace = {
  path: string
  reads: { fd: number; length: number; position: number; bytesRead: number }[]
  truncates: number[]
  syncs: number[]
  closes: number[]
  shortEOF?: boolean
  grow?: 'read' | 'sync'
  closeError?: Error
  disappearAtOpen?: boolean
  afterTruncate?: () => Promise<void>
}
const probe = vi.hoisted(() => ({ trace: undefined as Trace | undefined }))
vi.mock('node:fs/promises', async load => {
  const original = await load<typeof import('node:fs/promises')>()
  return { ...original, async open(...args: Parameters<typeof original.open>) {
    const trace = probe.trace
    if (trace?.disappearAtOpen && args[0] === trace.path && args[1] === 'r+') await original.unlink(trace.path)
    const handle = await original.open(...args)
    if (!trace || args[0] !== trace.path || args[1] !== 'r+') return handle
    return new Proxy(handle, { get(target, key) {
      if (key === 'read') return async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = trace.shortEOF && position > 0 ? { buffer, bytesRead: 0 }
          : await target.read(buffer, offset, Math.min(length, 8191), position)
        trace.reads.push({ fd: target.fd, length, position, bytesRead: result.bytesRead })
        if (trace.grow === 'read' && position === 0) await original.appendFile(trace.path, 'x')
        return result
      }
      if (key === 'truncate') return async (size: number) => { trace.truncates.push(target.fd); await target.truncate(size); await trace.afterTruncate?.() }
      if (key === 'sync') return async () => {
        trace.syncs.push(target.fd); await target.sync()
        if (trace.grow === 'sync') await original.appendFile(trace.path, 'x')
      }
      if (key === 'close') return async () => {
        trace.closes.push(target.fd)
        if (trace.closeError) { const error = trace.closeError; delete trace.closeError; throw error }
        await target.close()
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
})

async function fixture(torn = false) {
  const root = await mkdtemp(join(tmpdir(), 'ih-writer-prefix-')), path = join(root, 'target.jsonl')
  const backend = createJsonlBackend(root)
  const journal = { version: 1, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 }
  const header = Buffer.from(JSON.stringify({ sessionId: 'target', formatVersion: 14, createdAt: 'fixture', journal }) + '\n')
  const frame = encodeFactBatch('fixture', journal.legacyPrefixDigest, [{ type: 'user/message', text: '大'.repeat(42000), seq: 0 }])
  const committed = Buffer.concat([header, frame.bytes])
  await writeFile(path, committed)
  if (torn) await appendFile(path, '{"recordKind"')
  const ownership = createOwnership(backend, { lock: { enabled: true } }), pin = await ownership.pinOwnership('target')
  const held = heldFactOwner({ sessionId: 'target', incarnation: 'fixture' }, ownership, () => pin.assertHeld())
  const trace: Trace = { path, reads: [], truncates: [], syncs: [], closes: [] }
  probe.trace = trace
  return { path, committed, trace, held, prefix: { eventCount: 1, bodyBytes: frame.bytes.length, prefixDigest: decodeFactBatch(frame.bytes).prefixDigest },
    read: () => backend.readJournalPrefix!('target', held),
    async close() { await backend.settleBootstrapCaptureIO!('target', held); await pin.release(); await rm(root, { recursive: true, force: true }) },
  }
}
afterEach(() => { probe.trace = undefined })

it.each([false, true])('reads to the fixed EOF and syncs one writable descriptor (torn=%s)', async torn => {
  const f = await fixture(torn)
  try {
    const size = (await readFile(f.path)).length
    expect(await f.read()).toEqual(f.prefix)
    const fd = f.trace.reads[0]!.fd
    expect(f.trace.reads.every(read => read.fd === fd && read.length <= 65536)).toBe(true)
    expect(f.trace.reads.filter(read => read.bytesRead === 0)).toEqual(
      (torn ? [size, f.committed.length] : [size]).map(position => ({ fd, length: 1, position, bytesRead: 0 })))
    expect(f.trace.syncs).toEqual([fd]); expect(f.trace.closes).toEqual([fd])
    expect(f.trace.truncates).toEqual(torn ? [fd] : [])
    expect(await readFile(f.path)).toEqual(f.committed)
  } finally { await f.close() }
})

it.each(['short', 'growth'] as const)('refuses a changing extent before native issue (%s)', async cut => {
  const f = await fixture(true)
  try {
    if (cut === 'short') f.trace.shortEOF = true
    else f.trace.grow = 'read'
    await expect(f.read()).rejects.toBeInstanceOf(RecoveryArchiveMismatch)
    expect(f.trace.truncates).toEqual([]); expect(f.trace.syncs).toEqual([])
    expect(f.trace.closes).toHaveLength(1)
  } finally { await f.close() }
})

it('retains a prefix conflict and the tracked close failure until cleanup settles', async () => {
  const f = await fixture()
  try {
    const failedClose = Error('controlled descriptor close')
    f.trace.shortEOF = true; f.trace.closeError = failedClose
    await expect(f.read()).rejects.toMatchObject({ errors: [expect.any(RecoveryArchiveMismatch), failedClose] })
    await expect(f.read()).rejects.toBe(failedClose)
    expect(f.trace.closes).toHaveLength(1)
  } finally { await f.close() }
  expect(f.trace.closes).toHaveLength(2)
})

it('reports an uncertain repair if the file changes after truncation', async () => {
  const f = await fixture(true)
  try {
    f.trace.grow = 'sync'
    await expect(f.read()).rejects.toThrow('Managed journal changed after torn-tail recovery')
    expect(f.trace.truncates).toHaveLength(1); expect(f.trace.syncs).toHaveLength(1); expect(f.trace.closes).toHaveLength(1)
    expect(await readFile(f.path)).toEqual(Buffer.concat([f.committed, Buffer.from('x')]))
  } finally { await f.close() }
})

it('compares the retained bytes before sync after a same-length edit during truncation', async () => {
  const f = await fixture(true)
  try {
    const end = f.committed.indexOf(10) + 1, header = f.committed.subarray(0, end)
    const metadata = JSON.parse(header.toString('utf8')).journal
    const replacement = encodeFactBatch('fixture', metadata.legacyPrefixDigest, [{ type: 'user/message', text: '小'.repeat(42000), seq: 0 }])
    const edited = Buffer.concat([header, replacement.bytes])
    expect(edited.length).toBe(f.committed.length)
    f.trace.afterTruncate = () => writeFile(f.path, edited)
    await expect(f.read()).rejects.toThrow('Managed journal changed after torn-tail recovery')
    expect(f.trace.truncates).toHaveLength(1); expect(f.trace.syncs).toEqual([]); expect(f.trace.closes).toHaveLength(1)
    expect(await readFile(f.path)).toEqual(edited)
  } finally { await f.close() }
})

it('reports a missing first file and classifies disappearance of a witnessed file as a conflict', async () => {
  const f = await fixture()
  try {
    await unlink(f.path)
    await expect(f.read()).rejects.toMatchObject({ code: 'ENOENT' })
    const unreachable = async () => { throw Error('Unexpected witness read after disappearance') }
    const witnessed = createFactJournalBackend(() => f.path, async () => {}, undefined, undefined, undefined,
      () => ({ prefix: f.prefix, verify: unreachable, seal: unreachable }))
    await expect(witnessed.readJournalPrefix('target', f.held)).rejects.toBeInstanceOf(RecoveryArchiveMismatch)
    expect(f.trace.syncs).toEqual([]); expect(f.trace.truncates).toEqual([])
  } finally { await f.close() }
})

it('refuses disappearance between lstat and writable acquisition before issuing a mutation', async () => {
  const f = await fixture()
  try {
    f.trace.disappearAtOpen = true
    await expect(f.read()).rejects.toBeInstanceOf(RecoveryArchiveMismatch)
    expect(f.trace.reads).toEqual([]); expect(f.trace.syncs).toEqual([]); expect(f.trace.truncates).toEqual([])
  } finally { await f.close() }
})
