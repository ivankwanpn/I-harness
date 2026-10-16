import { expect, it } from 'vitest'
import { deriveMessages, validateConversationHistory, type SessionEvent } from '@i-harness/core-session'
import { remapConversationSeed, SessionForkUnavailableError } from '../src/seed.ts'
import { completedTurnPrefix } from '../src/fork.ts'

it('compiles a complete replacement prefix containing an absent legacy reset list', () => {
  const parent: SessionEvent[] = [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'H' },
    { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: 'E' }, { type: 'step/end', seq: 4 }, { type: 'turn/end', seq: 5 },
    { type: 'compaction/reset', seq: 6 } as SessionEvent,
    { type: 'compaction/replacement', version: 1, seq: 7, replacementId: 'r7', text: 'S',
      coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }],
      insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } },
  ]
  const original = JSON.stringify(parent)
  expect(() => validateConversationHistory(parent, 7)).not.toThrow()
  expect(deriveMessages({ formatVersion: 7, events: parent }).map(message => message.content)).toEqual(['H', 'S'])
  const seed = remapConversationSeed({ source: parent, retained: parent, sourceFormat: 7 })
  expect(seed.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(seed[6]).toEqual({ type: 'compaction/reset', seq: 6, removedSeqs: [] })
  expect(seed[7]).toMatchObject({ type: 'compaction/replacement', seq: 7, replacementId: 'seed:15f868c37d857ce231050ad17156edb4325509bd188b2442d13c52faf3b4a676',
    coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }],
    insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } })
  expect(deriveMessages({ formatVersion: 7, events: seed }).map(message => message.content)).toEqual(['H', 'S'])
  for (const missing of [2, 3, 4]) expect(() => remapConversationSeed({ source: parent, retained: parent.filter(event => event.seq !== missing), sourceFormat: 7 })).toThrow(SessionForkUnavailableError)
  expect(JSON.stringify(parent)).toBe(original)
  const later: SessionEvent[] = [...parent, { type: 'turn/start', seq: 8 }, { type: 'user/message', seq: 9, text: 'later' }, { type: 'turn/end', seq: 10 }, { type: 'compaction/reset', seq: 11 } as SessionEvent]
  const selected = completedTurnPrefix(later, 'parent', 3, 7)
  expect(selected.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(selected[7]).toMatchObject({ seq: 7, coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }] })
  expect(deriveMessages({ formatVersion: 7, events: selected }).map(message => message.content)).toEqual(['H', 'S'])
  const affecting: SessionEvent[] = [...later.slice(0, -1), { type: 'compaction/reset', seq: 11, removedSeqs: [7] }]
  expect(() => validateConversationHistory(affecting, 7)).not.toThrow()
  expect(deriveMessages({ formatVersion: 7, events: affecting }).map(message => message.content)).toEqual(['H', 'later'])
  expect(() => completedTurnPrefix(affecting, 'parent', 3, 7)).toThrow(SessionForkUnavailableError)
})

const source = (): SessionEvent[] => [
  { type: 'context/recovery', version: 1, seq: 0, ownerSessionId: 'parent', recoveryId: 'audit', logicalStepSeq: 0, bindingFingerprint: 'a'.repeat(64), rejectedInputFingerprint: 'b'.repeat(64), state: 'resolved' },
  { type: 'turn/start', seq: 1 }, { type: 'user/message', seq: 2, text: 'H' },
  { type: 'step/start', seq: 3 }, { type: 'assistant/message', seq: 4, text: 'E' }, { type: 'step/end', seq: 5 }, { type: 'turn/end', seq: 6 },
  { type: 'compaction/replacement', version: 1, seq: 7, replacementId: 'r7', text: 'S',
    coverage: [{ item: { kind: 'exchange', at: { seq: 4, part: 'message' } }, sources: [{ seq: 3, part: 'step' }, { seq: 4, part: 'message' }] }],
    insertBefore: { kind: 'exchange', at: { seq: 4, part: 'message' } } } as SessionEvent,
]

it('remaps complete in-boundary replacement proof exactly once', () => {
  const parent = source()
  const seed = remapConversationSeed({ source: parent, retained: parent.slice(1), sourceFormat: 7 })
  expect(seed[6]).toMatchObject({ type: 'compaction/replacement', seq: 6,
    coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }],
    insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } }, replacementId: 'seed:15f868c37d857ce231050ad17156edb4325509bd188b2442d13c52faf3b4a676' })
  expect(deriveMessages({ formatVersion: 7, events: seed }).map(message => message.content)).toEqual(['H', 'S'])
  expect(parent[7]).toMatchObject({ replacementId: 'r7', seq: 7 })
})

