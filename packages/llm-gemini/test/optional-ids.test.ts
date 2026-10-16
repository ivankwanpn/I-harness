import { afterEach, expect, it, vi } from 'vitest'
import { createGeminiClient } from '../src/index.ts'
afterEach(() => vi.unstubAllGlobals())
it.each([[undefined, undefined], [null, undefined], [undefined, null], [null, null]])('uses optional ID null-as-unset consistently (%s, %s)', async (callId, resultId) => {
  const contents = [{ role: 'model', parts: ['read', 'write'].map(name => ({ functionCall: { name, ...(callId === undefined ? {} : { id: callId }), args: {} } })) }, { role: 'user', parts: ['write', 'read'].map(name => ({ functionResponse: { name, ...(resultId === undefined ? {} : { id: resultId }), response: {} } })) }]
  const bodies: any[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response('') })
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents } }).prepare!({ systemPrompt: '', tools: [], messages: [] })
  for (const candidate of [prepared, prepared.withOutputCap(32).withOutputCap(undefined)]) for await (const _ of candidate.stream()) {}
  expect(bodies.map(body => body.contents)).toEqual([contents, contents])
})
it('still blocks genuinely ambiguous same-name calls with absent/null IDs before send', async () => {
  let sends = 0
  vi.stubGlobal('fetch', async () => { sends++; return new Response('') })
  const contents = [{ role: 'model', parts: [{ functionCall: { name: 'read', id: null } }, { functionCall: { name: 'read' } }] }, { role: 'user', parts: [{ functionResponse: { name: 'read', response: {} } }, { functionResponse: { name: 'read', id: null, response: {} } }] }]
  await expect(createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents } }).prepare!({ systemPrompt: '', tools: [], messages: [] })).rejects.toMatchObject({ modelFailure: { reason: 'unsupported-parameter' } })
  expect(sends).toBe(0)
})
