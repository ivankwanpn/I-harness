import { expect, it } from 'vitest'
import { projectConversation } from '../src/conversation/project.ts'
import { createConversationIndex } from '../src/conversation/validation.ts'
import { CURRENT_FORMAT_VERSION, type Session, type SessionEvent } from '../src/events/types.ts'
import { createBootstrapManagedSessionState, createManagedIndexedView, createManagedSessionState } from '../src/managed/view.ts'
import { projectManagedConversation } from '../src/restoration-internal.ts'

const ownerSessionId = 'owner'
const fixture = (): Session => ({ formatVersion: CURRENT_FORMAT_VERSION, events: [
  { type: 'turn/start', seq: 0 }, { type: 'step/start', seq: 1 }, { type: 'user/message', text: 'request', seq: 2 },
  { type: 'tool/call', callId: 'read', name: 'read', args: { path: 'sample.txt' }, seq: 3 },
  { type: 'assistant/message', text: 'result', seq: 4 },
  { type: 'tool/result', callId: 'read', name: 'read', output: { text: 'contents' }, seq: 5 },
  { type: 'step/end', seq: 6 }, { type: 'turn/end', seq: 7 },
] })

it('projects an installed original with exactly the generic payload transformations and source order', () => {
  const state = createManagedSessionState(fixture(), { sessionId: ownerSessionId })
  state.bindOwner({})
  function read(readProjection: typeof projectManagedConversation) {
    const sources: string[] = []
    const projection = readProjection(state.view, { ownerSessionId, capturePayload(value, source) {
      sources.push(source.id)
      return typeof value === 'string' ? value.toUpperCase() : value
    } })
    expect(projection?.items.length).toBeGreaterThan(0)
    return { projection, sources }
  }
  expect(read(projectManagedConversation)).toEqual(read(projectConversation))
  const staged = state.stage([{ type: 'user/message', text: 'following request', seq: 8 }])
  expect(read(projectManagedConversation)).toEqual(read(projectConversation))
  staged.install()
  expect(read(projectManagedConversation)).toEqual(read(projectConversation))
  expect(read(projectManagedConversation).sources).toContain('["owner",8,"message"]')
  expect(projectConversation(state.view, { ownerSessionId, throughSeq: 7 }).items).toHaveLength(read(projectManagedConversation).projection!.items.length - 1)
})

it('only enrolls the exact bound ordinary view, with indexed, lineage and bootstrap readers left to strict replay', () => {
  const source = fixture(), original = createManagedSessionState(source, { sessionId: ownerSessionId }), owner = {}
  expect(projectManagedConversation(original.view, { ownerSessionId })).toBeUndefined()
  original.bindOwner(owner)
  expect(projectManagedConversation(original.view, { ownerSessionId: 'different' })).toBeUndefined()
  expect(projectManagedConversation(source, { ownerSessionId })).toBeUndefined()
  expect(projectManagedConversation({ ...original.view }, { ownerSessionId })).toBeUndefined()
  const indexed = createManagedIndexedView(original.view.events, source.formatVersion, source.header, createConversationIndex(source.events), owner, ownerSessionId)
  expect(projectManagedConversation(indexed.view, { ownerSessionId })).toBeUndefined()

  const lineage = createManagedSessionState({ ...source, header: { parentSession: 'parent', seedLength: 1 } }, { sessionId: ownerSessionId })
  const bootstrap = createBootstrapManagedSessionState(source, { sessionId: ownerSessionId })
  const legacy = createManagedSessionState({ ...source, formatVersion: 13 }, { sessionId: ownerSessionId })
  const repeatedSeq = createManagedSessionState({ ...source, events: [{ type: 'user/message', text: 'a', seq: 1 }, { type: 'user/message', text: 'b', seq: 1 }] }, { sessionId: ownerSessionId })
  for (const state of [lineage, bootstrap, legacy, repeatedSeq]) {
    state.bindOwner(owner)
    expect(projectManagedConversation(state.view, { ownerSessionId })).toBeUndefined()
    expect(projectConversation(state.view, { ownerSessionId }).items.length).toBeGreaterThan(0)
  }
})

it('refuses to publish an original projection if its capture installs a new frontier', () => {
  const state = createManagedSessionState(fixture(), { sessionId: ownerSessionId })
  state.bindOwner({})
  const staged = state.stage([{ type: 'user/message', text: 'reentrant request', seq: 8 }])
  expect(() => projectManagedConversation(state.view, { ownerSessionId, capturePayload(value) {
    staged.install()
    return value
  } })).toThrow('Original managed projection changed')
  expect(projectManagedConversation(state.view, { ownerSessionId })).toEqual(projectConversation(state.view, { ownerSessionId }))
})

it('declines a staged shallow frozen parent with mutable provenance without changing the normal projection', () => {
  const state = createManagedSessionState(fixture(), { sessionId: ownerSessionId })
  state.bindOwner({})
  const provenance: NonNullable<Extract<SessionEvent, { type: 'user/message' }>['provenance']> = {
    kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture',
  }
  const staged = state.stage([{ type: 'user/message', text: 'following request', seq: 8,
    input: Object.freeze({ inputId: 'input', intent: 'user', provenance }) }])
  expect(projectManagedConversation(state.view, { ownerSessionId })).toBeDefined()
  staged.install()
  expect(projectManagedConversation(state.view, { ownerSessionId })).toBeUndefined()
  expect(projectConversation(state.view, { ownerSessionId }).items.at(-1)?.provenance.scope).toBe('turn')
  provenance.scope = 'session'
  expect(projectConversation(state.view, { ownerSessionId }).items.at(-1)?.provenance.scope).toBe('session')
})

it('declines changed serializer behavior and keeps staged proof conservative after restoration', () => {
  const state = createManagedSessionState(fixture(), { sessionId: ownerSessionId })
  state.bindOwner({})
  const stringify = JSON.stringify
  let during: unknown = 'not evaluated'
  try {
    JSON.stringify = new Proxy<typeof stringify>(stringify, { apply: Reflect.apply })
    during = projectManagedConversation(state.view, { ownerSessionId })
    state.stage([{ type: 'user/message', text: 'new data', seq: 8 }]).install()
  } finally { JSON.stringify = stringify }
  expect(during).toBeUndefined()
  expect(projectManagedConversation(state.view, { ownerSessionId })).toBeUndefined()
  expect(projectConversation(state.view, { ownerSessionId }).items.at(-1)).toMatchObject({ kind: 'input' })
})
