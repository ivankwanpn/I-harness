import { afterEach, expect, it, vi } from 'vitest'
import { createGeminiClient } from '../src/index.ts'
afterEach(() => vi.unstubAllGlobals())
const request = { systemPrompt: '', tools: [], messages: [{ role: 'user' as const, content: 'choose red or blue' }] }
const schema = { type: 'STRING', enum: ['red', 'blue'] }
it.each(['camel', 'snake'] as const)('preserves the first-party text/x.enum schema mode through actual %s original/capped/restored handles', async spelling => {
  const generation = spelling === 'camel' ? { responseMimeType: 'text/x.enum', responseSchema: schema, temperature: null } : { response_mime_type: 'text/x.enum', response_schema: schema, temperature: null }
  const options = spelling === 'camel' ? { generationConfig: generation } : { generation_config: generation }
  const bodies: any[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response('data: {"candidates":[{"content":{"parts":[{"text":"red"}]},"finishReason":"STOP"}]}\n\n') })
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'gemini-3.8-flash', options }).prepare!(request)
  expect(prepared.validation).toMatchObject({ coverage: 'final-protocol', status: 'partial', gaps: expect.arrayContaining(['extension-unchecked']) })
  for (const candidate of [prepared, prepared.withOutputCap(32), prepared.withOutputCap(32).withOutputCap(undefined)]) for await (const _ of candidate.stream()) {}
  expect(bodies[0][spelling === 'camel' ? 'generationConfig' : 'generation_config']).toEqual(generation)
  expect(bodies[1].generationConfig).toEqual({ ...generation, maxOutputTokens: 32 })
  expect(bodies[2][spelling === 'camel' ? 'generationConfig' : 'generation_config']).toEqual(generation)
})
it.each([
  { responseMimeType: 'text/plain', responseSchema: schema },
  { responseSchema: schema },
  { responseMimeType: null, responseSchema: schema },
  { responseMimeType: 'text/x.enum', responseSchema: [] },
  { responseMimeType: 'text/x.enum', responseSchema: schema, responseJsonSchema: {} },
  { responseMimeType: 7, responseSchema: schema },
])('retains proven MIME, malformed-envelope and oneof negatives %j before send', async generationConfig => {
  let sends = 0
  vi.stubGlobal('fetch', async () => { sends++; return new Response('') })
  await expect(createGeminiClient({ apiKey: 'controlled', model: 'gemini-3.8-flash', options: { generationConfig } }).prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'schema' } })
  expect(sends).toBe(0)
})
it('keeps a future MIME/schema combination explicitly partial without a guessed universal prohibition', async () => {
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { generationConfig: { responseMimeType: 'application/vnd.future', responseSchema: schema } } }).prepare!(request)
  expect(prepared.validation).toMatchObject({ status: 'partial', gaps: expect.arrayContaining(['extension-unchecked']) })
})
