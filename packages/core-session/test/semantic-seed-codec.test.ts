import { expect, it } from 'vitest'
import { append, deriveMessages, exportConversationSeed, fromJSONL, toJSONL, validateSemanticSeed, type SemanticSeedV1 } from '../src/index.ts'
import { literalSeed } from './fixtures/format11-seed.ts'
import { literalSession } from './fixtures/semantic-observation.ts'

it('restores addressed legacy fork media to its tool and preserves an independent user image across a nested fork', () => {
  const seed = structuredClone(literalSeed), exchange = seed.groups[0]!.items[1]!
  if (exchange.kind !== 'exchange') throw Error('Expected literal exchange')
  const human = { mediaType:'image/png' as const, dataBase64:'AA==' }, tool = { ...human, dataBase64:'AQ==' }
  const marker = {type:'text' as const,text:'Attached image(s) from tool result:'}
  exchange.messages = [...exchange.messages,{role:'user',content:[marker,{type:'image',image:tool}]}]
  exchange.results[0]!.media = [{message:2,part:1}]
  const old = literalSession(seed)
  append(old,{type:'user/message',text:marker.text,images:[human]})
  const disk = toJSONL(old)
  const cold = fromJSONL(disk), original = toJSONL(cold), messages = deriveMessages(cold)
  expect(messages).toContainEqual({role:'tool',toolCallId:'same',content:[{type:'text',text:'seed exact'},{type:'image',image:tool}]})
  expect(messages.filter(row=>row.role==='user' && Array.isArray(row.content))).toEqual([{role:'user',content:[marker,{type:'image',image:human}]}])
  expect(toJSONL(cold)).toBe(original)
  const nested = exportConversationSeed(cold, {kind:'session',sessionId:'child'}, {kind:'all'})
  if (nested.kind!=='seed' || nested.seed.version!==1) throw Error('Expected a portable seed')
  expect(deriveMessages(fromJSONL(toJSONL(literalSession(nested.seed))))).toEqual(messages)
})

it('rejects unknown native carriers and malformed thinking blocks after valid independent hashes', () => {
  for (const change of [
    (message: any) => { message.providerContinuation = { kind: 'unknown', payload: 'opaque' } },
    (message: any) => { message.providerContinuation = { kind: 'openai-responses', reasoningItems: [], receipt: 'forged' } },
    (message: any) => { message.providerContinuation = { kind: 'openai-responses', reasoningItems: [], deepSeekReplayFingerprint: 'invalid' } },
    (message: any) => { message.providerContinuation = { kind: 'openai-responses', reasoningItems: [], replayEndpointFingerprint: 'https://example.test' } },
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

it.each([undefined, null, '9a'.repeat(32)])('preserves the Responses endpoint proof through a nested fork (%s)', proof => {
  const seed = structuredClone(literalSeed)
  const assistant = seed.groups[0]!.items[1]!.messages[0]!
  if (assistant.role !== 'assistant') throw new Error('Invalid fixture')
  assistant.providerContinuation = {
    kind: 'openai-responses', model: 'm', providerId: 'fixture',
    reasoningItems: [{ type: 'reasoning', id: 'r', encrypted_content: 'opaque-fixture' }],
    ...(proof !== undefined ? { replayEndpointFingerprint: proof } : {}),
  }
  const cold = fromJSONL(toJSONL(literalSession(seed)))
  const child = exportConversationSeed(cold, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
  if (child.kind !== 'seed' || child.seed.version !== 1) throw new Error('Missing fork seed')
  expect(deriveMessages(fromJSONL(toJSONL(literalSession(child.seed))))).toContainEqual(assistant)
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

it('rejects an authoritative failed envelope paired with a successful tool message', () => {
  const seed = structuredClone(literalSeed), item = seed.groups[0]!.items[1]!
  if (item.kind !== 'exchange') throw Error('Expected fixture exchange')
  const prior = item.results[0]!
  item.results = [{kind:'envelope',message:prior.message,source:prior.source,media:[],
    execution:{outcome:'failed',dispatch:'dispatched'},sourceRetention:{kind:'inline-observation',encodedBytes:1}}]
  item.calls[0]!.outcome = 'error'
  const tool = item.messages[prior.message]
  if (tool?.role !== 'tool') throw Error('Expected fixture tool')
  tool.isError = true
  literalSession(seed); expect(() => validateSemanticSeed(seed)).not.toThrow()
  delete tool.isError
  literalSession(seed); expect(() => validateSemanticSeed(seed)).toThrow()
})
