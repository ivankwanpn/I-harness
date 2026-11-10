import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { createBootstrapRequestIntent } from '@i-harness/session-persistence'
import { HarnessClient, SdkTimeoutError } from '../src/client.ts'
import { readForkRequestCore, readForkPrepareResult, readForkOutcome, type ForkOperation } from '../src/fork.ts'

function preparedFork() {
  const core = readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {} })
  const { intent, requestDigest } = createBootstrapRequestIntent(core, { kind: 'unmanaged' })
  const result = readForkPrepareResult({ kind: 'prepared', prepared: { version: 1, kind: 'session-fork-prepared', core, requestIntent: intent, requestDigest } })
  if (result.kind !== 'prepared') throw new Error('Invalid controlled preparation')
  return result
}
function readyFork(operation: ForkOperation, kind: 'ready' | 'adopted') {
  return readForkOutcome({ version: 1, kind, operation, capture: 'captured', sessionId: operation.invocation.targetSessionId, seedLength: 2,
    receipt: { version: 1, invocation: operation.invocation, manifestDigest: 'd'.repeat(64), seedLength: 2, dependencyClosureDigest: 'c'.repeat(64) } }, operation)
}
function peer() {
  const incoming = new PassThrough(), outgoing = new PassThrough()
  const client = new HarnessClient(incoming, outgoing)
  const frames: { id: string | number; method: string; params: unknown }[] = []
  const reply = (id: string | number, result: unknown) => incoming.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  outgoing.on('data', chunk => {
    const frame = JSON.parse(String(chunk))
    frames.push(frame)
    if (frame.method === 'initialize') reply(frame.id, { name: 'fixture', version: '1', protocolVersion: 1, capabilities: { 'session-fork-bootstrap': ['1'] } })
    if (frame.method === 'shutdown') reply(frame.id, { ok: true })
  })
  return { client, frames, reply }
}
afterEach(() => { vi.useRealTimers() })

it('waits beyond the ordinary RPC deadline for durable fork preparation, begin and idempotent retry', async () => {
  vi.useFakeTimers()
  const p = peer()
  async function stillPending<T>(flight: Promise<T>) {
    let settled = false
    void flight.then(() => { settled = true }, () => { settled = true })
    await vi.advanceTimersByTimeAsync(60_001)
    expect(settled).toBe(false)
  }
  try {
    await p.client.initialize()
    const preparing = p.client.prepareForkSession({ version: 1, sourceSessionId: 'source' })
    await stillPending(preparing)
    const prepared = preparedFork()
    p.reply(p.frames.at(-1)!.id, prepared)
    expect(await preparing).toEqual(prepared)

    const attempt = p.client.createForkAttempt(prepared.prepared)
    const beginning = attempt.run()
    expect(attempt.run()).toBe(beginning)
    await stillPending(beginning)
    expect(p.frames.at(-1)).toMatchObject({ method: 'session/fork/begin', params: { operation: attempt.operation } })
    p.reply(p.frames.at(-1)!.id, readyFork(attempt.operation, 'ready'))
    await expect(beginning).resolves.toMatchObject({ kind: 'ready' })

    const retrying = p.client.retryForkSession(attempt.operation)
    await stillPending(retrying)
    expect(p.frames.at(-1)).toMatchObject({ method: 'session/fork/retry', params: { operation: attempt.operation } })
    p.reply(p.frames.at(-1)!.id, readyFork(attempt.operation, 'adopted'))
    await expect(retrying).resolves.toMatchObject({ kind: 'adopted', operation: attempt.operation })
    expect(p.frames.map(frame => frame.method)).not.toContain('session/cancel')
  } finally { await p.client.close() }
})

it('retains explicit low-level deadlines and caller close for held fork requests', async () => {
  vi.useFakeTimers()
  const p = peer()
  try {
    await p.client.initialize()
    const lowLevel = p.client.request('session/fork/prepare', { version: 1, sourceSessionId: 'source' }, 25)
    const timedOut = expect(lowLevel).rejects.toBeInstanceOf(SdkTimeoutError)
    await vi.advanceTimersByTimeAsync(26)
    await timedOut

    const held = p.client.prepareForkSession({ version: 1, sourceSessionId: 'source' })
    const closed = expect(held).rejects.toMatchObject({ cause: { code: 'sdk-connection' } })
    await p.client.close()
    await closed
    expect(p.frames.map(frame => frame.method)).not.toContain('session/cancel')
  } finally { await p.client.close() }
})
