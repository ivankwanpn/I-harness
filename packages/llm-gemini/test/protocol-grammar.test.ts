import { expect, it } from 'vitest'
import { geminiValidator } from '../src/request/validate.ts'
const packet = { kind: 'http-json-body', bodyBytes: 1 } as const
const contents = [{ role: 'user', parts: [{ text: 'go' }] }, { role: 'model', parts: [{ text: '', thoughtSignature: 'cw==' }, { functionCall: { id: 'a', name: 'read', args: { literal_key: null } }, thoughtSignature: 's' }, { functionCall: { id: 'b', name: 'read', args: {} } }] }, { role: 'user', parts: [{ functionResponse: { id: 'b', name: 'read', response: {} } }, { functionResponse: { id: 'a', name: 'read', response: {} } }] }]
const validate = (value: unknown, model = 'fixture') => geminiValidator({ apiKey: 'controlled', model })(value, packet)
it('accepts literal first-only call signatures and signed empty text', () => expect(validate({ contents }, 'gemini-4-argon').kind).toBe('accepted'))
it.each(['missing', 'duplicate', 'orphan', 'before', 'name'] as const)('refuses literal %s outcome binding', mutation => {
  const copy = structuredClone(contents) as any
  if (mutation === 'missing') copy[2].parts.pop()
  if (mutation === 'duplicate') copy[2].parts.push(copy[2].parts[0])
  if (mutation === 'orphan') copy[2].parts[1].functionResponse.id = 'c'
  if (mutation === 'before') copy.reverse()
  if (mutation === 'name') copy[2].parts[1].functionResponse.name = 'other'
  expect(validate({ contents: copy })).toMatchObject({ kind: 'rejected', reason: 'message-order' })
})
it('distinguishes no-ID distinct-name groups from ambiguous same-name groups', () => {
  const value: any = { contents: [{ role: 'model', parts: [{ functionCall: { name: 'a' } }, { functionCall: { name: 'b' } }] }, { role: 'user', parts: [{ functionResponse: { name: 'b', response: {} } }, { functionResponse: { name: 'a', response: {} } }] }] }
  expect(validate(value).kind).toBe('accepted')
  value.contents[0]!.parts[1]!.functionCall!.name = 'a'
  expect(validate(value)).toMatchObject({ kind: 'rejected', reason: 'unsupported-parameter', report: { gaps: expect.arrayContaining(['native-contract-unavailable']) } })
})
it.each([null, { maxOutputTokens: null, thinkingConfig: null }, { max_output_tokens: '2.048e3', thinking_config: { thinking_budget: null } }])('accepts optional ProtoJSON unset/numeric syntax %j', generation_config => {
  expect(validate({ contents, generation_config }).kind).toBe('accepted')
})
it.each([{ maxOutputTokens: '2147483648' }, { maxOutputTokens: '1.00000000000000001' }, { maxOutputTokens: 3, max_output_tokens: 3 }, { thinkingConfig: { thinkingBudget: true } }])('refuses nonrepresentable/ambiguous known fields %j', generationConfig => {
  expect(validate({ contents, generationConfig }).kind).toBe('rejected')
})
it.each([null, [null], [{ role: 'user', parts: [null] }], [{ role: 'user', parts: [{ text: 'x', inline_data: { mime_type: 'image/png', data: 'cw==' } }] }]])('does not confuse repeated null or part unions with Struct data: %j', value => {
  expect(validate({ contents: value }).kind).toBe('rejected')
})
it.each(['gemini-3.8-flash', 'gemini-4-argon'])('requires only the first current-step signature for %s', model => {
  const copy = structuredClone(contents) as any
  delete copy[1].parts[1].thoughtSignature
  expect(validate({ contents: copy }, model)).toMatchObject({ kind: 'rejected', reason: 'native-replay' })
  expect(validate({ contents: copy }, 'gemini-2.5-flash').kind).toBe('accepted')
  expect(validate({ contents: copy }, model + '-future').kind).toBe('accepted')
  expect(validate({ contents: [...copy, { role: 'user', parts: [{ text: 'new turn' }] }] }, model).kind).toBe('accepted')
})
it('blocks unsupported replay-essential lifecycle but retains inert extensions partial', () => {
  expect(validate({ contents, continuation_token: 'opaque' }).kind).toBe('rejected')
  expect(validate({ contents, futureOption: true })).toMatchObject({ kind: 'accepted', report: { status: 'partial' } })
})
it.each(['gemini-3.8-flash', 'gemini-4-argon'])('keeps evidenced thinking-level restrictions separate from unknown %s aliases', model => {
  const value = { contents, generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' } } }
  expect(validate(value, model).kind).toBe('rejected')
  expect(validate(value, model + '-future')).toMatchObject({ kind: 'accepted', report: { status: 'partial' } })
  expect(validate({ contents, generationConfig: { thinkingConfig: { thinkingLevel: 'high', thinkingBudget: 2048 } } }, model).kind).toBe(model === 'gemini-4-argon' ? 'rejected' : 'accepted')
})
it('reads the published numeric BLOCKING/NON_BLOCKING values and terminal false correctly', () => {
  expect(validate({ contents, tools: [{ functionDeclarations: [{ name: 'read', behavior: 1 }] }] }).kind).toBe('accepted')
  expect(validate({ contents, tools: [{ functionDeclarations: [{ name: 'read', behavior: 2 }] }] }).kind).toBe('rejected')
  const copy = structuredClone(contents) as any
  copy[2].parts[0].functionResponse.willContinue = false
  expect(validate({ contents: copy }).kind).toBe('accepted')
})
it.each([{ toolConfig: 7 }, { tools: [{ functionDeclarations: [{ name: 'read', parameters: {}, parameters_json_schema: {} }] }] }, { tools: [{ functionDeclarations: [{ name: 'read', response: {}, response_json_schema: {} }] }] }])('refuses unsupported known envelope/oneof combinations %j', options => {
  expect(validate({ contents, ...options }).kind).toBe('rejected')
})
