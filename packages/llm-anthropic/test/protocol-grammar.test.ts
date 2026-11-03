import { expect, it } from 'vitest'
import { anthropicValidator } from '../src/request/validate.ts'
const packet = { kind: 'http-json-body', bodyBytes: 1 } as const
const body = { model: 'fixture', stream: true, max_tokens: 2048, messages: [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 'a', name: 'read', input: {} }, { type: 'text', text: 'checking' }, { type: 'tool_use', id: 'b', name: 'read', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b' }, { type: 'tool_result', tool_use_id: 'a', content: [] }, { type: 'text', text: 'continue' }] },
] }
const validate = (value: unknown) => anthropicValidator({ apiKey: 'controlled', model: 'fixture' })(value, packet)
it('accepts reversed siblings, empty signed thinking and native empty results', () => expect(validate(body).kind).toBe('accepted'))
it.each(['missing', 'duplicate', 'orphan', 'before', 'text-first'] as const)('refuses literal %s outcomes independent of legacy ownership', mutation => {
  const copy = structuredClone(body) as any
  if (mutation === 'missing') copy.messages[2].content.splice(1, 1)
  if (mutation === 'duplicate') copy.messages[2].content.splice(1, 0, copy.messages[2].content[0])
  if (mutation === 'orphan') copy.messages[2].content[1].tool_use_id = 'c'
  if (mutation === 'before') copy.messages.reverse()
  if (mutation === 'text-first') copy.messages[2].content.unshift({ type: 'text', text: 'early' })
  expect(validate(copy)).toMatchObject({ kind: 'rejected', reason: 'message-order' })
})
it.each(['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5', 'claude-sonnet-4-6'])('applies evidenced manual interleaving for %s', model => {
  const value = { ...body, model, thinking: { type: 'enabled', budget_tokens: 4096 } }
  expect(anthropicValidator({ apiKey: 'controlled', model })(value, packet).kind).toBe('rejected')
  expect(anthropicValidator({ apiKey: 'controlled', model, headers: { 'Anthropic-Beta': 'interleaved-thinking-2025-05-14' } })(value, packet).kind).toBe('accepted')
})
it.each(['claude-haiku-4-5-20251001', 'claude-opus-4-6'])('does not invent beta interleaving for %s', model => {
  expect(anthropicValidator({ apiKey: 'controlled', model, headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } })({ ...body, model, thinking: { type: 'enabled', budget_tokens: 4096 } }, packet).kind).toBe('rejected')
})
it.each(['claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'])('limits manual support to closed model rows: %s', model => {
  expect(anthropicValidator({ apiKey: 'controlled', model })({ ...body, model, thinking: { type: 'enabled', budget_tokens: 1024 } }, packet).kind).toBe('rejected')
  expect(anthropicValidator({ apiKey: 'controlled', model })({ ...body, model, thinking: { type: 'adaptive' } }, packet).kind).toBe('accepted')
})
it('retains unknown/custom capability as usable partial without a guessed floor', () => {
  const model = 'claude-opus-4-99', value = { ...body, model, thinking: { type: 'enabled', budget_tokens: 4096 } }
  expect(anthropicValidator({ apiKey: 'controlled', model })(value, packet)).toMatchObject({ kind: 'accepted', report: { status: 'partial' } })
  expect(anthropicValidator({ apiKey: 'controlled', model: 'claude-opus-4-7', baseUrl: 'https://custom.test' })({ ...value, model: 'claude-opus-4-7' }, packet).kind).toBe('accepted')
})
it.each(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'])('refuses the evidenced adaptive forced-choice exceptions: %s', model => {
  expect(anthropicValidator({ apiKey: 'controlled', model })({ ...body, model, thinking: { type: 'adaptive' }, tool_choice: { type: 'any' } }, packet).kind).toBe('rejected')
})
it('separates effort restrictions from generic schema and unknown extensions', () => {
  const model = 'claude-sonnet-5-5', validator = anthropicValidator({ apiKey: 'controlled', model })
  expect(validator({ ...body, model, thinking: { type: 'between_tools' }, output_config: { effort: 'high' } }, packet).kind).toBe('accepted')
  expect(validator({ ...body, model, thinking: { type: 'between_tools', budget_tokens: 1024 } }, packet).kind).toBe('rejected')
  expect(validator({ ...body, model, thinking: { type: 'between_tools' }, output_config: { effort: 'max' } }, packet).kind).toBe('rejected')
})
it.each(['claude-opus-5', 'claude-haiku-5-5'])('scopes disabled effort limits to the evidenced %s row', model => {
  const value = { ...body, model, thinking: { type: 'disabled' }, output_config: { effort: 'max' } }
  expect(anthropicValidator({ apiKey: 'controlled', model })(value, packet).kind).toBe('rejected')
  expect(anthropicValidator({ apiKey: 'controlled', model })({ ...value, output_config: { effort: 'high' } }, packet).kind).toBe('accepted')
  expect(anthropicValidator({ apiKey: 'controlled', model, baseUrl: 'https://custom.invalid' })(value, packet)).toMatchObject({ kind: 'accepted', report: { status: 'partial' } })
})
it('permits documented adaptive forced choice while refusing ordinary manual forced choice', () => {
  const model = 'claude-sonnet-4-6', validator = anthropicValidator({ apiKey: 'controlled', model })
  const value = { ...body, model, tool_choice: { type: 'any' } }
  expect(validator({ ...value, thinking: { type: 'adaptive' } }, packet).kind).toBe('accepted')
  expect(validator({ ...value, thinking: { type: 'enabled', budget_tokens: 1024 } }, packet).kind).toBe('rejected')
})
it.each([{ metadata: 7 }, { cache_control: { type: 'ephemeral', ttl: 7 } }, { tool_choice: { type: 'auto', disable_parallel_tool_use: 'yes' } }, { thinking: { type: 'adaptive', budget_tokens: 2048 } }])('refuses known malformed generation/cache envelopes %j', options => {
  expect(validate({ ...body, ...options }).kind).toBe('rejected')
})
it('scopes manual thinking-first to the continuing tool turn on an evidenced surface', () => {
  const value = structuredClone(body) as any
  value.model = 'claude-sonnet-4-6'; value.thinking = { type: 'enabled', budget_tokens: 1024 }
  value.messages[1].content.shift()
  value.messages[2].content.pop()
  const validator = anthropicValidator({ apiKey: 'controlled', model: value.model })
  expect(validator(value, packet).kind).toBe('rejected')
  value.messages.push({ role: 'assistant', content: 'completed answer' }, { role: 'user', content: 'new turn' })
  expect(validator(value, packet).kind).toBe('accepted')
})
