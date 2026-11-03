import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService } from '../src/index.ts'

afterEach(() => vi.unstubAllGlobals())
it('a managed actual307 response makes one POST and never follows its redirect into a second provider request', async () => {
  let original = 0, redirected = 0
  const server = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      if (request.url === '/v1/chat/completions') { original++; response.writeHead(307, { location: '/redirected' }).end() }
      else { redirected++; response.writeHead(200).end('must never follow') }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing controlled endpoint')
  const baseUrl = 'http://127.0.0.1:' + address.port, nativeFetch = globalThis.fetch
  vi.stubGlobal('fetch', (async (url: string, init?: RequestInit) => { if (url !== baseUrl + '/v1/chat/completions') throw new Error('Unexpected network destination'); return nativeFetch(url, init) }) as typeof globalThis.fetch)
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-307-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const service = createSessionService({ workspace: root, coordinator, codeMode: { mode: 'off' }, model: createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl }) })
  try {
    await expect(service.submit(id, 'Synthetic redirect control.', new AbortController().signal)).rejects.toThrow()
    expect([original, redirected]).toEqual([1, 0])
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve')).toHaveLength(1)
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'settle')).toEqual([expect.objectContaining({ disposition: 'unknown' })])
    expect(events.filter(event => event.type === 'model/exchange-accepted' || event.type === 'tool/dispatch')).toHaveLength(0)
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
