import { afterEach, expect, it, vi } from 'vitest'
import { createOpenAIClient } from '../src/index.ts'
import { responsesValidator } from '../src/request/validate.ts'
const request = { systemPrompt: '', messages: [], tools: [] }
const call = (id: string) => ({ type: 'function_call', call_id: id, name: 'historic_tool', arguments: '{"x":1}' })
const out = (id: string) => ({ type: 'function_call_output', call_id: id, output: 'sentinel-output' })
afterEach(() => vi.unstubAllGlobals())
it('direct streaming emits the same typed local rejection without a physical send', async () => {
  const transport = vi.fn(); vi.stubGlobal('fetch', transport)
  const events = []; for await (const event of createOpenAIClient({ apiKey: '', model: 'm', options: { input: [null] } }).stream(request)) events.push(event)
  expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'INVALID_ARGUMENT', modelFailure: expect.objectContaining({ reason: 'schema' }) }) }])
  expect(transport).not.toHaveBeenCalled()
})
it.each([
  { input: [null] }, { input: [call('a')] }, { input: [out('a'), call('a')] },
  { input: [call('a'), out('a'), out('a')] }, { input: [call('a'), call('a'), out('a')] },
  { input: [{ ...call('a'), arguments: '{broken' }, out('a')] },
  { previous_response_id: 'remote', input: [call('a')] },
  { previous_response_id: 'remote', input: [out('a'), call('a')] },
  { prompt: { id: 'saved' }, input: [out('a')] },
  { input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file' }] }, out('a')] },
  { input: [out('a'), { type: 'item_reference', id: 'remote' }] },
  { input: [{ ...call('a'), async: true }] },
  { model: 'different' }, { max_output_tokens: 'bad' },
  { tools: null }, { reasoning: [] }, { reasoning: { effort: 42 } }, { text: [] },
  { include: 42 }, { tool_choice: [] }, { stream_options: [] }, { prompt: 42 },
  { input: [{ role: 'user', content: [{ type: 'output_text', text: 'wrong site' }] }] },
  { input: [call('a'), { ...out('a'), output: [{ type: 'output_text', text: 'wrong site' }] }] },
  { input: [{ type: 'reasoning', summary: [{ type: 'input_text', text: 'wrong site' }] }] },
  { input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'valid-reference', image_url: {} }] }] },
])('rejects literal malformed final Responses without transport: %j', async options => {
  const transport = vi.fn(); vi.stubGlobal('fetch', transport)
  await expect(createOpenAIClient({ apiKey: 'fake', model: 'unknown-model', options }).prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { validation: { status: 'invalid' } } })
  expect(transport).not.toHaveBeenCalled()
})
it.each([
  { input: [call('a'), call('b'), out('b'), out('a')] },
  { input: [call('a'), { type: 'reasoning', summary: [] }, { type: 'web_search_call', id: 'hosted', status: 'completed', action: { type: 'search', query: 'x' } }, out('a')] },
  { previous_response_id: 'remote', input: [out('a')] },
  { input: [{ type: 'item_reference', id: 'remote' }, out('a')] },
  { input: [{ ...call('a'), async: true }, out('a')] }, { input: 'public string' },
  { input: [{ type: 'mcp_call', id: 'remote', name: 'hosted', arguments: '{}', server_label: 'server', status: null }] },
])('accepts independently constructed final Responses: %j', async options => {
  const prepared = await createOpenAIClient({ apiKey: 'fake', model: 'unknown-model', options }).prepare!(request)
  expect(prepared.validation).toMatchObject({ route: 'openai-responses', coverage: 'final-protocol' })
  expect(prepared.validation?.status).not.toBe('invalid')
})
it('moves model mismatch to a binding rejection and scopes output minimum', async () => {
  await expect(createOpenAIClient({ apiKey: '', model: 'm', options: { model: 'other' } }).prepare!(request)).rejects.toMatchObject({ modelFailure: { reason: 'binding' } })
  await expect(createOpenAIClient({ apiKey: '', model: 'm', options: { max_output_tokens: 15 } }).prepare!(request)).rejects.toMatchObject({ modelFailure: { reason: 'output-limit' } })
  const custom = await createOpenAIClient({ apiKey: '', model: 'm', baseUrl: 'https://custom.invalid', options: { max_output_tokens: 1 } }).prepare!(request)
  expect(custom.validation?.gaps).toContain('limit-unverified')
  expect(() => custom.withOutputCap(0)).toThrowError(expect.objectContaining({ modelFailure: expect.objectContaining({ reason: 'output-limit', validation: expect.objectContaining({ status: 'invalid' }) }) }))
})
it.each([
  { input: [{ role: 'user', content: [{ type: 'input_text', text: 'x', vendor_extension: true }] }] },
  { input: [{ ...call('a'), vendor_extension: true }, out('a')] },
  { tools: [{ type: 'function', name: 'x', parameters: {}, vendor_extension: true }] },
])('reports unknown nested extensions as partial instead of claiming complete checking: %j', async options => {
  const prepared = await createOpenAIClient({ apiKey: '', model: 'm', options }).prepare!(request)
  expect(prepared.validation).toMatchObject({ status: 'partial', gaps: expect.arrayContaining(['extension-unchecked']) })
})
it('retains unknown native alternatives while exposing no prompt, native bytes, arguments or IDs in the report', async () => {
  const options = { input: [{ type: 'future_native', opaque: 'sentinel-native-signature' }, { ...call('sentinel-call-id'), arguments: '{"private":"sentinel-args"}' }, out('sentinel-call-id')] }
  const prepared = await createOpenAIClient({ apiKey: '', model: 'm', options }).prepare!({ ...request, systemPrompt: 'sentinel-prompt' })
  expect(prepared.validation).toMatchObject({ status: 'partial', native: 'unverified', gaps: expect.arrayContaining(['native-contract-unavailable', 'extension-unchecked']) })
  expect(JSON.stringify(prepared.validation)).not.toContain('sentinel')
})
it.each([
  { store: true }, { stream: false }, { include: [] }, { max_output_tokens: 30 },
  { input: [{ ...call('a'), namespace: 'foreign' }, out('a')] },
  { tools: [{ type: 'function', name: 'unscoped', parameters: {} }] },
])('checks literal subscription restrictions independently of the builder: %j', override => {
  const result = responsesValidator({ model: 'm' }, true)({ model: 'm', input: [], tools: [], store: false, stream: true, include: ['reasoning.encrypted_content'], ...override }, { kind: 'http-json-body', bodyBytes: 1 })
  expect(result).toMatchObject({ kind: 'rejected', reason: 'unsupported-parameter', report: { route: 'openai-responses-subscription', contract: 'subscription-v1' } })
})
it('checks actual subscription namespace, absent cap, and immutable body/report through a real send', async () => {
  const bodies: any[] = []
  const { systemFetch } = await import('@i-harness/http-transport')
  // Subscription transport is supplied by its existing dedicated owner.
  vi.mock('@i-harness/http-transport', () => ({ systemFetch: vi.fn(async () => new Response('')) }))
  vi.mocked(systemFetch).mockImplementation(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response('') })
  const original = { systemPrompt: '', tools: [{ name: 'old', description: '', inputSchema: {} }], messages: [{ role: 'assistant' as const, content: '', toolCalls: [{ id: 'a', name: 'old', args: {} }] }, { role: 'tool' as const, toolCallId: 'a', content: 'actual outcome' }] }
  const client = createOpenAIClient({ apiKey: '', model: 'm', codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: 'fake', accountId: 'fake' }), options: { store: true, max_output_tokens: 100, stream: false } })
  const prepared = await client.prepare!(original), report = prepared.validation
  original.messages.length = 0
  for await (const _ of prepared.withOutputCap(1).stream()) {}
  expect(report).toMatchObject({ status: 'checked', route: 'openai-responses-subscription' })
  expect(Object.isFrozen(report)).toBe(true)
  expect(bodies[0]).toMatchObject({ store: false, stream: true, include: ['reasoning.encrypted_content'], tools: [{ type: 'namespace', name: 'ih' }], input: [{ type: 'function_call', namespace: 'ih' }, { type: 'function_call_output', call_id: 'a' }] })
  expect(bodies[0].max_output_tokens).toBeUndefined()
  expect(JSON.stringify(report)).not.toMatch(/actual outcome|fake|call_id|arguments/)
})
