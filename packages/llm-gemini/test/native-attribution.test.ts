import { afterEach, expect, it, vi } from 'vitest'
import { createGeminiClient } from '../src/index.ts'
import type { LLMMessage } from '@i-harness/llm-seam'
afterEach(() => vi.unstubAllGlobals())
const continuation = (model: string) => ({ kind: 'gemini' as const, model, callSignatures: [], thoughtParts: [{ text: 'original thought', thoughtSignature: 'b2xk' }] })
const kept: LLMMessage = { role: 'assistant', content: 'visible', providerContinuation: { kind: 'gemini', model: 'fixture', callSignatures: [], textSignature: 'bmV3' } }
it.each([false, true])('blocks one opaque-only lost assistant even with another preserved signature=%s', async mixed => {
  let sends = 0
  vi.stubGlobal('fetch', async () => { sends++; return new Response('') })
  const messages: LLMMessage[] = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', providerContinuation: continuation('foreign') }, ...(mixed ? [{ role: 'user' as const, content: 'next' }, kept] : []), { role: 'user', content: 'continue' }]
  await expect(createGeminiClient({ apiKey: 'controlled', model: 'fixture' }).prepare!({ systemPrompt: '', tools: [], messages })).rejects.toMatchObject({ modelFailure: { reason: 'native-replay' } })
  expect(sends).toBe(0)
})
it.each(['visible', 'calls'] as const)('marks actual %s degradation unverified beside another preserved assistant', async kind => {
  const bodies: any[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return new Response('') })
  const messages: LLMMessage[] = [{ role: 'user', content: 'go' }, { role: 'assistant', content: kind === 'visible' ? 'original answer' : '', ...(kind === 'calls' ? { toolCalls: [{ id: 'a', name: 'read', args: {} }] } : {}), providerContinuation: continuation('foreign') }, ...(kind === 'calls' ? [{ role: 'tool' as const, toolCallId: 'a', content: 'real outcome' }] : []), { role: 'user', content: 'next' }, kept, { role: 'user', content: 'continue' }]
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'fixture' }).prepare!({ systemPrompt: '', tools: [], messages })
  expect(prepared.validation?.native).toBe('unverified')
  for await (const _ of prepared.stream()) {}
  expect(JSON.stringify(bodies[0])).toContain(kind === 'visible' ? 'original answer' : 'real outcome')
})
it('does not lend mapper preservation to an identical raw override', async () => {
  const contents = [{ role: 'model', parts: [{ text: 'visible', thoughtSignature: 'bmV3' }] }]
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents } }).prepare!({ systemPrompt: '', tools: [], messages: [kept] })
  expect(prepared.validation?.native).toBe('unverified')
})
it('preserves each compatible native-only assistant independently', async () => {
  const messages: LLMMessage[] = [{ role: 'assistant', content: '', providerContinuation: continuation('fixture') }, { role: 'user', content: 'next' }, kept]
  expect((await createGeminiClient({ apiKey: 'controlled', model: 'fixture' }).prepare!({ systemPrompt: '', tools: [], messages })).validation?.native).toBe('preserved')
})
