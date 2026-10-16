import { expect, it } from 'vitest'
import { bedrockValidator } from '../src/request/validate.ts'
const packet = { kind: 'sdk-command-estimate', sdkCommandBytesEstimate: 1 } as const
const body = { modelId: 'fixture', messages: [{ role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: '' } } }, { toolUse: { toolUseId: 'a', name: 'read', input: null } }, { toolUse: { toolUseId: 'b', name: 'read', input: [1] } }] }, { role: 'user', content: [{ text: 'continuing' }, { toolResult: { toolUseId: 'b', content: [{ json: null }] } }] }, { role: 'user', content: [{ toolResult: { toolUseId: 'a', content: [{ text: 'ok' }] } }] }] }
const validate = (value: unknown) => bedrockValidator({ model: 'fixture' }, false)(value as any, packet)
it('accepts unsigned reasoning, JSON values and Converse-specific separated reverse outcomes', () => expect(validate(body).kind).toBe('accepted'))
it.each(['missing', 'duplicate', 'orphan', 'before', 'id'] as const)('refuses literal %s outcomes regardless legacy ownership', mutation => {
  const copy = structuredClone(body) as any
  if (mutation === 'missing') copy.messages.pop()
  if (mutation === 'duplicate') copy.messages.push(copy.messages[2])
  if (mutation === 'orphan') copy.messages[2].content[0].toolResult.toolUseId = 'c'
  if (mutation === 'before') copy.messages.reverse()
  if (mutation === 'id') copy.messages[0].content[1].toolUse.toolUseId = 'invalid/slash'
  expect(validate(copy)).toMatchObject({ kind: 'rejected', reason: 'message-order' })
})
it('retains typed redacted bytes and refuses JSON substitutions/union collisions', () => {
  const command = (reasoningContent: unknown) => ({ modelId: 'fixture', messages: [{ role: 'assistant', content: [{ reasoningContent }] }] })
  expect(validate(command({ redactedContent: new Uint8Array([1, 2, 3]) })).kind).toBe('accepted')
  expect(validate(command({ redactedContent: [1, 2, 3] })).kind).toBe('rejected')
  expect(validate(command({ redactedContent: new Uint8Array([1]), reasoningText: { text: '' } })).kind).toBe('rejected')
})
it('uses exact per-message image counts independently of SDK byte estimates', () => {
  const image = { image: { format: 'png', source: { bytes: new Uint8Array([1]) } } }
  expect(validate({ modelId: 'fixture', messages: [{ role: 'user', content: Array(20).fill(image) }] }).kind).toBe('accepted')
  expect(validate({ modelId: 'fixture', messages: [{ role: 'user', content: Array(21).fill(image) }] })).toMatchObject({ kind: 'rejected', reason: 'media-limit' })
})
it.each([{ tools: [{ toolSpec: null }] }, { tools: [], toolChoice: 'auto' }])('refuses known malformed tool-config envelopes %j', toolConfig => {
  expect(validate({ ...body, toolConfig }).kind).toBe('rejected')
})
