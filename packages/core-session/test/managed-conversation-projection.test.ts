import { expect, it, vi } from 'vitest'
import { projectConversation } from '../src/conversation/project.ts'
import { createConversationIndex } from '../src/conversation/validation.ts'
import * as conversationEvents from '../src/events/conversation.ts'
import { CURRENT_FORMAT_VERSION, type Session, type SessionEvent } from '../src/events/types.ts'
import { IMAGE_MEDIA_TYPES } from '../src/images.ts'
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

it('uses one shape check per original initial row and independently validates later staging', () => {
  const shape = vi.spyOn(conversationEvents, 'validateConversationEventShape')
  try {
    const original = fixture()
    const state = createManagedSessionState(original, { sessionId: ownerSessionId })
    expect(shape.mock.calls.map(([event]) => event.seq)).toEqual(original.events.map(event => event.seq))
    state.bindOwner({})
    shape.mockClear()

    const staged = state.stage([{ type: 'user/message', text: 'following request', seq: 8 }])
    expect(shape.mock.calls.map(([event]) => event.seq)).toEqual([8, 8, 8])
    expect(state.view.events).toHaveLength(original.events.length)
    staged.install()
    expect(projectManagedConversation(state.view, { ownerSessionId })).toEqual(projectConversation(state.view, { ownerSessionId }))
  } finally { shape.mockRestore() }
})

it('keeps both initial shape checks for lineage, legacy and bootstrap construction', () => {
  const shape = vi.spyOn(conversationEvents, 'validateConversationEventShape')
  try {
    const original = fixture(), expected = original.events.flatMap(event => [event.seq, event.seq])
    for (const make of [
      () => createManagedSessionState({ ...original, header: { parentSession: 'parent', seedLength: 1 } }, { sessionId: ownerSessionId }),
      () => createManagedSessionState({ ...original, formatVersion: 13 }, { sessionId: ownerSessionId }),
      () => createBootstrapManagedSessionState(original, { sessionId: ownerSessionId }),
    ]) {
      shape.mockClear()
      make()
      expect(shape.mock.calls.map(([event]) => event.seq)).toEqual(expected)
    }
  } finally { shape.mockRestore() }
})

it('keeps the second acceptance shape check for a substituted UTF-8 encoder', () => {
  const session: Session = { formatVersion: CURRENT_FORMAT_VERSION, events: [
    { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 0 },
    { type: 'step/start', actionId: 'action', attemptId: 'attempt', seq: 1 },
    { type: 'assistant/message', text: 'complete reply', seq: 2 },
    { type: 'model/exchange-accepted', version: 1, exchangeId: 'exchange', actionId: 'action', attemptId: 'attempt',
      stepStartSeq: 1, assistantSeq: 2, callSeqs: [], seq: 3 },
    { type: 'step/end', seq: 4 },
  ] }
  expect(createManagedSessionState(session, { sessionId: ownerSessionId }).view.events).toHaveLength(5)
  const encode = TextEncoder.prototype.encode
  let acceptanceChecks = 0
  try {
    TextEncoder.prototype.encode = function(value?: string) {
      if (value?.includes('model/exchange-accepted') && ++acceptanceChecks === 2) return new Uint8Array(4097)
      return encode.call(this, value)
    }
    expect(() => createManagedSessionState(session, { sessionId: ownerSessionId })).toThrow('invalid acceptance payload')
    expect(acceptanceChecks).toBe(2)
  } finally { TextEncoder.prototype.encode = encode }
})

it('checks initial shape and graph errors in row order', () => {
  const fence = { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 0 } as const
  const malformed = { type: 'user/message', seq: 2, text: 'invalid',
    provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: '' } } as const
  const create = (events: SessionEvent[]) => createManagedSessionState({ formatVersion: CURRENT_FORMAT_VERSION, events }, { sessionId: ownerSessionId })
  expect(() => create([fence, { ...fence, seq: 1 }, malformed])).toThrow('duplicate semantics fence')
  expect(() => create([fence, { ...fence, seq: 1 },
    { type: 'runtime/context', version: 1, seq: 2, sections: [{ name: '', text: 'invalid' }] },
  ])).toThrow('Invalid runtime/context record or format')
  expect(() => create([fence, { ...malformed, seq: 1 }])).toThrow('invalid input provenance')
  expect(create([fence, { type: 'user/message', seq: 1, text: 'valid request' }]).view.events).toHaveLength(2)
})

