import { describe, expect, it } from 'vitest'
import * as core from '../src/index.ts'
import type { Session, SessionEvent } from '../src/index.ts'
type RewriteDraft = Parameters<typeof core.projectConversationCandidate>[1][number]

const rewrite = { type: 'compaction/replacement', version: 1, replacementId: 'candidate-one', text: 'S',
  coverage: [{ item: { kind: 'exchange', at: { seq: 1, part: 'message' } }, sources: [{ seq: 1, part: 'message' }] }],
  insertBefore: { kind: 'exchange', at: { seq: 1, part: 'message' } } } as const
function fixture(onAppend?: (event: SessionEvent) => void): Session {
  const source = core.createSession(onAppend)
  core.append(source, { type: 'user/message', text: 'H' })
  core.append(source, { type: 'assistant/message', text: 'E' })
  core.append(source, { type: 'user/message', text: 'tail' })
  return source
}

describe('private conversation candidates', () => {
  it('projects the literal stepless replacement without issuing a fact or committed coordinate', () => {
    const observed: SessionEvent[] = [], source = fixture(event => observed.push(event))
    const before = core.toJSONL(source), original = core.projectConversation(source, { ownerSessionId: 'owner' })
    expect(core).toHaveProperty('projectConversationCandidate')
    const candidate = core.projectConversationCandidate(source, [rewrite], { candidateId: 'c1', ownerSessionId: 'owner' })
    expect(core.renderConversation(candidate.projection).map(message => message.content)).toEqual(['H', 'S', 'tail'])
    expect(core.toJSONL(source)).toBe(before)
    expect(core.deriveMessages(source).map(message => message.content)).toEqual(['H', 'E', 'tail'])
    expect(observed).toHaveLength(3)
    expect(candidate).toMatchObject({ kind: 'candidate', candidateId: 'c1', sourceEventCount: 3, projectedEventCount: 4, projection: { archiveEventCount: 3 } })
    const summary = candidate.projection.items[1]!
    expect(summary.ref).toBeUndefined()
    expect(summary.sources).toEqual([{ id: '["owner","candidate:c1:0","message"]', eventIndex: 3, part: 'message', addressable: false }])
    expect(summary.provenance).toMatchObject({ kind: 'summary', authority: 'derived', evidence: summary.sources })
    expect(summary.replacement).toEqual({ replacementId: 'candidate-one', coverage: rewrite.coverage, insertBefore: rewrite.insertBefore })
    expect(candidate.projection.items[0]).toEqual(original.items[0])
    expect(candidate.projection.items[2]).toEqual(original.items[2])
    expect(Object.isFrozen(candidate)).toBe(true)
    expect(Object.isFrozen(candidate.projection)).toBe(true)
    expect(Object.isFrozen(summary)).toBe(true)
    const committed = core.fromJSONL(before)
    core.append(committed, rewrite)
    expect(core.deriveMessages(committed)).toEqual(core.renderConversation(candidate.projection))
    expect(core.deriveMessages(core.fromJSONL(core.toJSONL(committed)))).toEqual(core.renderConversation(candidate.projection))
  })

  it('previews staged history repeatedly without installing dependencies, counts or source tombstones', () => {
    const source = fixture(), index = core.createConversationValidationIndex(source.events, { formatVersion: 7 })
    const stage = index.stage([{ ...rewrite, seq: 3 }])
    expect(stage).toHaveProperty('history')
    expect(stage.history().items.map(item => item.kind)).toEqual(['input', 'summary', 'input'])
    expect(stage.history().items.map(item => item.kind)).toEqual(['input', 'summary', 'input'])
    expect(index.eventCount).toBe(3)
    expect(index.replacementDependencies().size).toBe(0)
    expect(index.history().items.map(item => item.kind)).toEqual(['input', 'exchange', 'input'])
    const other = index.stage([{ type: 'user/message', text: 'actual', seq: 3 }])
    other.commit()
    expect(() => stage.history()).toThrow('stale staged suffix')
    expect(() => stage.commit()).toThrow('stale staged suffix')
    const actual = index.stage([{ ...rewrite, seq: 4 }])
    actual.commit()
    expect(index.eventCount).toBe(5)
    expect([...index.replacementDependencies().get(4)!]).toEqual([1])
    expect(() => actual.history()).toThrow('consumed staged suffix')
    actual.commit() // existing commit-once behavior remains idempotent
    expect(index.eventCount).toBe(5)
  })
})

