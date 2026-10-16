import { beforeEach, expect, it, vi } from 'vitest'
import { createBedrockClient } from '../src/index.ts'
import type { LLMRequest } from '@i-harness/llm-seam'
const sdk = vi.hoisted(() => ({ commands: [] as any[] }))
vi.mock('@aws-sdk/client-bedrock-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-bedrock-runtime')>()
  return { ...actual, BedrockRuntimeClient: class { async send(command: any) { sdk.commands.push(command.input); return { $metadata: {} } } destroy() {} } }
})
beforeEach(() => { sdk.commands.length = 0 })
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
it.each([false, true])('uses evidenced native tool images/status on actual AWS surface (isError=%s)', async isError => {
  const content: any[] = [{ type: 'text', text: 'original' }, { type: 'image', image: { mediaType: 'image/png', dataBase64: image } }]
  const request: LLMRequest = { systemPrompt: '', tools: [], messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }] }, { role: 'tool', toolCallId: 'a', content, ...(isError ? { isError: true } : {}) }] }
  const prepared = await createBedrockClient({ model: 'anthropic.claude-sonnet-4-6', region: 'us-east-1', inputModalities: ['text', 'image'] }).prepare!(request)
  for await (const _ of prepared.stream()) {}
  expect(sdk.commands[0].messages[1].content).toEqual([{ toolResult: { toolUseId: 'a', content: [{ text: 'original' }, { image: { format: 'png', source: { bytes: Buffer.from(image, 'base64') } } }], ...(isError ? { status: 'error' } : {}) } }])
  expect(prepared.measurement.input.components.images).toMatchObject({ imageCount: 1, binaryBytes: 70 })
})
it.each([false, true])('uses unknown-capability companions after complete same-name siblings (isError=%s)', async isError => {
  let sent: any
  const client = createBedrockClient({ model: 'custom-model', inputModalities: ['text', 'image'] }, { destroy() {}, async send(command) { sent = command.input; return { $metadata: {} } } })
  const prepared = await client.prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }, { id: 'b', name: 'read', args: {} }] }, { role: 'tool', toolCallId: 'a', content: [{ type: 'image', image: { mediaType: 'image/png', dataBase64: image } }], ...(isError ? { isError: true } : {}) }, { role: 'tool', toolCallId: 'b', content: 'B' }, { role: 'user', content: 'human' }] })
  for await (const _ of prepared.stream()) {}
  expect(sent.messages[1].content).toEqual([{ toolResult: { toolUseId: 'a', content: [...(isError ? [{ json: { isError: true } }] : []), { text: '[Adapter representation: image content from this tool result is supplied in the following user image companion.]' }] } }, { toolResult: { toolUseId: 'b', content: [{ text: 'B' }] } }])
  expect(sent.messages[2]).toEqual({ role: 'user', content: [{ image: { format: 'png', source: { bytes: Buffer.from(image, 'base64') } } }] })
  expect(sent.messages[3]).toEqual({ role: 'user', content: [{ text: 'human' }] })
  expect(prepared.measurement.input.components.images).toMatchObject({ imageCount: 1, binaryBytes: 70 })
})
