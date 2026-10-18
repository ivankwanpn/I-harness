import { afterEach, expect, it, vi } from 'vitest'
import { createGeminiClient } from '../src/index.ts'
afterEach(() => vi.unstubAllGlobals())
const request = { systemPrompt: '', tools: [], messages: [{ role: 'user' as const, content: 'go' }] }
it.each([{ temperature: { invalid: true } }, { candidateCount: [] }, { stopSequences: 7 }, { temperature: 3 }, { topP: {} }, { topK: [] }, { seed: {} }, { presencePenalty: {} }, { frequencyPenalty: [] }, { responseMimeType: [] }, { responseSchema: [] }, { responseSchema: {}, responseJsonSchema: {} }, { thinkingConfig: { thinkingLevel: 'banana' } }, { stop_sequences: ['x', null] }])('rejects malformed known generation field %j before send', async generationConfig => {
  let sends = 0
  vi.stubGlobal('fetch', async () => { sends++; return new Response('') })
  await expect(createGeminiClient({ apiKey: 'controlled', model: 'gemini-2.5-flash', options: { generationConfig } }).prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'schema' } })
  expect(sends).toBe(0)
})
it.each([{ functionCallingConfig: { mode: 'banana' } }, { functionCallingConfig: { mode: {} } }])('rejects malformed known function-calling enum %j', async toolConfig => {
  await expect(createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { toolConfig } }).prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})
it('preserves legal numeric strings, aliases and nulls through actual original/capped/restored derivatives', async () => {
  const generation_config = { temperature: '1.25e0', candidate_count: '2', top_p: '.9', top_k: '32', seed: '-7', stop_sequences: ['done'], presence_penalty: '-.5', frequency_penalty: null, response_mime_type: 'application/json', response_json_schema: { type: 'object', properties: { literal_key: { const: null } } }, max_output_tokens: '2048' }
  const bodies: any[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response('') })
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'gemini-2.5-flash', options: { generation_config } }).prepare!(request)
  for (const candidate of [prepared, prepared.withOutputCap(32), prepared.withOutputCap(32).withOutputCap(undefined)]) for await (const _ of candidate.stream()) {}
  expect(bodies[0].generation_config).toEqual(generation_config)
  expect(bodies[1].generationConfig).toEqual({ ...generation_config, max_output_tokens: undefined, maxOutputTokens: 32 })
  expect(bodies[2].generation_config).toEqual(generation_config)
})
it('retains optional null and unknown enum coverage without coercing malformed supported values', async () => {
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { generationConfig: { temperature: null, candidateCount: null, stopSequences: null, thinkingConfig: { thinkingLevel: 99 } } } }).prepare!(request)
  expect(prepared.validation?.gaps).toContain('extension-unchecked')
})
it.each([{ cachedContent: [] }, { labels: [] }, { labels: { label: 7 } }, { safetySettings: 7 }])('refuses malformed known root envelopes %j', async options => {
  await expect(createGeminiClient({ apiKey: 'controlled', model: 'fixture', options }).prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})