it('retains nested manifests and rewind proof in a completed prefix without resurrecting originals', () => {
  const parent = source()
  parent.push({ type: 'compaction/replacement', version: 1, seq: 8, replacementId: 'r8', text: 'S2', coverage: [{ item: { kind: 'summary', at: { seq: 7, part: 'message' } }, sources: [{ seq: 7, part: 'message' }] }], insertBefore: { kind: 'summary', at: { seq: 7, part: 'message' } } },
    { type: 'rewind/point', version: 1, seq: 9, targetTurn: 0, anchorSeq: 8, mode: 'conversation', fileOps: [] })
  const seed = completedTurnPrefix(parent, 'parent', undefined, 7)
  expect(seed).toHaveLength(9)
  expect(seed[3]).toMatchObject({ type: 'assistant/message', text: 'E', seq: 3 })
  expect(seed[7]).toMatchObject({ type: 'compaction/replacement', replacementId: 'seed:5814196ea907d22db59f464c768cd92656112ef015e0dd28c20cfcc53bd0da80', seq: 7,
    coverage: [{ item: { kind: 'summary', at: { seq: 6, part: 'message' } }, sources: [{ seq: 6, part: 'message' }] }], insertBefore: { kind: 'summary', at: { seq: 6, part: 'message' } } })
  expect(seed[8]).toMatchObject({ type: 'rewind/point', seq: 8, anchorSeq: 7 })
  expect(deriveMessages({ formatVersion: 7, events: seed }).map(message => message.content)).toEqual(['H'])
  for (const missing of [3, 4, 5, 7]) expect(() => remapConversationSeed({ source: parent, retained: parent.filter(event => event.seq !== missing), sourceFormat: 7 })).toThrow(SessionForkUnavailableError)
})

it('inherits accepted-v2 as structural-v1 while requiring complete native/image/fence proof', () => {
  const d = 'a'.repeat(64)
  const request = { version: 1, ownerSessionId: 'parent', observationLifetimeId: 'live', candidateId: 'A', sendId: 'send', semanticId: d, payloadId: d, payloadKind: 'http-json-body', executionEpochId: 'E', coldCompatible: false,
    snapshot: { semanticRevision: d, protectionRevision: d, branchId: d, contextEpoch: d, surfaceRevision: d }, projectionRevision: 0 } as const
  const parent: SessionEvent[] = [source()[0]!,
    { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 1 }, { type: 'turn/start', seq: 2 }, { type: 'user/message', seq: 3, text: 'H' },
    { type: 'step/start', seq: 4, actionId: 'a', attemptId: 'p' }, { type: 'tool/call', seq: 5, callId: 'c', name: 'read', args: {} },
    { type: 'assistant/message', seq: 6, text: 'native', providerContinuation: { kind: 'openai-responses', model: 'fixture', reasoningItems: [{ type: 'reasoning', encrypted_content: 'opaque' }] } },
    { type: 'model/exchange-accepted', version: 2, seq: 7, exchangeId: 'e', actionId: 'a', attemptId: 'p', stepStartSeq: 4, assistantSeq: 6, callSeqs: [5], request },
    { type: 'tool/dispatch', seq: 8, callId: 'c', eventSeq: 5 }, { type: 'tool/result', seq: 9, callId: 'c', name: 'read', output: { images: [{ mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }] } },
    { type: 'step/end', seq: 10 }, { type: 'turn/end', seq: 11 },
    { type: 'compaction/replacement', version: 1, seq: 12, replacementId: 'accepted', text: 'S', coverage: [{ item: { kind: 'exchange', at: { seq: 5, part: 'call' } }, sources: [
      { seq: 4, part: 'step' }, { seq: 5, part: 'call' }, { seq: 6, part: 'message' }, { seq: 7, part: 'acceptance' }, { seq: 8, part: 'dispatch' }, { seq: 9, part: 'image' }, { seq: 9, part: 'result' },
    ] }], insertBefore: { kind: 'exchange', at: { seq: 5, part: 'call' } } },
  ]
  const seed = remapConversationSeed({ source: parent, retained: parent.slice(1), sourceFormat: 7 })
  expect(seed[6]).toMatchObject({ type: 'model/exchange-accepted', version: 1, stepStartSeq: 3, assistantSeq: 5, callSeqs: [4] })
  expect(seed[6]).not.toHaveProperty('request')
  expect(seed[7]).toMatchObject({ type: 'tool/dispatch', eventSeq: 4 })
  expect(seed[5]).toMatchObject({ providerContinuation: { reasoningItems: [{ encrypted_content: 'opaque' }] } })
  expect(deriveMessages({ formatVersion: 7, events: seed }).map(message => message.content)).toEqual(['H', 'S'])
  for (const missing of [1, 4, 5, 6, 7, 8, 9, 10]) expect(() => remapConversationSeed({ source: parent, retained: parent.filter(event => event.seq !== missing), sourceFormat: 7 })).toThrow(SessionForkUnavailableError)
})