function equivalent(source: Session, rewrites: readonly RewriteDraft[]) {
  const before = core.toJSONL(source)
  const candidate = core.projectConversationCandidate(source, rewrites, { candidateId: 'equivalent', ownerSessionId: 'owner' })
  const messages = core.renderConversation(candidate.projection)
  const actual = core.fromJSONL(before)
  for (const draft of rewrites) core.append(actual, draft as SessionEvent)
  expect(core.deriveMessages(actual)).toEqual(messages)
  expect(core.deriveMessages(core.fromJSONL(core.toJSONL(actual)))).toEqual(messages)
  expect(core.toJSONL(source)).toBe(before)
  return { candidate, messages }
}

function nativeFixture(): Session {
  const source = fixture()
  core.append(source, { type: 'step/start' })
  core.append(source, { type: 'tool/call', callId: 'a', name: 'read', args: { z: 1, a: '雪"\n' } })
  core.append(source, { type: 'tool/call', callId: 'b', name: 'read', args: {} })
  core.append(source, { type: 'assistant/message', text: 'Checking', thinkingBlocks: [{ type: 'thinking', thinking: 'reason', signature: 'signed' }], providerContinuation: {
    kind: 'anthropic', model: 'literal', contentOrder: [{ kind: 'reasoning', index: 0 }, { kind: 'text', text: 'Checking' }, { kind: 'tool', index: 0 }, { kind: 'tool', index: 1 }],
    producerWitness: { version: 1, thinkingConfigId: 'a'.repeat(64), effortConfigId: 'b'.repeat(64), interleavedBeta: false, mode: 'absent', interleaving: 'unknown' },
  } })
  core.append(source, { type: 'tool/result', callId: 'b', name: 'read', output: { text: 'B', images: [{ mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }] } })
  core.append(source, { type: 'tool/result', callId: 'a', name: 'read', output: 'A' })
  core.append(source, { type: 'step/end' })
  core.append(source, { type: 'user/message', text: 'last' })
  return source
}
const prune: RewriteDraft = { type: 'compaction/prune', version: 1, pruned: [{ callId: 'b', head: '雪"', tail: '\\end', removedBytes: 93 }] }

