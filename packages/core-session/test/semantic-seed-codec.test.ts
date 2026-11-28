import { expect, it } from 'vitest'
import { deriveMessages, fromJSONL, toJSONL, validateSemanticSeed, type SemanticSeedV1 } from '../src/index.ts'
import { literalSeed } from './fixtures/format11-seed.ts'
import { literalSession } from './fixtures/semantic-observation.ts'

it('rejects unknown native carriers and malformed thinking blocks after valid independent hashes', () => {
  for (const change of [
    (message: any) => { message.providerContinuation = { kind: 'unknown', payload: 'opaque' } },
    (message: any) => { message.providerContinuation = { kind: 'openai-responses', reasoningItems: [], receipt: 'forged' } },
    (message: any) => { message.providerContinuation = { kind: 'openai-responses', reasoningItems: [], deepSeekReplayFingerprint: 'invalid' } },
    (message: any) => { message.thinkingBlocks = [{ type: 'thinking', thinking: 'opaque', signature: 'sig', permission: true }] },
    (message: any) => { message.thinkingBlocks = [{ type: 'unknown' }] },
  ]) {
    const seed = structuredClone(literalSeed)
    change(seed.groups[0]!.items[1]!.messages[0]); literalSession(seed)
    expect(() => validateSemanticSeed(seed)).toThrow()
  }
})

it('retains the optional official DeepSeek Responses replay check through seeded journal reload', () => {
  const seed = structuredClone(literalSeed)
  const assistant = seed.groups[0]!.items[1]!.messages[0]!
  if (assistant.role !== 'assistant') throw new Error('Invalid fixture')
  assistant.providerContinuation = {
    kind: 'openai-responses', model: 'deepseek-flash', providerId: 'deepseek',
    reasoningItems: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'fixture' }] }],
    deepSeekReplayFingerprint: 'a'.repeat(64),
  }
  const session = literalSession(seed)
  validateSemanticSeed(seed)
  expect(deriveMessages(fromJSONL(toJSONL(session)))).toContainEqual(assistant)
})

it('rejects misordered tool exchanges and missing image companions after independent hash validation', () => {
  for (const change of [
    (seed: SemanticSeedV1) => { seed.groups[0]!.items[1]!.messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'same', name: 'read', args: {} }] }, { role: 'assistant', content: 'too early' }, { role: 'tool', toolCallId: 'same', content: 'seed exact' }]; const item = seed.groups[0]!.items[1]!; if (item.kind === 'exchange') item.results[0]!.message = 2 },
    (seed: SemanticSeedV1) => { seed.groups[0]!.items[1]!.messages = [...seed.groups[0]!.items[1]!.messages, { role: 'user', content: [{ type: 'image', image: { mediaType: 'image/png', dataBase64: 'AQID' } }] }] },
  ]) {
    const seed = structuredClone(literalSeed); change(seed); literalSession(seed)
    expect(() => validateSemanticSeed(seed)).toThrow()
  }
})
