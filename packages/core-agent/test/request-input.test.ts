import { expect, it } from 'vitest'
import { append, createSession } from '@i-harness/core-session'
import { captureContextSnapshot } from '@i-harness/context-engine'
import { buildContextRequest } from '../src/agent/request-input.ts'

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