describe('candidate payload and historical equivalence', () => {
  it.each(['prune', 'replacement+prune'] as const)('retains parallel native order, image companions and actual source identities through %s', mode => {
    const source = nativeFixture(), original = core.projectConversation(source, { ownerSessionId: 'owner' })
    const { candidate, messages } = equivalent(source, mode === 'prune' ? [prune] : [prune, rewrite])
    expect(messages.map(message => message.role)).toEqual(['user', mode === 'prune' ? 'assistant' : 'user', 'user', 'assistant', 'tool', 'tool', 'user', 'user'])
    expect(messages[4]).toEqual({ role: 'tool', toolCallId: 'b', content: '雪"\n…(pruned 93 bytes)…\n\\end' })
    expect(messages[6]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, { type: 'image', image: { mediaType: 'image/png', dataBase64: 'aW1hZ2U=' } }] })
    expect(messages[5]).toEqual({ role: 'tool', toolCallId: 'a', content: '"A"' })
    expect(messages[3]).toMatchObject({ role: 'assistant', content: 'Checking', toolCalls: [{ id: 'a', name: 'read', args: { z: 1, a: '雪"\n' } }, { id: 'b', name: 'read', args: {} }], thinkingBlocks: [{ type: 'thinking', thinking: 'reason', signature: 'signed' }], providerContinuation: { contentOrder: [{ kind: 'reasoning', index: 0 }, { kind: 'text', text: 'Checking' }, { kind: 'tool', index: 0 }, { kind: 'tool', index: 1 }] } })
    const exchange = candidate.projection.items.find(item => item.exchange?.calls.length === 2)!
    const old = original.items.find(item => item.exchange?.calls.length === 2)!
    expect(exchange.sources).toEqual(old.sources)
    expect(exchange.provenance).toEqual(old.provenance)
    expect(exchange.ref).toEqual(old.ref)
    expect(exchange.exchange).toEqual(old.exchange)
    expect(source.events[7]).toMatchObject({ output: { text: 'B', images: [{ mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }] } })
  })

  it('projects explicit reset using the ordinary visibility rule', () => {
    const source = fixture()
    const { candidate, messages } = equivalent(source, [{ type: 'compaction/reset', removedSeqs: [1] }])
    expect(messages.map(message => message.content)).toEqual(['H', 'tail'])
    expect(candidate.projection.items.every(item => item.sources.every(ref => ref.addressable))).toBe(true)
  })

  it('replaces an existing replacement using its exact retained source', () => {
    const source = fixture()
    core.append(source, rewrite)
    const nested = { type: 'compaction/replacement', version: 1, replacementId: 'nested', text: 'S2', coverage: [{ item: { kind: 'summary', at: { seq: 3, part: 'message' } }, sources: [{ seq: 3, part: 'message' }] }], insertBefore: { kind: 'summary', at: { seq: 3, part: 'message' } } } as const
    const { messages, candidate } = equivalent(source, [nested])
    expect(messages.map(message => message.content)).toEqual(['H', 'S2', 'tail'])
    expect(candidate.projection.items[1]!.sources[0]).toMatchObject({ addressable: false, part: 'message' })
    expect(candidate.projection.items[1]!.ref).toBeUndefined()
  })

  it('captures each result and image slot once despite the companion recipe', () => {
    const source = nativeFixture(), captured: string[] = []
    const normal: string[] = []
    const capture = (calls: string[]) => (value: unknown, ref: core.ConversationSourceRef) => { calls.push(`${ref.eventIndex}:${ref.part}`); return structuredClone(value) }
    core.projectConversation(source, { capturePayload: capture(normal) })
    const candidate = core.projectConversationCandidate(source, [{ type: 'compaction/reset', removedSeqs: [] }], { candidateId: 'capture', capturePayload: capture(captured) })
    expect(captured).toEqual(normal)
    expect(captured.filter(key => key === '7:result')).toHaveLength(1)
    expect(captured.filter(key => key === '7:image')).toHaveLength(1)
    expect(core.renderConversation(candidate.projection)).toEqual(core.deriveMessages(source))
  })

  it('preserves ordinary opaque legacy payloads and caller-controlled capture behavior', () => {
    class Legacy { toJSON() { return { value: 'legacy' } } }
    const legacy = new Legacy(), source = core.createSession()
    core.append(source, { type: 'tool/call', callId: 'c', name: 'read', args: legacy })
    core.append(source, { type: 'tool/result', callId: 'c', name: 'read', output: legacy })
    const draft: RewriteDraft = { type: 'compaction/reset', removedSeqs: [] }
    const candidate = core.projectConversationCandidate(source, [draft], { candidateId: 'legacy' })
    expect(core.renderConversation(candidate.projection)).toEqual(core.deriveMessages(source))
    expect((core.renderConversation(candidate.projection)[0] as { toolCalls: { args: unknown }[] }).toolCalls[0]!.args).toBe(legacy)
    let captures = 0
    expect(() => core.projectConversationCandidate(source, [draft], { candidateId: 'strict', capturePayload: () => { captures++; throw new TypeError('strict payload') } })).toThrow('strict payload')
    expect(captures).toBe(1)
  })
})

