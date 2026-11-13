import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { createSessionService } from '@i-harness/session-executor'
import { HarnessClient } from '../src/client.ts'
import { createSdkServer } from '../src/server.ts'
import { encodeFrame, makeRequest, RpcError, type RpcMessage } from '../src/protocol.ts'

it.each([
  { label: 'typed recovery', cause: Object.assign(new Error('Original parent busy'), { code: 'FACT_RECOVERY_REQUIRED' }), message: 'Original parent busy', classified: true },
  { label: 'undefined', cause: undefined, message: 'undefined', classified: false },
  { label: 'zero', cause: 0, message: '0', classified: false },
])('replies once to a $label service failure and keeps the same client usable', async ({ cause, message, classified }) => {
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: 'required' })
  const tasks = vi.fn<NonNullable<typeof service.tasksAsync>>().mockRejectedValueOnce(cause).mockResolvedValue([])
  service.tasksAsync = tasks
  const incoming = new PassThrough(), outgoing = new PassThrough()
  const client = new HarnessClient(incoming, outgoing)
  const frames: RpcMessage[] = []
  const handlerRejected = Promise.withResolvers<unknown>()
  const server = createSdkServer(service, { onWrite(frame) { frames.push(frame); incoming.write(encodeFrame(frame)) } })
  outgoing.on('data', chunk => {
    void server.handleLine(String(chunk)).catch(error => { handlerRejected.resolve(error) })
  })
  try {
    await client.initialize()
    const pending = client.request('session/tasks', { sessionId: 'parent' })
    void pending.catch(() => {})
    // An escaped handler failure is observable immediately, without waiting
    // for the client's deadline to hide a missing protocol response.
    const failure = await Promise.race([
      pending.then(() => { throw Error('Expected original request refusal') }, error => error),
      handlerRejected.promise,
    ])
    expect(failure).toBeInstanceOf(RpcError)
    expect(failure).toMatchObject({ code: -32603, message: expect.stringContaining(message) })
    if (classified) expect(failure).toMatchObject({ data: { kind: 'FACT_RECOVERY_REQUIRED', retryable: true } })
    expect(frames.filter(frame => 'error' in frame)).toHaveLength(1)
    expect(await client.tasks('parent')).toEqual([])
    expect(tasks).toHaveBeenCalledTimes(2)
  } finally {
    await client.close()
    await server.close()
    await service.close()
    incoming.destroy(); outgoing.destroy()
  }
})

it('does not reply to notifications or duplicate a returned failure frame', async () => {
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: 'required' })
  const frames: RpcMessage[] = []
  const server = createSdkServer(service, { onWrite: frame => { frames.push(frame) } })
  try {
    expect(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/tasks', params: { sessionId: 'parent' } }))).toBeNull()
    expect(frames).toHaveLength(0)
    await server.handleLine(encodeFrame(makeRequest(1, 'initialize', {})))
    const result = await server.handleLine(encodeFrame(makeRequest(2, 'session/tasks', {})))
    expect(JSON.parse(result!)).toMatchObject({ id: 2, error: { code: -32602 } })
    expect(frames.filter(frame => 'id' in frame && frame.id === 2)).toHaveLength(1)
  } finally { await server.close(); await service.close() }
})

it('preserves an original response writer failure without emitting a second response', async () => {
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: 'required' })
  const failure = new Error('Original writer failed')
  let writes = 0
  const server = createSdkServer(service, { onWrite() { writes++; throw failure } })
  try {
    await expect(server.handleLine(encodeFrame(makeRequest(1, 'initialize', {})))).rejects.toBe(failure)
    expect(writes).toBe(1)
  } finally { await server.close(); await service.close() }
})
