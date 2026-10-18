import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createExecFrameCapture } from '../../output-retention/src/result/exec-frames.ts'
import { createContextOutputService, createContextOutputTools } from '../src/index.ts'

it('returns authorized native channel slices and rejects a cursor inside a canonical frame record', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-frame-pages')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'page-')), service = createContextOutputService({ root, workspaceId: 'w' })
  const scope = service.registerResultScope({ operationId: 'frame-pages', sessionId: 'a', callId: 'c' }, () => true)
  const capture = createExecFrameCapture({ sourceId: 'actual-source', openArtifact: () => service.beginResult(scope, 'exec-frames-v1') })
  try {
    const original = Buffer.from('A🙂B')
    await capture.write({ channel: 'stdout', frame: 0, offset: 0, end: true, bytes: original })
    capture.complete('complete')
    const stored = await capture.settle()
    if (stored.kind !== 'ready' || stored.dependency.retention.kind !== 'artifact') throw new Error('Expected committed frame fixture')
    const ref = stored.dependency.retention.ref, read = createContextOutputTools(service).find(tool => tool.name === 'context_output_read')!
    const page = await read.execute({ ref, maxBytes: 1024 }, { sessionId: 'a' })
    expect(page).toMatchObject({ eof: true, frames: [{ channel: 'stdout', frame: 0, offset: 0, end: true, data: original.toString('base64') }] })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024)
    expect(await read.execute({ ref, cursor: { recordOffset: 10, sliceOffset: 0 } }, { sessionId: 'a' })).toEqual({ kind: 'unavailable', reason: 'range' })
  } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
})