describe('candidate refusal and isolation', () => {
  it.each(['', 'x'.repeat(257), undefined, 4])('rejects invalid candidate labels %j', candidateId => {
    const source = fixture(), before = core.toJSONL(source)
    expect(() => core.projectConversationCandidate(source, [rewrite], { candidateId: candidateId as string })).toThrow(TypeError)
    expect(core.toJSONL(source)).toBe(before)
  })

  it('rejects proposal getters, toJSON, sparse data, supplied seq and other fact families before capture', () => {
    let invoked = 0
    const getter = Object.defineProperty({}, 'type', { enumerable: true, get() { invoked++; return 'compaction/reset' } })
    const json = { ...rewrite, toJSON() { invoked++; return rewrite } }
    const sparse = [rewrite, , rewrite]
    const nestedSparse = { ...rewrite, coverage: [ , rewrite.coverage[0]] }
    const seq = { ...rewrite, seq: undefined }
    const hiddenSeq = Object.defineProperty({ ...rewrite }, 'seq', { value: 3 })
    const hiddenHead = { type: 'compaction/prune', version: 1, pruned: [Object.defineProperty({ callId: 'c', tail: 't', removedBytes: 1 }, 'head', { value: 'h' })] }
    const hiddenType = Object.defineProperty({ removedSeqs: [] }, 'type', { value: 'compaction/reset' })
    const getterArray = Object.defineProperty([rewrite], '0', { get() { invoked++; return rewrite } })
    const proposals = [[], [getter], [json], sparse, [nestedSparse], [seq], [hiddenSeq], [hiddenType], [hiddenHead], getterArray, [{ type: 'user/message', text: 'not a rewrite' }]]
    const source = fixture(), before = core.toJSONL(source)
    for (const proposal of proposals) expect(() => core.projectConversationCandidate(source, proposal as readonly RewriteDraft[], { candidateId: 'reject', capturePayload() { invoked++; return undefined } })).toThrow(TypeError)
    expect(invoked).toBe(0)
    expect(core.toJSONL(source)).toBe(before)
  })

  it.each(['missing', 'forward', 'incomplete', 'noncontiguous'] as const)('refuses %s historical coverage without consuming the later valid replacement', fault => {
    const source = fixture()
    if (fault === 'noncontiguous') { core.append(source, { type: 'assistant/message', text: 'E2' }); core.append(source, { type: 'user/message', text: 'end' }) }
    const broken: any = structuredClone(rewrite)
    if (fault === 'missing') broken.coverage[0].item.at.seq = 99
    if (fault === 'forward') broken.coverage[0].sources[0].seq = source.events.length
    if (fault === 'incomplete') broken.coverage[0].sources = [{ seq: 0, part: 'message' }]
    if (fault === 'noncontiguous') broken.coverage.push({ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 3, part: 'message' }] })
    const before = core.toJSONL(source), index = core.createConversationValidationIndex(source.events, { formatVersion: 7 })
    expect(() => core.projectConversationCandidate(source, [broken], { candidateId: 'bad' })).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT' }))
    expect(() => index.stage([{ ...broken, seq: source.events.length }])).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT' }))
    expect(index.eventCount).toBe(source.events.length)
    expect(index.replacementDependencies().size).toBe(0)
    expect(core.toJSONL(source)).toBe(before)
    const stage = index.stage([{ ...rewrite, seq: source.events.length }])
    stage.history(); stage.commit()
    expect(index.eventCount).toBe(source.events.length + 1)
    expect(index.replacementDependencies().size).toBe(1)
    core.append(source, rewrite)
    expect(core.deriveMessages(source).map(message => message.content)).toContain('S')
  })

  it('refuses an input-only open physical unit and does not let future closure bless the prefix', () => {
    const source: Session = { formatVersion: 7, events: [
      { type: 'turn/start', seq: 0 }, { type: 'step/start', seq: 1 }, { type: 'user/message', seq: 2, text: 'H' }, { type: 'turn/end', seq: 3 },
    ] }
    const draft = { type: 'compaction/replacement', version: 1, replacementId: 'open-step-input', text: 'S', coverage: [{ item: { kind: 'input', at: { seq: 2, part: 'message' } }, sources: [{ seq: 2, part: 'message' }] }], insertBefore: { kind: 'input', at: { seq: 2, part: 'message' } } } as const
    const refusal = expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'incomplete-unit', seq: 4 })
    expect(core.deriveMessages(source).map(message => message.content)).toEqual(['H'])
    expect(() => core.projectConversationCandidate(source, [draft], { candidateId: 'open' })).toThrowError(refusal)
    const index = core.createConversationValidationIndex(source.events, { formatVersion: 7 })
    expect(() => index.stage([{ ...draft, seq: 4 }, { type: 'step/end', seq: 5 }])).toThrowError(refusal)
    expect(index.eventCount).toBe(4)
    source.events[3] = { type: 'step/end', seq: 3 }
    core.append(source, { type: 'turn/end' })
    expect(equivalent(source, [draft]).messages.map(message => message.content)).toEqual(['S'])
  })

  it('keeps real source IDs despite a prospective positional seq colliding with a legacy seq', () => {
    const source: Session = { formatVersion: 7, events: [{ type: 'user/message', seq: 1, text: 'H' }] }
    const original = core.projectConversation(source, { ownerSessionId: 'owner' })
    const candidate = core.projectConversationCandidate(source, [{ type: 'compaction/reset', removedSeqs: [] }], { candidateId: 'collision', ownerSessionId: 'owner' })
    expect(candidate.projection.items).toEqual(original.items)
    expect(candidate.projection.diagnostics).toEqual([])
  })

  it('preserves old-format refusal and rejects already malformed base history', () => {
    const source = fixture(), before = core.toJSONL(source)
    source.formatVersion = 6
    expect(() => core.projectConversationCandidate(source, [rewrite], { candidateId: 'old' })).toThrowError(expect.objectContaining({ reason: 'format' }))
    expect(source.formatVersion).toBe(6)
    source.formatVersion = 7
    source.events.push({ ...rewrite, seq: 3, coverage: [] })
    expect(() => core.projectConversationCandidate(source, [{ type: 'compaction/reset', removedSeqs: [] }], { candidateId: 'malformed' })).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT' }))
    source.events.pop()
    expect(core.toJSONL(source)).toBe(before)
  })
})