it('retains matched image admission, promotion and turn closure instead of materializing outside-boundary evidence', () => {
  const parent: SessionEvent[] = [source()[0]!,
    { type: 'agent/input/admitted', version: 1, seq: 1, inputId: 'image', text: 'H', delivery: 'queue', intent: 'user', images: [{ mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }] },
    { type: 'agent/input/promoted', version: 1, seq: 2, inputId: 'image' }, { type: 'turn/start', seq: 3 },
    { type: 'user/message', seq: 4, text: 'H', imageInputId: 'image', input: { inputId: 'image', intent: 'user' } }, { type: 'turn/end', seq: 5 },
    { type: 'compaction/replacement', version: 1, seq: 6, replacementId: 'image', text: 'S', coverage: [{ item: { kind: 'input', at: { seq: 4, part: 'message' } }, sources: [{ seq: 1, part: 'admission' }, { seq: 4, part: 'message' }] }], insertBefore: { kind: 'input', at: { seq: 4, part: 'message' } } },
  ]
  const seed = remapConversationSeed({ source: parent, retained: parent.slice(1), sourceFormat: 7 })
  expect(seed[5]).toMatchObject({ seq: 5, coverage: [{ item: { kind: 'input', at: { seq: 3, part: 'message' } }, sources: [{ seq: 0, part: 'admission' }, { seq: 3, part: 'message' }] }] })
  expect(seed[3]).toMatchObject({ imageInputId: 'image', provenance: { kind: 'inherited', authority: 'observation' } })
  expect(deriveMessages({ formatVersion: 7, events: seed }).map(message => message.content)).toEqual(['S'])
  for (const missing of [1, 2, 3, 5]) expect(() => remapConversationSeed({ source: parent, retained: parent.filter(event => event.seq !== missing), sourceFormat: 7 })).toThrow(SessionForkUnavailableError)
})

it('keeps distinct text and image admissions in exact coverage and dependency closure', () => {
  const parent: SessionEvent[] = [
    { type: 'agent/input/admitted', version: 1, seq: 0, inputId: 'picture', text: 'old image', delivery: 'queue', intent: 'user', images: [{ mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }] },
    { type: 'user/message', seq: 1, text: 'old image', input: { inputId: 'picture', intent: 'user' }, imageInputId: 'picture' },
    { type: 'agent/input/admitted', version: 1, seq: 2, inputId: 'text', text: 'H', delivery: 'queue', intent: 'user' }, { type: 'turn/start', seq: 3 },
    { type: 'user/message', seq: 4, text: 'H', input: { inputId: 'text', intent: 'user' }, imageInputId: 'picture' }, { type: 'turn/end', seq: 5 },
    { type: 'compaction/reset', seq: 6, removedSeqs: [1] },
    { type: 'compaction/replacement', version: 1, seq: 7, replacementId: 'two-admissions', text: 'S', coverage: [{ item: { kind: 'input', at: { seq: 4, part: 'message' } }, sources: [{ seq: 0, part: 'admission' }, { seq: 2, part: 'admission' }, { seq: 4, part: 'message' }] }], insertBefore: { kind: 'input', at: { seq: 4, part: 'message' } } },
  ]
  const seed = remapConversationSeed({ source: parent, retained: parent, sourceFormat: 7 })
  expect(seed[7]).toMatchObject({ coverage: [{ sources: [{ seq: 0, part: 'admission' }, { seq: 2, part: 'admission' }, { seq: 4, part: 'message' }] }] })
  expect(deriveMessages({ formatVersion: 7, events: seed }).map(message => message.content)).toEqual(['S'])
  for (const missing of [0, 2]) expect(() => remapConversationSeed({ source: parent, retained: parent.filter(event => event.seq !== missing), sourceFormat: 7 })).toThrow(SessionForkUnavailableError)
  const broken = structuredClone(parent), replacement = broken[7]
  if (replacement?.type !== 'compaction/replacement') throw Error('replacement required')
  broken[7] = { ...replacement, coverage: [{ ...replacement.coverage[0]!, sources: [{ seq: 2, part: 'admission' }, { seq: 4, part: 'message' }] }] }
  expect(() => remapConversationSeed({ source: broken, retained: broken, sourceFormat: 7 })).toThrowError(expect.objectContaining({ reason: 'coverage-mismatch' }))
})

it('refuses a tail missing original proof rather than broadening its boundary', () => {
  const parent = source()
  expect(() => remapConversationSeed({ source: parent, retained: parent.slice(4), sourceFormat: 7 })).toThrow(SessionForkUnavailableError)
})
