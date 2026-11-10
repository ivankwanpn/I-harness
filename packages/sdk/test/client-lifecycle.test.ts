import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { HarnessClient, runHarness, SdkTimeoutError } from '../src/client.ts'

const peerPath = fileURLToPath(new URL('./fixtures/lifecycle-peer.mjs', import.meta.url))
type Frame = { id: string; method: string }

function memoryPeer() {
  const incoming = new PassThrough()
  const outgoing = new PassThrough()
  const client = new HarnessClient(incoming, outgoing)
  const frames: Frame[] = []
  outgoing.on('data', chunk => { frames.push(JSON.parse(String(chunk))) })
  const reply = (id: string, result: unknown = {}) => {
    incoming.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  }
  return { client, incoming, outgoing, frames, reply }
}

it('drains subprocess stderr, distinguishes deadlines, and closes single flight', async () => {
  const client = HarnessClient.spawn({ command: process.execPath, args: [peerPath, '--large-stderr'] })
  try {
    expect((await client.initialize()).name).toBe('fixture')
    expect(client.stderr.length).toBeLessThanOrEqual(16_384)
    await expect(client.request('hang', {}, 20)).rejects.toBeInstanceOf(SdkTimeoutError)
    expect((await client.initialize()).name).toBe('fixture')
    const closing = client.close()
    expect(client.close()).toBe(closing)
    await closing
  } finally { await client.close() }
})

it('initializes one-shot runs before submitting and preserves explicit argv', async () => {
  await expect(runHarness('hello', {
    command: process.execPath,
    args: [peerPath, '--expected-argv'],
  })).resolves.toMatchObject({ events: [] })
})

it('task deadlines remain distinct and do not cancel another submission', async () => {
  const peer = memoryPeer()
  await expect(peer.client.run({ prompt: 'hello', sessionId: 'shared', timeoutMs: 10 })).rejects.toBeInstanceOf(SdkTimeoutError)
  expect(peer.frames.map(frame => frame.method)).toEqual(['session/prompt'])
  const closing = peer.client.close()
  peer.reply(peer.frames.at(-1)!.id)
  await closing
})

it('preserves a real spawn failure through one-shot cleanup', async () => {
  await expect(runHarness('hello', {
    command: 'i-harness-missing-fixture-executable-8fa31',
  })).rejects.toThrow(/ENOENT/)
})

it('installs close admission before a synchronous peer can reenter and rejects new work', async () => {
  const peer = memoryPeer()
  let reentered: Promise<void> | undefined
  let refused: Promise<unknown> | undefined
  peer.outgoing.on('data', chunk => {
    const frame: Frame = JSON.parse(String(chunk))
    if (frame.method !== 'shutdown') return
    reentered = peer.client.close()
    refused = peer.client.request('session/create')
    void refused.catch(() => {})
    peer.client.notify('session/create')
    peer.reply(frame.id)
  })
  const closing = peer.client.close()
  expect(reentered).toBe(closing)
  await expect(refused).rejects.toThrow(/closing/)
  await closing
  expect(peer.frames.map(frame => frame.method)).toEqual(['shutdown'])
})

it('bounds Node timer values and supports an explicit no-deadline request', async () => {
  const peer = memoryPeer()
  try {
    for (const timeout of [-1, Number.NaN, Infinity, 0.5, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      await expect(peer.client.request('invalid', {}, timeout)).rejects.toBeInstanceOf(RangeError)
    }
    expect(peer.frames).toHaveLength(0)
    const maximum = peer.client.request('maximum', {}, 2_147_483_647)
    peer.reply(peer.frames.at(-1)!.id, 'ready')
    await expect(maximum).resolves.toBe('ready')
    const unlimited = peer.client.request('unlimited', {}, 0)
    await new Promise(resolve => setTimeout(resolve, 20))
    peer.reply(peer.frames.at(-1)!.id, 'ready')
    await expect(unlimited).resolves.toBe('ready')
  } finally {
    const closing = peer.client.close()
    peer.reply(peer.frames.at(-1)!.id)
    await closing
  }
})

it('sends the legacy shutdown notification before ending a real peer transport', async () => {
  const client = HarnessClient.spawn({ command: process.execPath, args: [peerPath, '--legacy-shutdown'] })
  try {
    await client.initialize()
    await client.close()
    expect(client.stderr).toContain('LEGACY_SHUTDOWN_NOTIFICATION')
  } finally { await client.close() }
})
