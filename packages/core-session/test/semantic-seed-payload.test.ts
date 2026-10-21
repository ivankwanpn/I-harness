import { expect, it } from 'vitest'
import { append, createSession, exportConversationSeed, projectConversation, readConversationState } from '../src/index.ts'
import { literalSession } from './fixtures/semantic-observation.ts'

it('preserves human, plugin and child-report provenance and typed input media as historical observations', () => {
  const source = createSession(), image = { mediaType: 'image/png' as const, dataBase64: 'AQID' }
  append(source, { type: 'turn/start' })
  append(source, { type: 'agent/input/admitted', version: 1, inputId: 'human', text: 'human text', delivery: 'queue', intent: 'user', images: [image], provenance: { kind: 'human', authority: 'request', scope: 'session', producer: 'session.prompt' } })
  append(source, { type: 'user/message', text: 'human text', imageInputId: 'human', input: { inputId: 'human', intent: 'user' } })
  append(source, { type: 'user/message', text: 'plugin text', internal: true, source: { kind: 'plugin', plugin: 'plugin' }, provenance: { kind: 'plugin', authority: 'observation', scope: 'turn', producer: 'plugin' } })
  append(source, { type: 'user/message', text: 'child text', internal: true, provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'child.report' } })
  append(source, { type: 'turn/end' })
  const exported = exportConversationSeed(source, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
  expect(exported.kind).toBe('seed')
  if (exported.kind !== 'seed') throw Error('seed required')
  const items = exported.seed.groups.flatMap(group => group.items)
  expect(items.map(item => item.sourceProvenance)).toEqual([
    [{ origin: 0, kind: 'human', authority: 'request', scope: 'session', producer: 'session.prompt' }],
    [{ origin: 0, kind: 'plugin', authority: 'observation', scope: 'turn', producer: 'plugin' }],
    [{ origin: 0, kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'child.report' }],
  ])
  expect(items[0]).toMatchObject({ scope: 'session', input: { media: [{ message: 0, part: 1 }] }, messages: [{ role: 'user', content: [{ type: 'text', text: 'human text' }, { type: 'image', image }] }] })
  const target = literalSession(exported.seed), projection = projectConversation(target)
  expect(projection.items[0]!.provenance).toMatchObject({ kind: 'inherited', authority: 'observation', scope: 'session' })
  const state = readConversationState(target, projection)
  expect(state.kind === 'available' && state.state.itemIds).toContain(projection.items[0]!.id)
})

it('captures one exact result/catalog ref, exact wire text and tool image companions without reading artifact bodies', () => {
  const source = createSession(), image = { mediaType: 'image/png' as const, dataBase64: 'AQID' }
  const ref = { version: 1 as const, id: `ctxv1_${'c'.repeat(64)}`, revision: 'd'.repeat(64), codec: 'json-utf8-v1' as const, encodedBytes: 10, contentDigest: 'e'.repeat(64), completeness: 'complete' as const }
  const envelope = { version: 1 as const, execution: { outcome: 'succeeded' as const, dispatch: 'dispatched' as const }, preview: 'result preview', media: [image], retention: { kind: 'artifact' as const, ref }, dependencies: { kind: 'artifact-set' as const, ref, count: 2 } }
  append(source, { type: 'step/start' }); append(source, { type: 'tool/call', callId: 'ref', name: 'read', args: { z: 1, a: 2 } }); append(source, { type: 'assistant/message', text: '' })
  append(source, { type: 'tool/result', callId: 'ref', name: 'read', envelope }); append(source, { type: 'step/end' })
  const exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })
  expect(exported.kind).toBe('seed')
  if (exported.kind !== 'seed') throw Error('seed required')
  const item = exported.seed.groups[0]!.items[0]!
  expect(item.messages[1]!.content).toBe(JSON.stringify({ version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: 'result preview', retention: { kind: 'artifact', ref }, dependencies: { kind: 'artifact-set', ref, count: 2 } }))
  expect(item.messages[2]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, { type: 'image', image }] })
  expect(exported.seed.artifacts).toHaveLength(1)
  expect(exported.seed.artifacts[0]).toMatchObject({ ref, uses: [{ kind: 'result' }, { kind: 'dependency-catalog', count: 2 }] })
  expect(item).toMatchObject({ kind: 'exchange', results: [{ kind: 'envelope', sourceRetention: { kind: 'artifact', artifact: 0 }, dependencies: { kind: 'catalog', artifact: 0, count: 2 }, media: [{ message: 2, part: 1 }] }] })
})

it('preserves legacy result content without inventing execution or retention descriptors', () => {
  const source = createSession()
  append(source, { type: 'step/start' }); append(source, { type: 'tool/call', callId: 'legacy', name: 'read', args: {} }); append(source, { type: 'assistant/message', text: '' })
  append(source, { type: 'tool/result', callId: 'legacy', name: 'read', output: 'legacy' }); append(source, { type: 'step/end' })
  const exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })
  if (exported.kind !== 'seed') throw Error('seed required')
  expect(exported.seed.groups[0]!.items[0]).toMatchObject({ kind: 'exchange', messages: [{ role: 'assistant' }, { role: 'tool', content: '"legacy"' }], results: [{ kind: 'legacy', message: 1, media: [] }] })
  expect(JSON.stringify(exported.seed)).not.toContain('sourceRetention')
})

it('preserves a source-recorded legacy not-dispatched outcome without inventing an envelope', () => {
  const source = createSession()
  append(source, { type: 'step/start' }); append(source, { type: 'tool/call', callId: 'done', name: 'read', args: {} }); append(source, { type: 'assistant/message', text: '' })
  append(source, { type: 'tool/dispatch', callId: 'done', eventSeq: 1 }); append(source, { type: 'tool/result', callId: 'done', name: 'read', output: 'done' }); append(source, { type: 'step/end' })
  append(source, { type: 'tool/call', callId: 'aborted', name: 'read', args: {} })
  append(source, { type: 'tool/result', callId: 'aborted', name: 'read', isError: true, output: { code: 'TOOL_ABORTED_BEFORE_DISPATCH' } })
  expect(projectConversation(source).items.at(-1)!.exchange?.calls[0]!.outcome).toBe('not-dispatched')
  const exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })
  expect(exported.kind).toBe('seed')
  if (exported.kind !== 'seed') throw Error('seed required')
  expect(exported.seed.groups.at(-1)!.items[0]).toMatchObject({ kind: 'exchange', calls: [{ outcome: 'not-dispatched' }], results: [{ kind: 'legacy', isError: true }] })
})
