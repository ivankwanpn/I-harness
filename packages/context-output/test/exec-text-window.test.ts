import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { encodeExecFrameRecord, type ManagedArtifactRef } from '@i-harness/core-session'
import { readExecFramePage } from '../src/artifact/exec-reader.ts'
import { readExecTextWindow } from '../src/artifact/exec-text-window.ts'

function fixture(stdout: Buffer, incomplete = false) {
  const records: string[] = []
  // Split every scalar, interleave binary stderr and leave native ordinal gaps.
  for (let i = 0; i < stdout.length; i++) {
    records.push(encodeExecFrameRecord({ channel: 'stdout', frame: i * 3, offset: 0, end: true, data: stdout.subarray(i, i + 1).toString('base64') }))
    records.push(encodeExecFrameRecord({ channel: 'stderr', frame: i * 3 + 1, offset: 0, end: true, data: '/w==' }))
  }
  const body = Buffer.from('IHEXEC01\n' + records.join(''))
  const ref: ManagedArtifactRef = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'exec-frames-v1', contentDigest: createHash('sha256').update(body).digest('hex'), encodedBytes: body.length, completeness: incomplete ? 'source-limited' : 'complete' }
  let calls = 0
  const read = (cursor: { recordOffset: number; sliceOffset: number }, _maxBytes: number) => {
    if (++calls > 100) throw new Error('finite fixture ceiling')
    expect(cursor.recordOffset).toBeGreaterThanOrEqual(9)
    return readExecFramePage(ref, { cursor, maxBytes: 800 }, async (o, n) => body.subarray(o, o + n))
  }
  return { ref, read, window: (offset: number, budget: number) => readExecTextWindow(ref, stdout.length, offset, budget, read) }
}
it('preserves BOM and scalars across frames/pages, interleaved stderr and repeated EOF', async () => {
  const raw = Buffer.from('\uFEFFa😀漢z'), f = fixture(raw)
  const a = await f.window(0, 5), b = await f.window(a.next, 5), c = await f.window(b.next, 5)
  expect(Buffer.from(a.text + b.text + c.text)).toEqual(raw)
  expect(await f.window(raw.length, 4)).toEqual({ text: '', next: raw.length })
  expect(await f.window(raw.length, 4)).toEqual({ text: '', next: raw.length })
})
it('rejects scalar-interior offsets and invalid skipped prefixes even at EOF', async () => {
  await expect(fixture(Buffer.from('😀x')).window(2, 8)).rejects.toThrow('invalid-range')
  await expect(fixture(Buffer.from([255, 97])).window(1, 8)).rejects.toThrow('text-view-unavailable')
  await expect(fixture(Buffer.from([255, 97])).window(2, 8)).rejects.toThrow('text-view-unavailable')
  await expect(fixture(Buffer.from([0xe2, 0x82]), true).window(0, 8)).rejects.toThrow('text-view-unavailable')
})
it('returns stable empty stdout and excludes an oversized scalar without replacement', async () => {
  expect(await fixture(Buffer.alloc(0)).window(0, 4)).toEqual({ text: '', next: 0 })
  expect(await fixture(Buffer.from('😀')).window(0, 3)).toEqual({ text: '', next: 0 })
})
it('does not decode bytes beyond the selected complete window', async () => {
  expect(await fixture(Buffer.from([97, 255])).window(0, 1)).toEqual({ text: 'a', next: 1 })
})

// One large frame (production pages carry up to 32 KiB per frame), so the
// internal 8 KiB decode chunks split multi-byte scalars mid-character.
function bulk(stdout: Buffer) {
  const record = encodeExecFrameRecord({ channel: 'stdout', frame: 0, offset: 0, end: true, data: stdout.toString('base64') })
  const body = Buffer.from('IHEXEC01\n' + record)
  const ref: ManagedArtifactRef = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'exec-frames-v1', contentDigest: createHash('sha256').update(body).digest('hex'), encodedBytes: body.length, completeness: 'complete' }
  const read = (cursor: { recordOffset: number; sliceOffset: number }, _maxBytes: number) => readExecFramePage(ref, { cursor, maxBytes: 32768 }, async (o, n) => body.subarray(o, o + n))
  return (offset: number, budget: number) => readExecTextWindow(ref, stdout.length, offset, budget, read)
}

it('keeps multi-byte scalars intact across the internal decode-chunk boundary', async () => {
  const raw = Buffer.from('\u6F22'.repeat(6000)) // 18000 bytes, split at 8192/16384
  const window = bulk(raw)
  const result = await window(3 * 5000, 9)
  expect(result.text).toBe('\u6F22'.repeat(3))
  expect(result.next).toBe(3 * 5003)
})

it('rejects an offset inside a scalar that sits past a chunk boundary', async () => {
  const window = bulk(Buffer.from('\u6F22'.repeat(6000)))
  await expect(window(8194, 9)).rejects.toThrow('invalid-range')
})