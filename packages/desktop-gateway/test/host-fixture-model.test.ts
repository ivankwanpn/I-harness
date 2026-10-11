import { expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'
import { createHostFixtureModel } from './host-fixture-model.ts'
import { createHostFixtureOwner } from './host-fixture-owner.ts'

it('keeps real host loopback transports independent through a failed prompt without replacing global fetch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-host-transports-'))
  const owner = createHostFixtureOwner(), servers: Server[] = []
  const routes: Array<{ model: string; authorization?: string }> = []
  let failFirst = true
  const globalGuard = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Fixture used unowned global fetch') })
  const guardedFetch = globalThis.fetch
  try {
    async function fixture(name: string) {
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString())
        routes.push({ model: body.model, authorization: request.headers.authorization })
        if (name === 'first' && failFirst) { failFirst = false; response.writeHead(400); response.end('Controlled fixture failure'); return }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `${name} completed` } }] })}\n\ndata: [DONE]\n\n`)
      })
      servers.push(server)
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const directory = join(root, name), workspace = join(directory, 'workspace'), settingsPath = join(directory, 'settings.json'), credentialsPath = join(directory, 'credentials.json')
      await mkdir(workspace, { recursive: true })
      await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: origin, apiKeyEnv: 'IH_TRANSPORT_KEY', models: [{ id: name, contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: name } } }))
      await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TRANSPORT_KEY: 'fixture-key' } }))
      const frames: RpcMessage[] = []
      const options = { workspace, settingsPath, credentialsPath, sessionDir: join(directory, 'sessions'), buildProviderClient: createHostFixtureModel(origin), onWrite: (frame: RpcMessage) => frames.push(frame) }
      const host = await owner.own(() => createDesktopHost(options))
      let sequence = 0
      const request = async (method: string, params = {}) => {
        const id = ++sequence; await host.handleLine(encodeFrame(makeRequest(id, method, params)))
        const reply = frames.find(frame => 'id' in frame && frame.id === id)
        if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
        return reply.result
      }
      await request('initialize')
      const { sessionId } = await request('session/create') as { sessionId: string }
      return { request, sessionId, settingsPath }
    }
    const first = await fixture('first'), second = await fixture('second')
    await expect(first.request('session/prompt', { sessionId: first.sessionId, prompt: 'Controlled failure' })).rejects.toThrow(/request failed: 400/)
    await second.request('session/prompt', { sessionId: second.sessionId, prompt: 'Complete on the other fixture origin' })
    await first.request('session/prompt', { sessionId: first.sessionId, prompt: 'Retry on the original fixture origin' })
    expect(routes).toEqual([{ model: 'first', authorization: 'Bearer fixture-key' }, { model: 'second', authorization: 'Bearer fixture-key' }, { model: 'first', authorization: 'Bearer fixture-key' }])
    expect(globalThis.fetch).toBe(guardedFetch)
    const history = await second.request('session/history', { sessionId: second.sessionId, afterSeq: 0, limit: 100 }) as { events: Array<{ type: string; text?: string }> }
    expect(history.events).toContainEqual(expect.objectContaining({ type: 'assistant/message', text: 'second completed' }))
    const settings = { autoTitle: false, sandboxMode: 'read-only', llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'https://example.invalid', apiKeyEnv: 'IH_TRANSPORT_KEY', models: [{ id: 'first', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'first' } } }
    await writeFile(first.settingsPath, JSON.stringify(settings))
    const foreign = await first.request('session/create') as { sessionId: string }
    await expect(first.request('session/prompt', { sessionId: foreign.sessionId, prompt: 'Refuse a changed foreign route' })).rejects.toThrow(/outside its own loopback model route/)
    expect(routes).toHaveLength(3)
  } finally {
    globalGuard.mockRestore()
    try { await owner.close() }
    finally { await Promise.all(servers.map(server => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())) })) }
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('refuses redirects to another fixture origin before sending a model request there', async () => {
  let redirectedRequests = 0
  const destination = createServer((_request, response) => {
    redirectedRequests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: {"choices":[{"delta":{"content":"redirected"}}]}\n\ndata: [DONE]\n\n')
  })
  const source = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${(destination.address() as { port: number }).port}/v1/chat/completions` })
    response.end()
  })
  try {
    await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve))
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(source.address() as { port: number }).port}`
    const client = createHostFixtureModel(origin)({ name: 'fixture', displayName: 'Fixture', protocol: 'openai-compatible', baseUrl: origin, apiKey: 'fixture-key' }, 'fixture-model')
    const drain = async () => { for await (const event of client.stream({ messages: [], tools: [], systemPrompt: '' })) { if (event.type === 'error') throw event.error } }
    const error = await drain().then(() => undefined, error => error)
    expect(redirectedRequests).toBe(0)
    expect(String(error)).toMatch(/redirect/i)
  } finally {
    for (const server of [source, destination]) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
})
