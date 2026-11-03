import { expect, it } from 'vitest'
import { deriveSearchText, type SessionEvent } from '../src/index.ts'
import type { LLMMessage } from '../src/projection/types.ts'

function group(messages: LLMMessage[]): Extract<SessionEvent, { type: 'conversation/seed-group' }> {
  return { type: 'conversation/seed-group', version: 1, seq: 1, manifestSeq: 0, ordinal: 0, group: {
    extent: { kind: 'unframed' }, items: [{ kind: 'input', extent: { kind: 'unframed' }, scope: 'turn', origins: [], sourceProvenance: [], input: { raw: [], derivedContext: [], media: [] }, messages }],
  } }
}

it('indexes only visible message content and normalized assistant calls in a seed group', () => {
  const event = group([
    { role: 'user', content: 'USER_VISIBLE' },
    { role: 'assistant', content: 'ASSISTANT_VISIBLE', toolCalls: [{ id: 'PRIVATE_CALL_ID', name: 'TOOL_VISIBLE', args: { path: 'ARGUMENT_VISIBLE', image: { url: 'PRIVATE_IMAGE_URL' }, audioUrl: 'PRIVATE_AUDIO_URL', dataBase64: 'PRIVATE_BASE64', content: [{ type: 'text', text: 'NESTED_VISIBLE' }, { type: 'image', data: 'PRIVATE_IMAGE_DATA' }] } }],
      thinkingBlocks: [{ type: 'thinking', thinking: 'PRIVATE_THINKING', signature: 'PRIVATE_SIGNATURE' }], providerContinuation: { kind: 'openai-compatible', reasoningContent: 'PRIVATE_NATIVE' } },
    { role: 'tool', toolCallId: 'PRIVATE_CALL_ID', content: 'BOUNDED_RESULT_VISIBLE' },
  ])
  expect(deriveSearchText(event)).toBe('USER_VISIBLE\nASSISTANT_VISIBLE\nTOOL_VISIBLE {"path":"ARGUMENT_VISIBLE","content":[{"type":"text","text":"NESTED_VISIBLE"},null]}\nBOUNDED_RESULT_VISIBLE')
})

it('indexes text parts and image metadata without image transport or attachment identity', () => {
  const event = group([{ role: 'user', content: [
    { type: 'text', text: 'FIRST_VISIBLE' },
    { type: 'image', image: { mediaType: 'image/png', dataBase64: 'U0VDUkVUX1RSQU5TUE9SVA==', name: 'VISIBLE_IMAGE', width: 2, height: 3, attachmentId: 'PRIVATE_ATTACHMENT' } },
    { type: 'text', text: 'SECOND_VISIBLE' },
  ] }, { role: 'tool', toolCallId: 'private', content: [{ type: 'text', text: 'TOOL_PART_VISIBLE' }] }])
  const text = deriveSearchText(event)
  expect(text).toContain('FIRST_VISIBLE')
  expect(text).toContain('image: VISIBLE_IMAGE 2x3 16B')
  expect(text).toContain('SECOND_VISIBLE')
  expect(text).toContain('TOOL_PART_VISIBLE')
  for (const hidden of ['U0VDUkVU', 'base64:', 'PRIVATE_ATTACHMENT', 'image/png']) expect(text).not.toContain(hidden)
})

it.each([['AA==', 1], ['AAA=', 2], ['AAAA', 3]] as const)('counts canonical base64 %s image bytes without decoding or indexing its payload', (dataBase64, bytes) => {
  const event = group([{ role: 'user', content: [{ type: 'image', image: { mediaType: 'image/png', name: 'VISIBLE', dataBase64 } }] }])
  expect(deriveSearchText(event)).toBe(`\nimage: VISIBLE ?x? ${bytes}B`)
})

it('does not observe seed metadata, native continuation or thinking outside the visible message slots', () => {
  const message: Extract<LLMMessage, { role: 'assistant' }> = { role: 'assistant', content: 'VISIBLE' }
  for (const key of ['thinkingBlocks', 'providerContinuation']) Object.defineProperty(message, key, { get() { throw new Error('Private native slot observed') } })
  const event = group([message])
  Object.defineProperty(event.group.items[0], 'origins', { get() { throw new Error('Origin table observed') } })
  expect(deriveSearchText(event)).toBe('VISIBLE')
  const manifest = { type: 'conversation/seed-manifest' } as SessionEvent
  Object.defineProperty(manifest, 'passive', { get() { throw new Error('Passive CodeStore observed') } })
  Object.defineProperty(manifest, 'artifacts', { get() { throw new Error('Artifact table observed') } })
  expect(deriveSearchText(manifest)).toBe('')
})
