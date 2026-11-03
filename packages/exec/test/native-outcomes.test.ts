import { expect, it } from 'vitest'
import * as execApi from '../src/index.ts'
import type { RootExit, TerminationObservation } from '@i-harness/sandbox'
import { nativeFixture } from './native-fixture.ts'

// Optional access makes the baseline fail on missing behavior, not import setup.
const outcome = (result: unknown) => (execApi as typeof execApi & { execResultOutcome?(result: unknown): string }).execResultOutcome?.(result)
it.each([
  [{ exitCode: 0 }, { kind: 'none' }, 'succeeded'],
  [{ exitCode: 7 }, { kind: 'none' }, 'failed'],
  [{ exitCode: null }, { kind: 'none' }, 'unknown'],
  [{ exitCode: 0, observationError: 'root uncertain' }, { kind: 'none' }, 'unknown'],
  [{ exitCode: 0.5 }, { kind: 'none' }, 'unknown'],
  [{ exitCode: 0 }, 'unsupported', 'unknown'],
  [{ exitCode: 0 }, { kind: 'pending', reason: 'timeout' }, 'unknown'],
  [{ exitCode: 0 }, { kind: 'failed', reason: 'cancelled' }, 'unknown'],
  [{ exitCode: 0 }, { kind: 'confirmed', reason: 'timeout' }, 'failed'],
  [{ exitCode: 0 }, { kind: 'confirmed', reason: 'output-limit' }, 'failed'],
  [{ exitCode: null }, { kind: 'confirmed', reason: 'cancelled' }, 'canceled'],
  [{ exitCode: 5 }, { kind: 'confirmed', reason: 'authority-revoked' }, 'canceled'],
  [{ exitCode: 0 }, { kind: 'confirmed', reason: 'shutdown' }, 'canceled'],
] as [RootExit, TerminationObservation | 'unsupported', string][])(
  'captures original native root %j and disposition %j as %s without adding program fields', async (root, observation, expected) => {
    const f = nativeFixture({ root, observation })
    try {
      const result = await f.exec.run({ argv: ['fixture'] })
      expect(outcome(result)).toBe(expected)
      expect(JSON.parse(JSON.stringify(result))).toEqual({ stdout: 'original\n', stderr: '', exitCode: root.exitCode ?? -1, timedOut: false })
      expect(Object.getOwnPropertySymbols(result)).toEqual([])
      expect(outcome({ ...result })).toBeUndefined()
      expect(await execApi.retainedOutputReader(result)!({ maxBytes: 1024, signal: new AbortController().signal })).toEqual({ text: 'stdout:\noriginal\r\n\nstderr:\n', complete: true, originalBytes: 27 })
      expect(f.counts()).toEqual({ launches: 1, terminations: 0, releases: 1 })
    } finally { await f.exec.dispose() }
  },
)

it('records pre-aborted no-launch cancellation at admission without inventing a native termination', async () => {
  const f = nativeFixture()
  try {
    const result = await f.exec.run({ argv: ['fixture'], abortSignal: AbortSignal.abort() })
    expect(outcome(result)).toBe('canceled')
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: -1, timedOut: false })
    expect(f.counts()).toEqual({ launches: 0, terminations: 0, releases: 0 })
  } finally { await f.exec.dispose() }
})

it.each(['timeout', 'cancelled'] as const)('root0 with live descendants uses original admitted %s tree disposition', async reason => {
  const f = nativeFixture({ liveTree: true }), controller = new AbortController()
  try {
    const pending = f.exec.run({ argv: ['fixture'], abortSignal: controller.signal, ...(reason === 'timeout' ? { timeoutMs: 20 } : {}) })
    await f.outputStarted
    if (reason === 'cancelled') controller.abort()
    const result = await pending
    expect(outcome(result)).toBe(reason === 'timeout' ? 'failed' : 'canceled')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(reason === 'timeout')
    expect(f.counts()).toEqual({ launches: 1, terminations: 1, releases: 1 })
  } finally { f.finish(); await f.exec.dispose() }
})

it('late caller abort after tree-empty only joins original cleanup and leaves exit0 succeeded', async () => {
  const f = nativeFixture({ holdOutput: true }), controller = new AbortController()
  try {
    const pending = f.exec.run({ argv: ['fixture'], abortSignal: controller.signal })
    await f.outputStarted
    await new Promise<void>(done => setImmediate(done))
    expect(f.counts().releases).toBe(1)
    controller.abort()
    f.finish()
    const result = await pending
    expect(outcome(result)).toBe('succeeded')
    expect(f.counts()).toEqual({ launches: 1, terminations: 0, releases: 1 })
  } finally { f.finish(); await f.exec.dispose() }
})

it('original stream output-limit termination fails a root0 tree without rewriting root status or admitted bytes', async () => {
  const f = nativeFixture({ liveTree: true })
  const chunks: Buffer[] = []
  try {
    const result = await f.exec.run({ argv: ['fixture'] }, { stream: { maxBytes: 1, onStdout: chunk => { chunks.push(chunk) } } })
    expect(outcome(result)).toBe('failed')
    expect(result.exitCode).toBe(0)
    expect(result.stream).toMatchObject({ bytesAdmitted: { stdout: 1 }, stopReason: 'output-limit' })
    expect(Buffer.concat(chunks).toString()).toBe('o')
    expect(f.counts()).toEqual({ launches: 1, terminations: 1, releases: 1 })
  } finally { f.finish(); await f.exec.dispose() }
})
