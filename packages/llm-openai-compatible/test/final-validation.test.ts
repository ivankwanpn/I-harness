import { afterEach, expect, it, vi } from 'vitest'
import { createOpenAICompatibleClient } from '../src/index.ts'
const request = { systemPrompt: '', messages: [], tools: [] }
const calls = { role: 'assistant', content: 'narration', tool_calls: ['a', 'b'].map(id => ({ id, type: 'function', function: { name: 'old_tool', arguments: '{}' } })) }
const out = (id: string) => ({ role: 'tool', tool_call_id: id, content: 'result' })
afterEach(() => vi.unstubAllGlobals())
it('direct Chat streaming refuses the final malformed body with zero sends', async () => {
  const transport = vi.fn(); vi.stubGlobal('fetch', transport)
  const events = []; for await (const event of createOpenAICompatibleClient({ apiKey: '', model: 'm', options: { messages: null } }).stream(request)) events.push(event)
  expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'INVALID_ARGUMENT', modelFailure: expect.objectContaining({ reason: 'schema' }) }) }])
  expect(transport).not.toHaveBeenCalled()
})
it.each([
  { messages: null }, { messages: [null] }, { messages: [calls, out('a')] },
  { previous_response_id: 'remote', messages: [calls, out('a')] },
  { messages: [calls, out('a'), { role: 'user', content: 'steer' }, out('b')] },
  { messages: [calls, out('a'), out('a'), out('b')] }, { messages: [out('a')] },
  { max_tokens: 2, max_completion_tokens: 3 }, { max_tokens: 'bad' }, { model: 'other' },
  { messages: [calls, { ...out('a'), content: [{ type: 'image_url', image_url: { url: 'https://image.invalid' } }] }, out('b')] },
  { messages: [{ role: 'assistant', content: null, function_call: { name: 'legacy', arguments: '{}' } }] },
  { messages: [{ role: 'assistant', content: null, function_call: { name: 'legacy', arguments: '{}' } }, { role: 'function', name: 'other', content: 'result' }] },
  { messages: [{ role: 'assistant', content: null, function_call: 'bad' }] },
  { temperature: 'bad' }, { stream_options: [] }, { response_format: [] },
  { tools: [{ type: 'function', function: { name: 'x', description: 42, parameters: {} } }] },
])('rejects final malformed Chat with no send: %j', async options => {
  const transport = vi.fn(); vi.stubGlobal('fetch', transport)
  await expect(createOpenAICompatibleClient({ apiKey: '', model: 'm', baseUrl: 'https://fake.invalid', options }).prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { validation: { status: 'invalid' } } })
  expect(transport).not.toHaveBeenCalled()
})
it('accepts reversed sibling results and native reasoning with absent historic registry', async () => {
  const prepared = await createOpenAICompatibleClient({ apiKey: '', model: 'unknown', baseUrl: 'https://fake.invalid', options: { messages: [{ ...calls, reasoning_content: 'native' }, out('b'), out('a'), { role: 'user', content: 'steer' }] } }).prepare!(request)
  expect(prepared.validation).toMatchObject({ route: 'openai-compatible', status: 'partial', native: 'unverified' })
})
it('preserves deprecated raw function-call grammar with explicit partial coverage', async () => {
  const messages = [{ role: 'assistant', content: null, function_call: { name: 'legacy', arguments: '{}' } }, { role: 'function', name: 'legacy', content: null }]
  let body: any
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response('') })
  const prepared = await createOpenAICompatibleClient({ apiKey: '', model: 'm', options: { messages } }).prepare!(request)
  expect(prepared.validation).toMatchObject({ status: 'partial', gaps: expect.arrayContaining(['extension-unchecked']) })
  for await (const _ of prepared.stream()) {}
  expect(body.messages).toEqual(messages)
})
it('discloses unchecked nested message extensions', async () => {
  const prepared = await createOpenAICompatibleClient({ apiKey: '', model: 'm', options: { messages: [{ role: 'user', content: 'hello', vendor_extension: { opaque: true } }] } }).prepare!(request)
  expect(prepared.validation?.gaps).toContain('extension-unchecked')
})
it.each([
  [{ role: 'assistant', content: null, refusal: 'declined' }],
  [{ role: 'assistant', content: null, reasoning_content: 'retained native reasoning' }],
])('retains known nullable assistant alternatives: %j', async message => {
  await expect(createOpenAICompatibleClient({ apiKey: '', model: 'm', options: { messages: [message] } }).prepare!(request)).resolves.toBeDefined()
})
it('encodes direct tool images as user companions after the whole sibling group', async () => {
  const image = { mediaType: 'image/png' as const, dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }
  let body: any
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response('') })
  const client = createOpenAICompatibleClient({ apiKey: '', model: 'm', inputModalities: ['text', 'image'] })
  const prepared = await client.prepare!({ ...request, messages: [
    { role: 'assistant', content: 'original narration', toolCalls: [{ id: 'a', name: 'old', args: {} }, { id: 'b', name: 'old', args: {} }] },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'real a' }, { type: 'image', image }] },
    { role: 'tool', toolCallId: 'b', content: 'real b' }, { role: 'user', content: 'real human steer' },
  ] })
  for await (const _ of prepared.stream()) {}
  expect(body.messages.map((m: any) => m.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'user'])
  expect(body.messages[1].content).toEqual([{ type: 'text', text: 'real a' }])
  expect(body.messages[3].content).toEqual([{ type: 'image_url', image_url: { url: `data:image/png;base64,${image.dataBase64}` } }])
  expect(body.messages[4].content).toBe('real human steer')
})
