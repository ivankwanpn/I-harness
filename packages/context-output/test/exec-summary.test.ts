import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { encodeExecFrameRecord, type ManagedArtifactRef } from '@i-harness/core-session'
import { readExecFramePage, type ExecFramePage } from '../src/artifact/exec-reader.ts'
import { summarizeExecFrames } from '../src/artifact/exec-summary.ts'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContextOutputService } from '../src/index.ts'
import { createExecFrameCapture } from '../../output-retention/src/index.ts'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function fixture(empty = false, completeness: ManagedArtifactRef['completeness'] = 'complete') {
  const stdout = empty ? Buffer.alloc(0) : Buffer.concat([Buffer.from('😀'), Buffer.alloc(70001, 0xff)]), stderr = Buffer.from([0, 255, 13])
  const records: string[] = []
  for (let offset = 0; offset < stdout.length; offset += 32768) records.push(encodeExecFrameRecord({ channel: 'stdout', frame: 2, offset, end: offset + 32768 >= stdout.length, data: stdout.subarray(offset, offset + 32768).toString('base64') }))
  records.push(encodeExecFrameRecord({ channel: 'stderr', frame: 7, offset: 0, end: true, data: stderr.toString('base64') }))
  const body = Buffer.from('IHEXEC01\n' + records.join(''))
  const ref: ManagedArtifactRef = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'exec-frames-v1', contentDigest: sha(body), encodedBytes: body.length, completeness }
  const read = (cursor: { recordOffset: number; sliceOffset: number }, maxBytes: number) => readExecFramePage(ref, { cursor, maxBytes }, async (offset, length) => body.subarray(offset, offset + length))
  return { body, ref, read, stdout, stderr }
}

it.each([false, true])('hashes original binary/Unicode bytes with ordinal gaps, empty stdout=%s and sliced native records', async empty => {
  const f = fixture(empty)
  expect(await summarizeExecFrames(f.ref, f.read)).toEqual({ version: 1, stdout: { bytes: f.stdout.length, sha256: sha(f.stdout) }, stderr: { bytes: f.stderr.length, sha256: sha(f.stderr) }, totalRawBytes: f.stdout.length + f.stderr.length, completeness: 'complete' })
})
it('preserves source-limited captured byte scope', async () => {
  const f = fixture(false, 'source-limited')
  expect(await summarizeExecFrames(f.ref, f.read)).toMatchObject({ completeness: 'source-limited', totalRawBytes: f.stdout.length + f.stderr.length })
})
it('accepts a genuinely empty archive', async () => {
  const f = fixture(); f.ref.encodedBytes = 9
  expect(await summarizeExecFrames(f.ref, (cursor, maxBytes) => readExecFramePage(f.ref, { cursor, maxBytes }, async (offset, length) => f.body.subarray(offset, offset + length)))).toMatchObject({ stdout: { bytes: 0, sha256: sha(Buffer.alloc(0)) }, totalRawBytes: 0 })
})

const faults: Record<string, (page: ExecFramePage) => void> = {
  'repeated cursor': page => { page.nextCursor = page.cursor },
  'wrong full ref': page => { page.ref = { ...page.ref, completeness: 'source-limited' } },
  'wrong page cursor': page => { page.cursor.sliceOffset++ },
  'premature EOF': page => { page.eof = true; page.nextCursor = null; page.frames.at(-1)!.end = true },
  'contradictory EOF': page => { page.eof = true },
  'noncanonical base64': page => { page.frames[0]!.data = 'Zh==' },
  'invalid offset': page => { page.frames[0]!.offset = 1 },
  'oversize page': page => { page.frames[0]!.text = { kind: 'utf8-view', text: 'x'.repeat(32768) } },
  'nonadvancing empty page': page => { page.frames = [] },
}
it.each(Object.entries(faults))('rejects isolated malformed reader control: %s without partial summary', async (_name, fault) => {
  const f = fixture()
  await expect(summarizeExecFrames(f.ref, async (cursor, cap) => { const page = await f.read(cursor, cap); fault(page); return page })).rejects.toThrow()
})
it('rejects channel/ordinal progression corruption across actual pages', async () => {
  for (const fault of ['channel', 'frame', 'offset'] as const) {
    const f = fixture(); let calls = 0
    await expect(summarizeExecFrames(f.ref, async (cursor, cap) => {
      const page = await f.read(cursor, cap)
      if (++calls === 2) { if (fault === 'channel') page.frames[0]!.channel = 'stderr'; else page.frames[0]![fault] = 0 }
      return page
    })).rejects.toThrow()
  }
})
it('aborts only the scan and permits a fresh independent scan', async () => {
  const f = fixture(), controller = new AbortController()
  await expect(summarizeExecFrames(f.ref, async (cursor, cap) => { const page = await f.read(cursor, cap); controller.abort(); return page }, controller.signal)).rejects.toThrow()
  expect((await summarizeExecFrames(f.ref, f.read)).totalRawBytes).toBe(f.stdout.length + f.stderr.length)
})

it('summarizes an actual committed source-limited capture through the original authenticated reader', async () => {
  const base = resolve(import.meta.dirname, '../../../build/j2-summary-store')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'original-')), service = createContextOutputService({ root, workspaceId: 'j2' })
  const scope = service.registerResultScope({ operationId: 'original-source-limited', sessionId: 'owner', callId: 'original' }, () => true)
  const capture = createExecFrameCapture({ sourceId: 'original-source', openArtifact: () => service.beginResult(scope, 'exec-frames-v1') })
  try {
    const bytes = Buffer.from([255, 0, 240, 159])
    await capture.write({ channel: 'stderr', frame: 4, offset: 0, end: true, bytes })
    capture.complete('source-limited')
    const stored = await capture.settle()
    if (stored.kind !== 'ready' || stored.dependency.retention.kind !== 'artifact') throw new Error('Expected original source-limited capture')
    const ref = stored.dependency.retention.ref
    expect(await summarizeExecFrames(ref, (cursor, maxBytes) => service.readExecResult({ sessionId: 'owner' }, { ref, cursor, maxBytes }))).toEqual({
      version: 1, stdout: { bytes: 0, sha256: sha(Buffer.alloc(0)) }, stderr: { bytes: bytes.length, sha256: sha(bytes) }, totalRawBytes: bytes.length, completeness: 'source-limited',
    })
    await expect(summarizeExecFrames(ref, (cursor, maxBytes) => service.readExecResult({ sessionId: 'foreign' }, { ref, cursor, maxBytes }))).rejects.toThrow()
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
