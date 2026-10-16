import { afterEach, expect, it, vi } from 'vitest'
import { createAnthropicClient } from '../src/index.ts'
afterEach(() => vi.unstubAllGlobals())
const request = { systemPrompt: '', tools: [], messages: [{ role: 'user' as const, content: 'go' }] }
it('preserves scoped nullable metadata and effort on original/capped/restored actual bodies', async () => {
  const bodies: any[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response('') })
  const options = { metadata: { user_id: null }, output_config: { effort: null } }
  const prepared = await createAnthropicClient({ apiKey: 'controlled', model: 'claude-sonnet-4-6', options }).prepare!(request)
  for (const candidate of [prepared, prepared.withOutputCap(32), prepared.withOutputCap(32).withOutputCap(undefined)]) for await (const _ of candidate.stream()) {}
  for (const body of bodies) { expect(body.metadata).toEqual(options.metadata); expect(body.output_config).toEqual(options.output_config) }
})
it.each([{ metadata: { user_id: 7 } }, { metadata: { user_id: 'x'.repeat(513) } }, { output_config: { effort: 'banana' } }, { output_config: { effort: 7 } }, { service_tier: 7 }, { service_tier: 'banana' }, { service_tier: null }, { temperature: -1 }, { top_p: 2 }, { top_k: -1 }])('rejects known malformed non-null values %j without send', async options => {
  let sends = 0
  vi.stubGlobal('fetch', async () => { sends++; return new Response('') })
  await expect(createAnthropicClient({ apiKey: 'controlled', model: 'claude-sonnet-4-6', options }).prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'schema' } })
  expect(sends).toBe(0)
})
it.each(['low', 'medium', 'high', 'xhigh', 'max', null])('accepts the exact nullable effort alternatives %s', async effort => {
  await expect(createAnthropicClient({ apiKey: 'controlled', model: 'claude-sonnet-4-6', options: { output_config: { effort }, service_tier: 'standard_only' } }).prepare!(request)).resolves.toBeDefined()
})
it('keeps present-null effort identity distinct from absent effort in actual producer witnesses', async () => {
  vi.stubGlobal('fetch', async () => new Response('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":"s"}}\n\ndata: {"type":"content_block_stop","index":0}\n\ndata: {"type":"message_stop"}\n\n'))
  const identities: string[] = []
  for (const options of [{}, { output_config: { effort: null } }]) for await (const event of createAnthropicClient({ apiKey: 'controlled', model: 'fixture', options }).stream(request)) if (event.type === 'end' && event.providerContinuation?.kind === 'anthropic') identities.push(event.providerContinuation.producerWitness!.effortConfigId)
  expect(identities).toHaveLength(2); expect(identities[0]).not.toBe(identities[1])
})
