import { expect, it, vi } from 'vitest'
import { append, createSession, renderConversation, selectConversationMessages } from '@i-harness/core-session'
import * as coreSession from '@i-harness/core-session'
import { captureContextSnapshot } from '@i-harness/context-engine'
import { prepareModelRequest, type LLMRequest, type ModelClient } from '@i-harness/llm-seam'
import { projectionFingerprint } from '@i-harness/token-meter'
import type { TelemetryEvent } from '@i-harness/telemetry'
import { buildContextRequest } from '../src/agent/request-input.ts'
import { createStepInput } from '../src/agent/step-input.ts'

function capture() {
  const session = createSession()
  append(session, { type: 'user/message', text: 'task', images: [{ mediaType: 'image/png', dataBase64: 'aGVsbG8=' }] })
  append(session, { type: 'step/start' })
  append(session, { type: 'tool/call', callId: 'c', name: 'probe', args: { nested: [1, 2] } })
  append(session, { type: 'assistant/message', text: 'answer', thinkingBlocks: [{ type: 'thinking', thinking: 'reason', signature: 'signed' }],
    providerContinuation: { kind: 'anthropic', model: 'm', contentOrder: [{ kind: 'reasoning', index: 0 }, { kind: 'text', text: 'answer' }, { kind: 'tool', index: 0 }] } })
  append(session, { type: 'tool/result', callId: 'c', name: 'probe', output: 'result' })
  append(session, { type: 'step/end' })
  const captured = captureContextSnapshot(session, { ownerSessionId: 'owner', surface: { systemPrompt: 'system',
    tools: [{ name: 'probe', description: 'probe', inputSchema: { type: 'object', properties: { nested: { type: 'array' } } } }],
    maxOutputTokens: 600, reasoningEffort: 'high' } })
  if (captured.kind !== 'captured') throw Error('capture required')
  return { session, snapshot: captured.snapshot }
}
it('builds exact ordered captured text, image, tool and native data without effects', () => {
  const { session, snapshot } = capture(), before = JSON.stringify(snapshot), events = JSON.stringify(session.events)
  const signal = new AbortController().signal
  const requestScope = { sessionId: 'owner', turnId: 'turn' }
  const first = buildContextRequest(snapshot, { sessionId: 'owner', signal, requestScope })
  expect(first).toEqual({ requestScope, retryOutput: 'discard', sessionId: 'owner',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'task' }, { type: 'image', image: { mediaType: 'image/png', dataBase64: 'aGVsbG8=' } }] },
      { role: 'assistant', content: 'answer', toolCalls: [{ id: 'c', name: 'probe', args: { nested: [1, 2] } }],
        thinkingBlocks: [{ type: 'thinking', thinking: 'reason', signature: 'signed' }],
        providerContinuation: { kind: 'anthropic', model: 'm', contentOrder: [{ kind: 'reasoning', index: 0 }, { kind: 'text', text: 'answer' }, { kind: 'tool', index: 0 }] } },
      { role: 'tool', toolCallId: 'c', content: '"result"' },
    ], tools: [{ name: 'probe', description: 'probe', inputSchema: { type: 'object', properties: { nested: { type: 'array' } } } }],
    systemPrompt: 'system', maxOutputTokens: 600, reasoningEffort: 'high',
    promptCache: { key: 'ih_4c1029697ee358715d3a14a2add817c4b01651440de80837' }, signal })
  expect(first.signal).toBe(signal)
  expect(first.requestScope).toBe(requestScope)
  expect(buildContextRequest(snapshot, { sessionId: 'owner', signal, requestScope })).toEqual(first)
  expect(JSON.stringify(snapshot)).toBe(before); expect(JSON.stringify(session.events)).toBe(events)
  ;(first.tools[0]!.inputSchema as { properties: { nested: { type: string } } }).properties.nested.type = 'changed'
  const assistant = first.messages[1]!
  if (assistant.role === 'assistant') assistant.thinkingBlocks![0] = { type: 'redacted_thinking', data: 'changed' }
  expect(JSON.stringify(snapshot)).toBe(before)
})
it('accepts only captured conversation/surface and preserves absent optional fields', () => {
  const { snapshot } = capture()
  const request = buildContextRequest({ conversation: snapshot.conversation, surface: { systemPrompt: '', tools: [] } }, {})
  expect(request).not.toHaveProperty('sessionId'); expect(request).not.toHaveProperty('promptCache')
  expect(request).not.toHaveProperty('maxOutputTokens'); expect(request).not.toHaveProperty('reasoningEffort')
  expect(request).not.toHaveProperty('signal')
})

it('preserves the neutral fingerprint when selecting immutable messages', () => {
  const { snapshot } = capture()
  expect(projectionFingerprint(selectConversationMessages(snapshot.conversation)))
    .toBe(projectionFingerprint(renderConversation(snapshot.conversation)))
})

it('skips unobserved prefix work while preserving provider call timing and request data', async () => {
  const { session, snapshot } = capture()
  const received: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { received.push(request); yield { type: 'end' } } }
  const evidence = { model, snapshot, projectionRevision: 1, neutralFingerprint: projectionFingerprint(selectConversationMessages(snapshot.conversation)) }
  const rewriteObservation = vi.fn(() => coreSession.deriveProjectionRewrite(session))
  const emit = vi.fn<(event: TelemetryEvent) => void>()
  const base = { sessionId: 'owner', rewriteObservation }
  const telemetry = { emit, close() {} }
  const full = createStepInput({ ...base, telemetry })
  const timingOnly = createStepInput({ ...base, telemetry: { ...telemetry, wantsProviderPrefixContinuity: false } })
  const silent = createStepInput(base)
  const prepare = (input: typeof full) => input(undefined, undefined, () => 1, evidence).request
  const serializedMessages = vi.spyOn(coreSession, 'canonicalJsonData')
  const requests: LLMRequest[] = []
  try {
    requests.push(prepare(full))
    expect(serializedMessages).toHaveBeenCalledTimes(requests[0]!.messages.length)
    expect(rewriteObservation).toHaveBeenCalledOnce()
    serializedMessages.mockClear()
    rewriteObservation.mockClear()
    emit.mockClear()

    requests.push(prepare(timingOnly), prepare(timingOnly), prepare(silent))
    expect(serializedMessages).not.toHaveBeenCalled()
    expect(rewriteObservation).not.toHaveBeenCalled()
    expect(emit.mock.calls.map(([event]) => event)).toEqual(Array.from({ length: 2 }, () => ({
      type: 'provider/call', ts: expect.any(Number), data: { sessionId: 'owner', step: 1, messages: 3, tools: 1 },
    })))
  } finally {
    serializedMessages.mockRestore()
  }
  for (const request of requests) {
    const prepared = await prepareModelRequest(model, request)
    for await (const event of prepared.stream()) expect(event.type).toBe('end')
  }
  expect(received).toHaveLength(4)
  expect(received.slice(1)).toEqual(Array.from({ length: 3 }, () => received[0]))
})

it('still verifies unowned projections against the seam', () => {
  const { snapshot } = capture()
  let reads = 0
  const conversation = {
    ...snapshot.conversation,
    get items() { return ++reads === 1 ? snapshot.conversation.items : [] },
  }
  expect(() => buildContextRequest({ conversation, surface: snapshot.surface }, {})).toThrow(/derive from the session log/)
})
