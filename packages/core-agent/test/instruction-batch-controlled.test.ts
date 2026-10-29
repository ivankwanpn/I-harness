import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSession } from '@i-harness/core-session'
import { wrapPreparedRequest, type ModelClient } from '@i-harness/llm-seam'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createAgent, type SessionRequestContext, type SuccessfulInstructionHandoff } from '../src/index.ts'

it('transfers the controlled accepted batch pin through original tool drain and releases an empty batch', async () => {
  const session = createSession(), ctx = createContext(), tools = createToolRegistry(ctx), token = Object.freeze({ kind: 'instruction-request' as const, version: 1 as const })
  let calls = 0, batchPins = 0, released = 0, bodyPins = 0
  const descriptors: SuccessfulInstructionHandoff['calls'][] = []
  const client = createOpenAICompatibleClient({ model: 'fixture', apiKey: 'local', fetch: async () => { throw Error('This controlled fixture does not use a physical transport') } })
  const model: ModelClient = { ...client, async prepare(request) {
    const prepared = await client.prepare!(request)
    return wrapPreparedRequest(prepared, (_stream, control) => (async function* () {
      const semantic = prepared.measurement.input.semanticIdentity!, payload = prepared.measurement.payloadIdentity!
      control?.confirmExecution?.({ version: 1, sendId: `fixture-${calls}`, semanticId: semantic.semanticId, payloadId: payload.id, payloadKind: payload.kind })
      control?.onTransportIssue?.()
      if (calls++ === 0) yield { type: 'tool_call' as const, call: { id: 'original', name: 'probe', args: { text: 'original' } } }
      else yield { type: 'text/chunk' as const, text: 'done' }
      yield { type: 'end' as const }
    })())
  } }
  const context: SessionRequestContext = { async reconcile() {}, capture: () => token, current: value => value === token,
    retain() { return { async release() {} } }, succeeded(handoff) {
      descriptors.push(handoff.calls); batchPins++
      let done = false
      return { bind() { return Object.freeze({ kind: 'accepted-instruction-call' as const }) }, async preflight() {}, async release() { if (!done) { done = true; batchPins--; released++ } } }
    }, promotedHumanRequest() {}, async close() {} }
  tools.register({ name: 'probe', description: '', inputSchema: {}, execute: async () => { bodyPins = batchPins; return 'ok' } })
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: 's', requestContext: context })
  expect(await agent.run('controlled fixture')).toMatchObject({ finalText: 'done' })
  expect(bodyPins).toBe(1); expect(batchPins).toBe(0); expect(released).toBe(2)
  expect(descriptors[0]).toMatchObject([{ callId: 'original', call: { name: 'probe', args: { text: 'original' } } }])
  expect(Object.isFrozen(descriptors[0])).toBe(true); expect(Object.isFrozen(descriptors[0]![0]!.call.args)).toBe(true)
  expect(descriptors[1]).toEqual([])
})

