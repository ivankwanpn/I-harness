import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { encodeExecFrameRecord, type ManagedArtifactRef } from '@i-harness/core-session'
import type { AgentProcessReadContext } from '../src/agent-process-read.ts'
import { buildSavedProcessIndex } from '../src/saved-process-index.ts'
import { readSavedProcessFrame, readSavedProcessPreview } from '../src/saved-process-output.ts'

interface Chunk { channel: 'stdout' | 'stderr'; bytes: Buffer }
function fixture(chunks: Chunk[], completeness: ManagedArtifactRef['completeness'] = 'complete') {
  const parts = chunks.map(({ channel, bytes }, frame) => ({ channel, frame, offset: 0, end: true, data: bytes.toString('base64') }))
  let next = 9
  const starts: number[] = [], records: string[] = []
  for (const part of parts) {
    starts.push(next)
    const record = encodeExecFrameRecord(part)
    records.push(record)
    next += Buffer.byteLength(record)
  }
  const ref: ManagedArtifactRef = {
    version: 1, id: 'ctxv1_' + 'f'.repeat(64), revision: 'e'.repeat(64), codec: 'exec-frames-v1',
    completeness, encodedBytes: next, contentDigest: createHash('sha256').update('IHEXEC01\n' + records.join('')).digest('hex'),
  }
  const page = vi.fn<AgentProcessReadContext['page']>(async query => {
    const start = query.cursor && 'recordOffset' in query.cursor ? query.cursor.recordOffset || 9 : 9
    const index = starts.indexOf(start)
    if (index < 0) throw new Error('Unexpected fixture cursor')
    const eof = index === parts.length - 1
    return { ref, cursor: { recordOffset: start, sliceOffset: 0 },
      nextCursor: eof ? null : { recordOffset: starts[index + 1]!, sliceOffset: 0 }, eof, frames: [parts[index]!] }
  })
  const unused = (): never => { throw new Error('Unexpected fixture process operation') }
  const context: AgentProcessReadContext = {
    index: buildSavedProcessIndex([], 'fixture'),
    session: { formatVersion: 14, events: [] },
    document: undefined,
    select: unused, selectTerminal: unused, assertCurrent: unused, checkpoint: unused,
    page: query => page(query),
  }
  return { ref, page, context }
}

it('decodes separately split UTF-8 streams through pages without requesting a catalog', async () => {
  const stdout = Buffer.from('A🌱Z'), stderr = Buffer.from('é!')
  const f = fixture([
    { channel: 'stdout', bytes: stdout.subarray(0, 2) }, { channel: 'stderr', bytes: stderr.subarray(0, 1) },
    { channel: 'stdout', bytes: stdout.subarray(2) }, { channel: 'stderr', bytes: stderr.subarray(1) },
  ])
  expect(await readSavedProcessPreview(f.context, f.ref)).toEqual({ text: 'A🌱Zé!', truncated: false })
  expect(f.page).toHaveBeenCalledTimes(4)
  expect(f.page.mock.calls.every(([query]) => query.maxBytes === 32768 && !query.viaCatalog)).toBe(true)
})

it('stops at 131072 raw bytes without replacing a scalar split by the cap', async () => {
  const f = fixture([
    ...Array.from({ length: 5 }, () => ({ channel: 'stdout' as const, bytes: Buffer.alloc(22000, 'x') })),
    { channel: 'stderr', bytes: Buffer.concat([Buffer.alloc(21071, 'y'), Buffer.from('🌱!')]) },
  ])
  expect(await readSavedProcessPreview(f.context, f.ref))
    .toEqual({ text: 'x'.repeat(110000) + 'y'.repeat(21071), truncated: true })
  expect(f.page).toHaveBeenCalledTimes(6)
})

it('bounds the number of pages and marks an incomplete retained source', async () => {
  const f = fixture(Array.from({ length: 33 }, () => ({ channel: 'stdout', bytes: Buffer.from('x') })))
  expect(await readSavedProcessPreview(f.context, f.ref)).toEqual({ text: 'x'.repeat(32), truncated: true })
  expect(f.page).toHaveBeenCalledTimes(32)
  const limited = fixture([{ channel: 'stdout', bytes: Buffer.from('captured') }], 'source-limited')
  expect(await readSavedProcessPreview(limited.context, limited.ref)).toEqual({ text: 'captured', truncated: true })
})

it('accepts an advancing slice of a native record and rejects nonadvancing or invalid pages', async () => {
  const f = fixture([{ channel: 'stdout', bytes: Buffer.from('abcd') }])
  const start = { recordOffset: 9, sliceOffset: 0 }, second = { recordOffset: 9, sliceOffset: 2 }
  const firstPart = { channel: 'stdout' as const, frame: 0, offset: 0, end: false, data: Buffer.from('ab').toString('base64') }
  f.page.mockResolvedValueOnce({ ref: f.ref, cursor: start, nextCursor: second, eof: false, frames: [firstPart] })
  f.page.mockResolvedValueOnce({ ref: f.ref, cursor: second, nextCursor: null, eof: true,
    frames: [{ ...firstPart, offset: 2, end: true, data: Buffer.from('cd').toString('base64') }] })
  expect(await readSavedProcessPreview(f.context, f.ref)).toEqual({ text: 'abcd', truncated: false })

  f.page.mockResolvedValueOnce({ ref: f.ref, cursor: start, nextCursor: start, eof: false, frames: [firstPart] })
  expect(await readSavedProcessFrame(f.context, f.ref)).toEqual({ kind: 'unavailable', reason: 'invalid-page' })
  f.page.mockResolvedValueOnce({ ref: f.ref, cursor: start, nextCursor: null, eof: true,
    frames: [{ ...firstPart, end: true, data: 'YQ' }] })
  expect(await readSavedProcessFrame(f.context, f.ref)).toEqual({ kind: 'unavailable', reason: 'invalid-page' })
  f.page.mockResolvedValueOnce({ kind: 'unavailable', reason: 'unauthorized' })
  expect(await readSavedProcessPreview(f.context, f.ref)).toEqual({ kind: 'unavailable', reason: 'unauthorized' })
})

it('validates an independent mid-record cursor while letting original scope failures propagate', async () => {
  const f = fixture([{ channel: 'stdout', bytes: Buffer.from('abcd') }])
  expect(await readSavedProcessFrame(f.context, f.ref, { recordOffset: 0, sliceOffset: 0 })).toMatchObject({
    cursor: { recordOffset: 9, sliceOffset: 0 }, eof: true,
  })
  const cursor = { recordOffset: 9, sliceOffset: 2 }
  const tail = { ref: f.ref, cursor, nextCursor: null, eof: true,
    frames: [{ channel: 'stdout' as const, frame: 0, offset: 2, end: true, data: Buffer.from('cd').toString('base64') }] }
  f.page.mockResolvedValueOnce(tail)
  expect(await readSavedProcessFrame(f.context, f.ref, cursor)).toEqual(tail)
  f.page.mockRejectedValueOnce(new Error('Process read owner changed'))
  await expect(readSavedProcessFrame(f.context, f.ref, cursor)).rejects.toThrow('Process read owner changed')
})
