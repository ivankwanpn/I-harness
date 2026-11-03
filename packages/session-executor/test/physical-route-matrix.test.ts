import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createOpenAIClient } from '../../llm-openai/src/index.ts'
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createGeminiClient } from '../../llm-gemini/src/index.ts'
import { createBedrockClient } from '../../llm-bedrock/src/index.ts'
import { createRetryingClient, resolveRetryPolicy, type ModelClient } from '@i-harness/llm-seam'
import { createSessionService } from '../src/index.ts'

beforeEach(() => {
  vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('Unexpected HTTP network') })
  vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected HTTPS network') })
  vi.stubGlobal('fetch', async () => { throw new Error('Unexpected fetch network') })
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true'); vi.stubEnv('AWS_MAX_ATTEMPTS', '9'); vi.stubEnv('NO_PROXY', 'chatgpt.com')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it.each(['chat', 'responses', 'messages', 'gemini', 'bedrock', 'subscription'].flatMap(route => [1, 2].map(cap => [route, cap] as const)))('actual durable %s action permits exactly%s terminal handoffs with conservative receipts', async (route, cap) => {
  const root = await mkdtemp(join(tmpdir(), 'ih-owned-route-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  let calls = 0, service: ReturnType<typeof createSessionService> | undefined
  const handoff = () => {
    calls++
    const reservations = service!.liveSession(id)!.events.filter(event => event.type === 'context/attempt' && event.op === 'reserve')
    expect(reservations).toHaveLength(calls)
    expect(reservations.at(-1)).toMatchObject({ ordinal: calls, lane: 'main', incarnation: expect.any(String) })
  }
  const baseUrl = 'https://owned-route.fixture.invalid', endpoint = route === 'chat' ? baseUrl + '/v1/chat/completions' : route === 'responses' ? baseUrl + '/v1/responses' : route === 'messages' ? baseUrl + '/v1/messages' : route === 'gemini' ? baseUrl + '/v1beta/models/fixture:streamGenerateContent?alt=sse' : 'https://chatgpt.com/backend-api/codex/responses'
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (route === 'bedrock' || url !== endpoint) throw new Error('Unexpected network destination')
    expect(init.method).toBe('POST'); expect(init.redirect).toBe('error'); handoff()
    return new Response('synthetic server failure', { status: 503 })
  })
  const config = { apiKey: 'fixture-only', model: 'fixture', baseUrl }
  let base: ModelClient
  if (route === 'chat') base = createOpenAICompatibleClient(config)
  else if (route === 'responses') base = createOpenAIClient(config)
  else if (route === 'messages') base = createAnthropicClient(config)
  else if (route === 'gemini') base = createGeminiClient(config)
  else if (route === 'subscription') base = createOpenAIClient({ apiKey: '', model: 'fixture', codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: 'fixture-only', accountId: 'fixture-account' }) })
  else base = createBedrockClient({ model: 'fixture', region: 'us-east-1', runtimeOptions: {
    endpoint: 'https://bedrock-owned.fixture.invalid', credentials: { accessKeyId: 'FIXTURE_ACCESS_KEY', secretAccessKey: 'fixture-only-secret' },
    requestHandler: { async handle(input: { hostname: string; method: string; headers: Record<string, string> }) {
      expect(input.hostname).toBe('bedrock-owned.fixture.invalid'); expect(input.method).toBe('POST'); expect(input.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /); handoff()
      return { response: { statusCode: 503, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"message":"synthetic server failure"}') } }
    }, destroy() {}, updateHttpClientConfig() {}, httpHandlerConfigs() { return {} } },
  } })
  const model = createRetryingClient(base, resolveRetryPolicy({ mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  service = createSessionService({ workspace: root, coordinator, model, modelActionMaxAttempts: cap, codeMode: { mode: 'off' } })
  try {
    await expect(service.submit(id, 'Synthetic owned route work.', new AbortController().signal)).rejects.toThrow()
    expect(calls).toBe(cap)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve').map(event => event.ordinal)).toEqual(cap === 1 ? [1] : [1, 2])
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'settle')).toHaveLength(cap)
    expect(events.filter(event => event.type === 'model/exchange-accepted' || event.type === 'tool/dispatch')).toHaveLength(0)
    expect(events.filter(event => event.type === 'context/action' && event.op === 'bind')).toEqual([expect.objectContaining({ retry: { mode: 'normal', maxRetries: 1 }, limits: { total: cap, main: 2, recovery: 2, summary: 8 } })])
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
