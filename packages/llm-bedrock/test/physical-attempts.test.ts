import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import { createBedrockClient, type BedrockConfig } from '../src/index.ts'
import { createGenerationControl, generationError } from '@i-harness/llm-seam'

beforeEach(() => {
  vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('Unexpected HTTP network') })
  vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Unexpected HTTPS network') })
  vi.stubGlobal('fetch', async () => { throw new Error('Unexpected fetch network') })
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'FIXTURE_ACCESS_KEY')
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixture-only-secret')
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
  vi.stubEnv('AWS_MAX_ATTEMPTS', '9')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const request = { messages: [{ role: 'user' as const, content: 'synthetic' }], tools: [], systemPrompt: '' }
const credentials = { accessKeyId: 'FIXTURE_ACCESS_KEY', secretAccessKey: 'fixture-only-secret' }

it('the installed SDK forwards two independent grants to its real handler and disables hidden service retries', async () => {
  const calls: string[] = [], symbols: number[] = [], trace: string[] = []
  const handler = {
    async handle(input: { headers: Record<string, string> }, options: object) {
      calls.push(input.headers['x-amzn-bedrock-model-id'] ?? String(calls.length))
      symbols.push(Object.getOwnPropertySymbols(options).length)
      trace.push('handler')
      expect(input.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /)
      return { response: { statusCode: 503, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"message":"synthetic busy"}') } }
    },
    destroy() {}, updateHttpClientConfig() {}, httpHandlerConfigs() { return {} },
  }
  const model = createBedrockClient({ model: 'fixture', region: 'us-east-1', runtimeOptions: { endpoint: 'https://bedrock.fixture.invalid', credentials, requestHandler: handler } } as BedrockConfig)
  const run = async (label: string) => {
    const generation = createGenerationControl({ signal: new AbortController().signal, async reserve() {
      trace.push(`reserve-${label}`)
      return { issue() { trace.push(`issue-${label}`) }, async settle(value) { trace.push(`${value}-${label}`) } }
    } })
    for await (const _event of model.stream({ ...request, generation })) {}
  }
  await Promise.all([run('A'), run('B')])
  expect(calls).toHaveLength(2)
  expect(symbols).toEqual([0, 0])
  expect(trace.filter(value => value.startsWith('reserve-')).sort()).toEqual(['reserve-A', 'reserve-B'])
  expect(trace.filter(value => value.startsWith('issue-')).sort()).toEqual(['issue-A', 'issue-B'])
  expect(trace.filter(value => value === 'handler')).toHaveLength(2)
})

it('held real SDK credentials followed by owner expiry produce zero handler calls', async () => {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  let expired = false, calls = 0, reserves = 0
  const model = createBedrockClient({ model: 'fixture', region: 'us-east-1', runtimeOptions: {
    endpoint: 'https://bedrock.fixture.invalid',
    credentials: async () => { entered.resolve(); await released.promise; return credentials },
    requestHandler: { async handle() { calls++; throw new Error('Should not issue') }, destroy() {}, updateHttpClientConfig() {}, httpHandlerConfigs() { return {} } },
  } } as BedrockConfig)
  const generation = createGenerationControl({ signal: new AbortController().signal, async reserve() {
    reserves++
    return { issue() { if (expired) throw generationError('GENERATION_EXPIRED') }, async settle() {} }
  } })
  const run = (async () => { for await (const _event of model.stream({ ...request, generation })) {} })()
  void run.catch(() => {})
  let reachedCredentials = false
  await Promise.race([entered.promise.then(() => { reachedCredentials = true }), run.catch(() => {})])
  expect(reachedCredentials).toBe(true)
  expect(calls).toBe(0)
  expired = true; released.resolve()
  await expect(run).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' })
  expect(calls).toBe(0)
  expect(reserves).toBe(1)
})