it('owns proposed coverage and summary data without changing retained legacy ownership', () => {
  const source = fixture(), draft = structuredClone(rewrite) as any
  const candidate = core.projectConversationCandidate(source, [draft], { candidateId: 'owned' })
  draft.text = 'changed'
  draft.coverage[0].sources[0].seq = 0
  expect(core.renderConversation(candidate.projection).map(message => message.content)).toEqual(['H', 'S', 'tail'])
  expect(candidate.projection.items[1]!.replacement!.coverage).toEqual([{ item: { kind: 'exchange', at: { seq: 1, part: 'message' } }, sources: [{ seq: 1, part: 'message' }] }])
  expect(Object.isFrozen(candidate.projection.items[1]!.replacement!.coverage[0]!.sources)).toBe(true)
})

it('refuses splitting the input and exchange sharing one closed physical unit', () => {
  const source: Session = { formatVersion: 7, events: [
    { type: 'turn/start', seq: 0 }, { type: 'step/start', seq: 1 }, { type: 'user/message', seq: 2, text: 'H' },
    { type: 'assistant/message', seq: 3, text: 'E' }, { type: 'step/end', seq: 4 }, { type: 'turn/end', seq: 5 },
  ] }
  const draft = { ...rewrite, coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 1, part: 'step' }, { seq: 3, part: 'message' }] }], insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } } as const
  const before = core.toJSONL(source)
  expect(() => core.projectConversationCandidate(source, [draft], { candidateId: 'shared-unit' })).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'incomplete-unit' }))
  expect(core.toJSONL(source)).toBe(before)
  expect(core.deriveMessages(source).map(message => message.content)).toEqual(['H', 'E'])
})

it('preserves ordinary duplicate diagnostics and refuses a real replacement collision at the tentative position', () => {
  const source: Session = { formatVersion: 7, events: [{ type: 'user/message', seq: 1, text: 'H' }] }
  const actual = structuredClone(source)
  core.append(actual, { type: 'compaction/reset', removedSeqs: [] })
  expect(core.projectConversation(actual, { ownerSessionId: 'owner' }).diagnostics).toEqual([
    { code: 'duplicate-source-seq', sourceIds: ['["owner","event:0","event"]'] },
    { code: 'duplicate-source-seq', sourceIds: ['["owner","event:1","event"]'] },
  ])
  expect(core.deriveMessages(actual).map(message => message.content)).toEqual(['H'])
  const collision: Session = { formatVersion: 7, events: [{ type: 'user/message', seq: 0, text: 'H' }, { type: 'assistant/message', seq: 3, text: 'E' }, { type: 'user/message', seq: 2, text: 'tail' }] }
  const draft = { ...rewrite, coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 3, part: 'message' }] }], insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } } as const
  const before = JSON.stringify(collision), refusal = expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'unsafe-address' })
  expect(() => core.projectConversationCandidate(collision, [draft], { candidateId: 'invalid-collision' })).toThrowError(refusal)
  expect(() => core.append(collision, draft)).toThrowError(refusal)
  expect(JSON.stringify(collision)).toBe(before)
  expect(core.projectConversation(collision).items[1]!.sources[0]!.seq).toBe(3)
})
