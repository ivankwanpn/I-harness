import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as output from '../src/index.ts'
import { createExecFrameCapture } from '../../output-retention/src/result/exec-frames.ts'

it('reads original committed codecs through the shared bounded query and preserves model compatibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'result-page-')), service = output.createContextOutputService({ root, workspaceId: 'w' })
  try {
    const scope = service.registerResultScope({ operationId: 'original', sessionId: 's', callId: 'c' }, () => true)
    const sink = await service.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('🙂'.repeat(16000))); await sink.write(Buffer.from('🙂'.repeat(4000)))
    const saved = await sink.finish('source-limited')
    if (saved.kind !== 'committed') throw new Error('Original fixture did not commit')
    expect(output).toHaveProperty('readManagedResultPage', expect.any(Function))
    const page = await output.readManagedResultPage(service, { sessionId: 's' }, { ref: saved.ref })
    expect(page).toMatchObject({ ref: saved.ref, offset: 0, eof: false, data: { kind: 'text' } })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeGreaterThanOrEqual(32764)
    expect(await output.readManagedResultPage(service, { sessionId: 's' }, { ref: saved.ref, offset: 1 })).toEqual({ kind: 'unavailable', reason: 'range' })
    const read = output.createContextOutputTools(service).find(tool => tool.name === 'context_output_read')!
    expect(await read.execute({ ref: saved.ref, maxBytes: 64000 }, { sessionId: 's' })).toEqual(page)
    expect(await read.execute({ ref: saved.ref, maxBytes: Number.MAX_SAFE_INTEGER + 1 }, { sessionId: 's' })).toEqual(page)
    const calls = vi.spyOn(service, 'readResult')
    for (const extra of [{ maxBytes: 64000 }, { maxBytes: 0 }, { offset: -1 }, { cursor: { recordOffset: 0, sliceOffset: 0 } }, { textView: false }, { surprise: true }]) {
      expect(await output.readManagedResultPage(service, { sessionId: 's' }, { ref: saved.ref, ...extra } as any)).toEqual({ kind: 'unavailable', reason: 'range' })
    }
    expect(calls).not.toHaveBeenCalled()
    expect(await output.readManagedResultPage(service, { sessionId: 's' }, { ref: saved.ref, maxBytes: 1 })).toEqual({ kind: 'unavailable', reason: 'budget' })
    const jsonScope = service.registerResultScope({ operationId: 'json', sessionId: 's', callId: 'j' }, () => true)
    const json = await service.beginResult(jsonScope, 'json-utf8-v1'); await json.write(Buffer.from('{"answer":42}'))
    const j = await json.finish('complete'); if (j.kind !== 'committed') throw new Error('JSON fixture did not commit')
    expect(await output.readManagedResultPage(service, { sessionId: 's' }, { ref: j.ref })).toMatchObject({ ref: j.ref, eof: true, data: { text: '{"answer":42}' } })
    const execScope = service.registerResultScope({ operationId: 'exec', sessionId: 's', callId: 'e' }, () => true)
    const exec = createExecFrameCapture({ sourceId: 'source', openArtifact: () => service.beginResult(execScope, 'exec-frames-v1') })
    const bytes = Buffer.from([0xff, 0, 0xf0, 0x9f, 0x99, 0x82])
    await exec.write({ channel: 'stderr', frame: 0, offset: 0, end: true, bytes }); exec.complete('producer-incomplete')
    const e = await exec.settle(); if (e.kind !== 'ready' || e.dependency.retention.kind !== 'artifact') throw new Error('Exec fixture did not commit')
    const ref = e.dependency.retention.ref
    const framed = await output.readManagedResultPage(service, { sessionId: 's' }, { ref, textView: true })
    expect(framed).toMatchObject({ ref, eof: true, frames: [{ data: bytes.toString('base64'), channel: 'stderr', offset: 0, end: true }] })
    expect(await read.execute({ ref, offset: 0, maxBytes: 64000 }, { sessionId: 's' })).toMatchObject({ ref, eof: true })
    for (const query of [{ ref, offset: 0 }, { ref, cursor: { recordOffset: 0, sliceOffset: 0, extra: 1 } }, { ref, textView: 'yes' }]) {
      expect(await output.readManagedResultPage(service, { sessionId: 's' }, query as any)).toEqual({ kind: 'unavailable', reason: 'range' })
    }
    expect(await read.execute({ ref, offset: 0, cursor: { recordOffset: 0, sliceOffset: 0 } }, { sessionId: 's' })).toEqual({ kind: 'unavailable', reason: 'range' })
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('keeps raw exec slices exact at binary and multibyte cursor edges without inventing text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frame-cursor-')), service = output.createContextOutputService({ root, workspaceId: 'w' })
  try {
    const scope = service.registerResultScope({ operationId: 'slices', sessionId: 's', callId: 'c' }, () => true)
    const capture = createExecFrameCapture({ sourceId: 'source', openArtifact: () => service.beginResult(scope, 'exec-frames-v1') })
    const original = Buffer.concat([Buffer.from([255]), Buffer.from('🙂B'), Buffer.alloc(4096, 120)])
    await capture.write({ channel: 'stdout', frame: 0, offset: 0, end: true, bytes: original })
    await capture.write({ channel: 'stderr', frame: 1, offset: 0, end: true, bytes: Buffer.from('error') }); capture.complete('capture-canceled')
    const result = await capture.settle(); if (result.kind !== 'ready' || result.dependency.retention.kind !== 'artifact') throw new Error('Original frame fixture refused')
    const ref = result.dependency.retention.ref, pieces: Buffer[] = [], errors: Buffer[] = []
    let cursor: import('@i-harness/core-session').ExecFrameCursor | undefined
    for (;;) {
      const page = await output.readManagedResultPage(service, { sessionId: 's' }, { ref, ...(cursor ? { cursor } : {}), textView: true, maxBytes: 700 })
      if (!('frames' in page)) throw new Error(JSON.stringify(page))
      expect(page.ref).toEqual(ref); expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(700)
      for (const frame of page.frames) {
        const target = frame.channel === 'stdout' ? pieces : errors
        expect(frame.offset).toBe(target.reduce((sum, bytes) => sum + bytes.length, 0)); target.push(Buffer.from(frame.data, 'base64'))
      }
      if (page.cursor.recordOffset === 9 && page.cursor.sliceOffset === 0) expect(page.frames[0]!.text).toBeUndefined()
      if (page.eof) break
      expect(page.nextCursor).not.toEqual(page.cursor); cursor = page.nextCursor!
    }
    expect(Buffer.concat(pieces)).toEqual(original); expect(Buffer.concat(errors).toString()).toBe('error')
    const boundary = await output.readManagedResultPage(service, { sessionId: 's' }, { ref, cursor: { recordOffset: 9, sliceOffset: 2 }, textView: true, maxBytes: 700 })
    if (!('frames' in boundary)) throw new Error('Expected authorized binary cursor page')
    expect(boundary.frames[0]!.offset).toBe(2); expect(Buffer.from(boundary.frames[0]!.data, 'base64')[0]).toBe(0x9f); expect(boundary.frames[0]!.text).toBeUndefined()
    expect(await output.readManagedResultPage(service, { sessionId: 's' }, { ref, cursor: { recordOffset: 10, sliceOffset: 0 } })).toEqual({ kind: 'unavailable', reason: 'range' })
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
