import { afterAll, beforeAll, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { FrameDecoder } from '../../sandbox-windows-psec/src/protocol.ts'
import * as retention from '@i-harness/output-retention'
import './retained-background-summary.test.ts'

// Bounded diagnostic wrapper around the real registered fixture; no output
// bytes, authority, producer writes or native lifecycle are replaced.
const native = { stdout: { bytes: 0, hash: createHash('sha256') }, stderr: { bytes: 0, hash: createHash('sha256') } }
const captures: { sourceId: string; attempted: number; written: number; failed: string[]; completeness?: string; channels: Record<string, number> }[] = []
const restores: (() => void)[] = []
beforeAll(() => {
  const decode = FrameDecoder.prototype.push
  const decoder = vi.spyOn(FrameDecoder.prototype, 'push').mockImplementation(function (this: FrameDecoder, chunk) {
    const frames = decode.call(this, chunk)
    for (const frame of frames) if (frame.channel === 'stdout' || frame.channel === 'stderr') {
      native[frame.channel].bytes += frame.data.length; native[frame.channel].hash.update(frame.data)
    }
    return frames
  })
  restores.push(() => decoder.mockRestore())
  const original = retention.createExecFrameCapture
  const factory = vi.spyOn(retention, 'createExecFrameCapture').mockImplementation(options => {
    const capture = original(options), write = capture.write.bind(capture), complete = capture.complete.bind(capture)
    const state = { sourceId: options.sourceId, attempted: 0, written: 0, failed: [] as string[], completeness: undefined as string | undefined, channels: {} as Record<string, number> }
    captures.push(state)
    capture.write = async (...args) => {
      const [part] = args
      state.attempted += part.bytes.length; state.channels[part.channel] = (state.channels[part.channel] ?? 0) + part.bytes.length
      try { await write(...args); state.written += part.bytes.length }
      catch (cause) { state.failed.push(String(cause).slice(0, 240)); throw cause }
    }
    capture.complete = value => { state.completeness = value; complete(value) }
    return capture
  })
  restores.push(() => factory.mockRestore())
})
afterAll(() => {
  for (const restore of restores.reverse()) restore()
  console.log('J2 original native/capture boundary:', JSON.stringify({ native: {
    stdout: { bytes: native.stdout.bytes, sha256: native.stdout.hash.digest('hex') },
    stderr: { bytes: native.stderr.bytes, sha256: native.stderr.hash.digest('hex') },
  }, captures }))
})