it('keeps the original shape checks when frozen rows can see an inherited getter', () => {
  const session: Session = { formatVersion: CURRENT_FORMAT_VERSION, events: [{ type: 'user/message', text: 'request', seq: 0 }] }
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'provenance')
  let reads = 0
  let failure: unknown
  try {
    Object.defineProperty(Object.prototype, 'provenance', { configurable: true, get() {
      if (Object.getOwnPropertyDescriptor(this, 'type')?.value === 'user/message' && ++reads >= 5)
        return 'changed inherited data'
    } })
    createManagedSessionState(session, { sessionId: ownerSessionId })
  } catch (error) {
    failure = error
  } finally {
    if (prior) Object.defineProperty(Object.prototype, 'provenance', prior)
    else Reflect.deleteProperty(Object.prototype, 'provenance')
  }
  expect(failure).toMatchObject({ message: expect.stringContaining('invalid input provenance') })
  expect(createManagedSessionState(session, { sessionId: ownerSessionId }).view.events).toHaveLength(1)
})

it('keeps the original shape checks when the public media type lookup is customized', () => {
  const original = fixture()
  original.events[5] = { type: 'tool/result', callId: 'read', name: 'read', seq: 5,
    envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '',
      media: [{ mediaType: 'image/png', dataBase64: 'AA==' }],
      retention: { kind: 'inline', value: 'ok', encodedBytes: 4 } },
  }
  expect(createManagedSessionState(original, { sessionId: ownerSessionId }).view.events).toHaveLength(8)
  const lookup = IMAGE_MEDIA_TYPES.has
  const prior = Object.getOwnPropertyDescriptor(IMAGE_MEDIA_TYPES, 'has')
  let checks = 0
  try {
    IMAGE_MEDIA_TYPES.has = mediaType => ++checks === 1 && lookup.call(IMAGE_MEDIA_TYPES, mediaType)
    expect(() => createManagedSessionState(original, { sessionId: ownerSessionId })).toThrow('Invalid result envelope or session format')
    expect(checks).toBe(2)
  } finally {
    if (prior) Object.defineProperty(IMAGE_MEDIA_TYPES, 'has', prior)
    else Reflect.deleteProperty(IMAGE_MEDIA_TYPES, 'has')
  }
})

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

it('keeps public acceptance size validation when the original UTF-8 encoder changes', () => {
  const state = createManagedSessionState({ formatVersion: CURRENT_FORMAT_VERSION, events: [
    { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 0 },
    { type: 'step/start', actionId: 'action', attemptId: 'attempt', seq: 1 },
    { type: 'assistant/message', text: 'ordinary complete reply', seq: 2 },
    { type: 'model/exchange-accepted', version: 1, exchangeId: 'exchange', actionId: 'action', attemptId: 'attempt',
      stepStartSeq: 1, assistantSeq: 2, callSeqs: [], seq: 3 },
    { type: 'step/end', seq: 4 },
  ] }, { sessionId: ownerSessionId })
  state.bindOwner({})
  const options = { ownerSessionId }
  const original = projectConversation(state.view, options)
  expect(projectManagedConversation(state.view, options)).toEqual(original)
  const encode = TextEncoder.prototype.encode
  try {
    TextEncoder.prototype.encode = function(input?: string) {
      if (input?.includes('model/exchange-accepted')) return new Uint8Array(4097)
      return encode.call(this, input)
    }
    expect(projectManagedConversation(state.view, options)).toBeUndefined()
    expect(() => projectConversation(state.view, options)).toThrow('invalid acceptance payload')
  } finally { TextEncoder.prototype.encode = encode }
  expect(projectManagedConversation(state.view, options)).toEqual(original)
})

it('keeps public runtime context validation when Buffer byte accounting or its global binding changes', () => {
  const state = createManagedSessionState({ formatVersion: CURRENT_FORMAT_VERSION, events: [
    { type: 'runtime/context', version: 1, sections: [{ name: 'project policy', text: 'project-specific instruction' }], seq: 0 },
  ] }, { sessionId: ownerSessionId })
  state.bindOwner({})
  const options = { ownerSessionId }
  const original = projectConversation(state.view, options)
  expect(projectManagedConversation(state.view, options)).toEqual(original)
  const byteLength = Buffer.byteLength
  try {
    Buffer.byteLength = new Proxy<typeof byteLength>(byteLength, { apply(target, receiver, args) {
      return args[0] === 'project policy' ? 129 : Reflect.apply(target, receiver, args)
    } })
    expect(projectManagedConversation(state.view, options)).toBeUndefined()
    expect(() => projectConversation(state.view, options)).toThrow('Invalid runtime/context record or format')
  } finally { Buffer.byteLength = byteLength }
  const originalBuffer = globalThis.Buffer
  let substituted
  try {
    globalThis.Buffer = new Proxy(originalBuffer, {})
    substituted = projectManagedConversation(state.view, options)
  } finally { globalThis.Buffer = originalBuffer }
  expect(substituted).toBeUndefined()
  expect(projectManagedConversation(state.view, options)).toEqual(original)
})
