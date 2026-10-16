import { expect, it } from 'vitest'
import { createBedrockClient } from '../src/index.ts'
import type { LLMRequest, LLMStreamEvent } from '@i-harness/llm-seam'
import { bedrockValidator } from '../src/request/validate.ts'
async function capture(signed = true) {
  let sends = 0, actual: any
  const runtime = { destroy() {}, async send(command: { input: unknown }) {
    sends++; actual = command.input
    return { $metadata: {}, stream: (async function* () {
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'plan', ...(signed ? { signature: 'captured' } : {}) } } } }
      yield { contentBlockStop: { contentBlockIndex: 0 } }
      yield { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'a', name: 'read' } } } }
      yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"x":1}' } } } }
      yield { contentBlockStop: { contentBlockIndex: 1 } }
    })() }
  } }
  const client = createBedrockClient({ model: 'fixture' }, runtime as any)
  const request: LLMRequest = { systemPrompt: 'system', tools: [], messages: [{ role: 'user', content: 'go' }] }
  let end: Extract<LLMStreamEvent, { type: 'end' }> | undefined
  for await (const event of (await client.prepare!(request)).withOutputCap(4096).stream()) if (event.type === 'end') end = event
  const replay: LLMRequest = { ...request, messages: [...request.messages, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: { x: 1 } }], providerContinuation: structuredClone(end!.providerContinuation) }, { role: 'tool', toolCallId: 'a', content: 'done' }] }
  return { client, replay, end: end!, get actual() { return actual }, sends: () => sends }
}
it('captures actual selected-command prefix/calls/order and preserves subsequent history', async () => {
  const f = await capture()
  expect(f.actual.inferenceConfig.maxTokens).toBe(4096)
  expect(f.end.providerContinuation).toMatchObject({ contentOrder: [{ kind: 'reasoning', index: 0 }, { kind: 'tool', index: 0 }], producerWitness: { callCount: 1 } })
  expect((await f.client.prepare!({ ...f.replay, messages: [...f.replay.messages, { role: 'user', content: 'next' }] })).validation?.native).toBe('preserved')
})
it('independently refuses changed native tool input in the final SDK command', async () => {
  const f = await capture()
  for await (const _ of (await f.client.prepare!(f.replay)).stream()) {}
  const changed = structuredClone(f.actual)
  changed.messages[1].content[1].toolUse.input.x = 2
  expect(bedrockValidator({ model: 'fixture' }, false, f.replay.messages)(changed, { kind: 'sdk-command-estimate', sdkCommandBytesEstimate: 1 })).toMatchObject({ kind: 'rejected', reason: 'native-replay' })
})
it('blocks signed preceding-message drift, while unsigned reasoning stays valid', async () => {
  const signed = await capture(), unsigned = await capture(false)
  for (const f of [signed, unsigned]) f.replay.messages[0] = { role: 'user', content: 'changed' }
  await expect(signed.client.prepare!(signed.replay)).rejects.toMatchObject({ modelFailure: { reason: 'native-replay' } })
  await expect(unsigned.client.prepare!(unsigned.replay)).resolves.toBeDefined()
  expect(signed.sends()).toBe(1); expect(unsigned.sends()).toBe(1)
})
it('keeps system/tool-surface-only changes partial without treating them as signed-prefix drift', async () => {
  const f = await capture()
  const prepared = await f.client.prepare!({ ...f.replay, systemPrompt: 'changed surface' })
  expect(prepared.validation).toMatchObject({ native: 'unverified', status: 'partial' })
})
it.each(['args', 'call-order', 'stale-order', 'unknown-version'] as const)('refuses native %s alteration before send', async mutation => {
  const f = await capture(), assistant = f.replay.messages[1] as any
  if (mutation === 'args') assistant.toolCalls[0].args.x = 2
  if (mutation === 'call-order') assistant.toolCalls[0].id = 'changed'
  if (mutation === 'stale-order') assistant.providerContinuation.contentOrder = [{ kind: 'text', text: 'stale' }]
  if (mutation === 'unknown-version') assistant.providerContinuation.producerWitness.version = 2
  await expect(f.client.prepare!(f.replay)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.sends()).toBe(1)
})
