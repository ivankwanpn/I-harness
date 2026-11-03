import { expect, it } from 'vitest'
import { createBedrockClient } from '../src/index.ts'
import type { LLMRequest } from '@i-harness/llm-seam'
const request: LLMRequest = { systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }, { id: 'b', name: 'read', args: {} }] }, { role: 'tool', toolCallId: 'b', content: '' }, { role: 'tool', toolCallId: 'a', content: 'ok' }] }
it('validates actual Converse sibling closure without historical authority', async () => {
  const client = createBedrockClient({ model: 'fixture' }, { send: async () => ({ $metadata: {} }), destroy() {} })
  expect((await client.prepare!(request)).validation).toMatchObject({ coverage: 'final-protocol' })
  await expect(client.prepare!({ ...request, messages: request.messages.slice(0, -1) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'message-order' } })
})
it('retains unsigned native no-call reasoning and produces a selected-command witness', async () => {
  let sent: any
  const client = createBedrockClient({ model: 'fixture' }, { destroy() {}, send: async command => {
    sent = command.input
    return { $metadata: {}, stream: (async function* () { yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'plan' } } } }; yield { contentBlockStop: { contentBlockIndex: 0 } } })() }
  } })
  let end: any
  for await (const event of (await client.prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }] })).stream()) if (event.type === 'end') end = event
  expect(end.providerContinuation).toMatchObject({ reasoningBlocks: [{ reasoningText: { text: 'plan' } }], producerWitness: { version: 1, callCount: 0 }, contentOrder: [{ kind: 'reasoning', index: 0 }] })
  const replay = await client.prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', providerContinuation: end.providerContinuation }, { role: 'user', content: 'next' }] })
  for await (const _ of replay.stream()) {}
  expect(sent.messages[1].content).toEqual([{ reasoningContent: { reasoningText: { text: 'plan' } } }])
})
it('retains unknown-capability direct tool images in an owned user companion', async () => {
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  let sent: any
  const client = createBedrockClient({ model: 'fixture', inputModalities: ['text', 'image'] }, { destroy() {}, send: async command => { sent = command.input; return { $metadata: {} } } })
  const prepared = await client.prepare!({ ...request, messages: [...request.messages.slice(0, -1), { role: 'tool', toolCallId: 'a', content: [{ type: 'image', image: { mediaType: 'image/png', dataBase64: image } }] }] })
  expect(prepared.measurement.input.components.images).toMatchObject({ imageCount: 1, binaryBytes: 70 })
  for await (const _ of prepared.stream()) {}
  expect(sent.messages[2].content[1].toolResult.content).toEqual([{ text: '[Adapter representation: image content from this tool result is supplied in the following user image companion.]' }])
  expect(sent.messages[3]).toEqual({ role: 'user', content: [{ image: { format: 'png', source: { bytes: Buffer.from(image, 'base64') } } }] })
})
