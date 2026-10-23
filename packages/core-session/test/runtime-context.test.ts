import { expect, it } from 'vitest'
import { append, createSession, createNondurableFactOwner, projectConversation, projectConversationCandidate, renderConversation, toJSONL, fromJSONL, exportConversationSeed, validRuntimeContextRecord } from '../src/index.ts'
import { captureContextSnapshot } from '../../context-engine/src/index.ts'

const record = (text = 'rule') => ({ type: 'runtime/context' as const, version: 1 as const, sections: [{ name: 'instructions', text }] })
it('rejects non-closed records at append, captured publication and source projection without evaluating getters', async () => {
  let reads = 0
  const accessor = Object.defineProperty(record(), 'sections', { enumerable: true, get() { reads++; return [] } })
  const tagAccessor = Object.defineProperty(record(), 'type', { enumerable: true, get() { reads++; return 'runtime/context' } })
  const malformed = [accessor, tagAccessor, Object.assign(Object.create({ type: 'runtime/context' }), { version: 1, sections: [] }), { ...record(), ignorable: true }, { ...record(), authority: 'request' }, { ...record(), version: 2 },
    { ...record(), sections: [{ name: 'a', text: '' }, { name: 'a', text: '' }] }, { ...record(), sections: Array(1) },
    { ...record(), sections: [{ name: 'x'.repeat(129), text: '' }] }, { ...record(), sections: Array.from({ length: 65 }, (_, index) => ({ name: String(index), text: '' })) },
    Object.defineProperty(record(), 'hidden', { value: true }), { ...record(), [Symbol('authority')]: true }, { ...record(), seq: -1 }]
  for (const bad of malformed) {
    expect(validRuntimeContextRecord(bad)).toBe(false)
    expect(() => append(createSession(), bad as never)).toThrow()
    const owner = createNondurableFactOwner(createSession())
    expect(await owner.beginAction().captureRuntimeContext(bad as never, () => true).admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
    expect(() => projectConversation({ formatVersion: 12, events: [bad as never] })).toThrow()
  }
  expect(reads).toBe(0)
  const old = { formatVersion: 11, events: [] }
  expect(() => append(old, record())).toThrow()
})

it('round trips the current floor, protects only its source and keeps semantic seed codec1 stable', async () => {
  const session = createSession()
  append(session, { type: 'turn/start' }); append(session, { type: 'user/message', text: 'historical question' })
  append(session, { type: 'step/start' }); append(session, { type: 'assistant/message', text: 'historical answer' }); append(session, { type: 'step/end' }); append(session, { type: 'turn/end' })
  const action = createNondurableFactOwner(session).beginAction()
  expect(await action.captureRuntimeContext(record(), () => true).admit()).toMatchObject({ kind: 'memory-committed', durability: 'nondurable' })
  const before = exportConversationSeed(session, { kind: 'anonymous' }, { kind: 'all' })
  expect(before.kind).toBe('seed')
  await action.captureRuntimeContext(record('changed rule'), () => true).admit()
  expect(exportConversationSeed(session, { kind: 'anonymous' }, { kind: 'all' })).toEqual(before)
  const projection = projectConversation(session, { ownerSessionId: 'owner' })
  expect(renderConversation(projection).map(message => message.content)).toEqual(['## instructions\n\nchanged rule', 'historical question', 'historical answer'])
  expect(projectConversation(fromJSONL(toJSONL(session)))).toEqual(projectConversation(session))
  const capture = captureContextSnapshot(session, { ownerSessionId: 'owner', surface: { systemPrompt: '', tools: [] } })
  expect(capture.kind).toBe('captured')
  if (capture.kind !== 'captured') throw Error('capture required')
  expect(capture.snapshot.protection.sourceIds).toContain(projection.current!.source.id)
  expect(capture.snapshot.protection.itemIds).toEqual([])
  const candidate = projectConversationCandidate(session, [{ type: 'compaction/reset', removedSeqs: [6, 7] }], { candidateId: 'reset' })
  expect(candidate.projection.current?.sections).toEqual(record('changed rule').sections)
})

it('uses branch visibility and exact legacy metadata, including explicit clears', () => {
  const session = createSession()
  append(session, { type: 'user/message', text: 'old runtime', source: { kind: 'plugin', plugin: 'i-harness/runtime-context' }, internal: true })
  append(session, { type: 'user/message', text: 'ordinary feedback', source: { kind: 'plugin', plugin: 'i-harness/runtime-context' } })
  append(session, record('first'))
  append(session, record('second'))
  expect(projectConversation(session, { throughSeq: 2 }).current?.sections).toEqual(record('first').sections)
  append(session, { type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: 3, mode: 'conversation', fileOps: [] })
  expect(projectConversation(session).current?.sections).toEqual(record('first').sections)
  append(session, { type: 'runtime/context', version: 1, sections: [] })
  expect(renderConversation(projectConversation(session)).map(message => message.content)).toEqual(['ordinary feedback'])
  expect(renderConversation(projectConversation(session, { throughSeq: 1 })).map(message => message.content)).toEqual(['old runtime', 'ordinary feedback'])
})

it('retains seeded legacy session observations instead of treating them as the target floor', () => {
  const session = createSession()
  append(session, { type: 'user/message', text: 'parent historical runtime', internal: true, source: { kind: 'plugin', plugin: 'i-harness/runtime-context' } })
  session.header = { parentSession: 'parent', seedLength: 1 }
  append(session, record('target rule'))
  expect(renderConversation(projectConversation(session)).map(message => message.content)).toEqual(['## instructions\n\ntarget rule', 'parent historical runtime'])
})
