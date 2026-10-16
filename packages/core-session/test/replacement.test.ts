import { describe, expect, it } from 'vitest'
import { append, captureFactGroup, createConversationValidationIndex, deriveMessages, deriveMessagesUpTo, fromJSONL, projectConversation, toJSONL, validateConversationHistory, type Session, type SessionEvent } from '../src/index.ts'

// Coordinates and expected order are literal: no production selector/publisher.
function fixture(): Session {
  return { formatVersion: 7, events: [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'H' },
    { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: 'E1' }, { type: 'step/end', seq: 4 },
    { type: 'step/start', seq: 5 }, { type: 'assistant/message', seq: 6, text: 'E2' }, { type: 'step/end', seq: 7 },
    { type: 'step/start', seq: 8 }, { type: 'assistant/message', seq: 9, text: 'tail' }, { type: 'step/end', seq: 10 },
    { type: 'compaction/replacement', version: 1, seq: 11, replacementId: 'r11', text: 'S11',
      coverage: [
        { item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] },
        { item: { kind: 'exchange', at: { seq: 6, part: 'message' } }, sources: [{ seq: 5, part: 'step' }, { seq: 6, part: 'message' }] },
      ], insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } } as SessionEvent,
  ] }
}
const labels = (session: Session) => deriveMessages(session).map(message => message.content)
function replacement(session: Session): any { return session.events[11]! }

function acceptedParallel(): Session {
  return { formatVersion: 7, events: [
    { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 0 },
    { type: 'turn/start', seq: 1 }, { type: 'user/message', seq: 2, text: 'H' },
    { type: 'step/start', seq: 3, actionId: 'a', attemptId: 'p' },
    { type: 'tool/call', seq: 4, callId: 'a', name: 'read', args: { z: 1, a: 2 } },
    { type: 'tool/call', seq: 5, callId: 'b', name: 'read', args: {} },
    { type: 'assistant/message', seq: 6, text: 'Checking', thinkingBlocks: [{ type: 'thinking', thinking: 'reason', signature: 'signed' }], providerContinuation: {
      kind: 'anthropic', model: 'literal', contentOrder: [{ kind: 'reasoning', index: 0 }, { kind: 'text', text: 'Checking' }, { kind: 'tool', index: 0 }, { kind: 'tool', index: 1 }],
      producerWitness: { version: 1, thinkingConfigId: 'a'.repeat(64), effortConfigId: 'b'.repeat(64), interleavedBeta: false, mode: 'absent', interleaving: 'unknown' },
    } },
    { type: 'model/exchange-accepted', version: 1, seq: 7, exchangeId: 'e', actionId: 'a', attemptId: 'p', stepStartSeq: 3, assistantSeq: 6, callSeqs: [4, 5] },
    { type: 'tool/dispatch', seq: 8, callId: 'a', eventSeq: 4 }, { type: 'tool/dispatch', seq: 9, callId: 'b', eventSeq: 5 },
    { type: 'tool/result', seq: 10, callId: 'b', name: 'read', output: { text: 'B', images: [{ mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }] } },
    { type: 'tool/result', seq: 11, callId: 'a', name: 'read', output: 'A' }, { type: 'step/end', seq: 12 },
    { type: 'compaction/replacement', version: 1, seq: 13, replacementId: 'parallel', text: 'S',
      coverage: [{ item: { kind: 'exchange', at: { seq: 4, part: 'call' } }, sources: [
        { seq: 3, part: 'step' }, { seq: 4, part: 'call' }, { seq: 5, part: 'call' }, { seq: 6, part: 'message' }, { seq: 7, part: 'acceptance' },
        { seq: 8, part: 'dispatch' }, { seq: 9, part: 'dispatch' }, { seq: 10, part: 'image' }, { seq: 10, part: 'result' }, { seq: 11, part: 'result' },
      ] }], insertBefore: { kind: 'exchange', at: { seq: 4, part: 'call' } } },
  ] }
}

describe('strict positional replacement readers', () => {
  it.each(['admitted', 'promoted'] as const)('protects a distinct image admission that is still %s', state => {
    const session: Session = { formatVersion: 7, events: [
      { type: 'agent/input/admitted', version: 1, seq: 0, inputId: 'picture', text: 'image', delivery: 'queue', intent: 'user', images: [{ mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }] },
      state === 'promoted' ? { type: 'agent/input/promoted', version: 1, seq: 1, inputId: 'picture' } : { type: 'plan/mode', seq: 1, mode: 'off' },
      { type: 'agent/input/admitted', version: 1, seq: 2, inputId: 'text', text: 'H', delivery: 'queue', intent: 'user' }, { type: 'turn/start', seq: 3 },
      { type: 'user/message', seq: 4, text: 'H', input: { inputId: 'text', intent: 'user' }, imageInputId: 'picture' }, { type: 'turn/end', seq: 5 },
      { type: 'compaction/replacement', version: 1, seq: 6, replacementId: 'pending-image', text: 'S', coverage: [{ item: { kind: 'input', at: { seq: 4, part: 'message' } }, sources: [{ seq: 0, part: 'admission' }, { seq: 2, part: 'admission' }, { seq: 4, part: 'message' }] }], insertBefore: { kind: 'input', at: { seq: 4, part: 'message' } } },
    ] }
    expect(() => validateConversationHistory(session.events, 7)).toThrowError(expect.objectContaining({ reason: 'protected-source' }))
  })
  it('rejects later reuse of consumed admission/image evidence at that stage and permits a fresh admission', () => {
    const prefix: SessionEvent[] = [
      { type: 'agent/input/admitted', version: 1, seq: 0, inputId: 'image', text: 'H', delivery: 'queue', intent: 'user', images: [{ mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }] },
      { type: 'agent/input/promoted', version: 1, seq: 1, inputId: 'image' }, { type: 'turn/start', seq: 2 },
      { type: 'user/message', seq: 3, text: 'H', imageInputId: 'image', input: { inputId: 'image', intent: 'user' } }, { type: 'turn/end', seq: 4 },
      { type: 'compaction/replacement', version: 1, seq: 5, replacementId: 'r5', text: 'S', coverage: [{ item: { kind: 'input', at: { seq: 3, part: 'message' } }, sources: [{ seq: 0, part: 'admission' }, { seq: 3, part: 'message' }] }], insertBefore: { kind: 'input', at: { seq: 3, part: 'message' } } },
    ]
    const index = createConversationValidationIndex(prefix, { formatVersion: 7 })
    const stale: SessionEvent = { type: 'user/message', seq: 6, text: 'H', imageInputId: 'image', input: { inputId: 'image', intent: 'user' } }
    expect(() => index.stage([stale])).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'missing-source', seq: 6 }))
    expect(index.eventCount).toBe(6)
    expect(() => validateConversationHistory([...prefix, stale], 7)).toThrowError(expect.objectContaining({ reason: 'missing-source', seq: 6 }))
    const audit: SessionEvent = { type: 'operator/run-end', version: 1, seq: 6, runId: 'late', exitCode: 0, durationMs: 1, phase: 'session' }
    index.stage([audit]).commit()
    const fresh: SessionEvent[] = [
      { type: 'agent/input/admitted', version: 1, seq: 7, inputId: 'image', text: 'fresh', delivery: 'queue', intent: 'user', images: [{ mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }] },
      { type: 'agent/input/promoted', version: 1, seq: 8, inputId: 'image' }, { type: 'turn/start', seq: 9 },
      { type: 'user/message', seq: 10, text: 'fresh', imageInputId: 'image', input: { inputId: 'image', intent: 'user' } },
    ]
    index.stage(fresh).commit()
    expect(index.eventCount).toBe(11)
    expect(deriveMessages({ formatVersion: 7, events: [...prefix, audit, ...fresh] }).map(message => typeof message.content === 'string' ? message.content : message.content[0])).toEqual(['S', { type: 'text', text: 'fresh' }])
    expect(() => validateConversationHistory([...prefix.slice(0, 5), { ...stale, seq: 5 }], 7)).not.toThrow()
  })
  it('requires every item sharing an admission/image source even across distinct stepless input units', () => {
    const session: Session = { formatVersion: 7, events: [
      { type: 'agent/input/admitted', version: 1, seq: 0, inputId: 'shared', text: 'H', delivery: 'queue', intent: 'user', images: [{ mediaType: 'image/png', dataBase64: 'aW1hZ2U=' }] },
      { type: 'agent/input/promoted', version: 1, seq: 1, inputId: 'shared' }, { type: 'turn/start', seq: 2 },
      { type: 'user/message', seq: 3, text: 'H', imageInputId: 'shared', input: { inputId: 'shared', intent: 'user' } },
      { type: 'user/message', seq: 4, text: 'H', imageInputId: 'shared', input: { inputId: 'shared', intent: 'user' } }, { type: 'turn/end', seq: 5 },
    ] }
    expect(() => validateConversationHistory(session.events, 7)).not.toThrow()
    expect(deriveMessages(session)).toHaveLength(2)
    const event: SessionEvent = { type: 'compaction/replacement', version: 1, seq: 6, replacementId: 'shared', text: 'S',
      coverage: [{ item: { kind: 'input', at: { seq: 3, part: 'message' } }, sources: [{ seq: 0, part: 'admission' }, { seq: 3, part: 'message' }] }],
      insertBefore: { kind: 'input', at: { seq: 3, part: 'message' } } }
    expect(() => validateConversationHistory([...session.events, event], 7)).toThrowError(expect.objectContaining({ reason: 'incomplete-unit' }))
    const complete = { ...event, coverage: [...event.coverage, { item: { kind: 'input' as const, at: { seq: 4, part: 'message' } }, sources: [{ seq: 0, part: 'admission' }, { seq: 4, part: 'message' }] }] }
    session.events.push(complete)
    expect(labels(session)).toEqual(['S'])
  })
  it('refuses accessor-bearing replacement DTOs without executing them on full, append or seed-import paths', () => {
    const session = fixture(), event = replacement(session)
    session.events.pop()
    let reads = 0
    Object.defineProperty(event, 'text', { enumerable: true, get() { reads++; return 'SENSITIVE_BODY' } })
    expect(() => validateConversationHistory([...session.events, event], 7)).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'shape' }))
    expect(() => append(session, event)).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'shape' }))
    expect(captureFactGroup({ kind: 'seed-import', events: [event] })).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
    expect(reads).toBe(0)
    expect(session.events).toHaveLength(11)
  })
  it('replaces only the literal contiguous span before a steer and preserves its later suffix', () => {
    const session = fixture(), record = replacement(session)
    session.events = [...session.events.slice(0, 8),
      { type: 'user/message', seq: 8, text: 'steer' },
      { type: 'step/start', seq: 9 }, { type: 'assistant/message', seq: 10, text: 'E3' }, { type: 'step/end', seq: 11 },
      { type: 'step/start', seq: 12 }, { type: 'assistant/message', seq: 13, text: 'E4' }, { type: 'step/end', seq: 14 },
      { type: 'step/start', seq: 15 }, { type: 'assistant/message', seq: 16, text: 'tail' }, { type: 'step/end', seq: 17 }, { ...record, seq: 18 },
    ]
    expect(labels(session)).toEqual(['H', 'S11', 'steer', 'E3', 'E4', 'tail'])
    expect(deriveMessagesUpTo(session, 17).map(message => message.content)).toEqual(['H', 'E1', 'E2', 'steer', 'E3', 'E4', 'tail'])
    ;(session.events[18] as any).coverage[1] = { item: { kind: 'exchange', at: { seq: 10, part: 'message' } }, sources: [{ seq: 9, part: 'step' }, { seq: 10, part: 'message' }] }
    expect(() => validateConversationHistory(session.events, 7)).toThrowError(expect.objectContaining({ reason: 'noncontiguous' }))
  })

  it.each(['version', 'ignorable', 'empty-id', 'nonascii-id', 'long-id', 'blank-text', 'extra', 'duplicate-item', 'duplicate-source', 'unsafe-seq', 'unknown-part', 'reordered-sources'])( 'rejects closed schema/source fault %s with scalar-only diagnostics', fault => {
    const session = fixture(), event = replacement(session)
    if (fault === 'version') event.version = 2
    if (fault === 'ignorable') event.ignorable = true
    if (fault === 'empty-id') event.replacementId = ''
    if (fault === 'nonascii-id') event.replacementId = '中文'
    if (fault === 'long-id') event.replacementId = 'x'.repeat(257)
    if (fault === 'blank-text') event.text = '  \n '
    if (fault === 'extra') event.candidate = { private: 'SENSITIVE_BODY' }
    if (fault === 'duplicate-item') event.coverage.push(event.coverage[0])
    if (fault === 'duplicate-source') event.coverage[0].sources.push({ seq: 2, part: 'step' })
    if (fault === 'unsafe-seq') event.coverage[0].sources[0].seq = Number.MAX_SAFE_INTEGER + 1
    if (fault === 'unknown-part') event.coverage[0].sources[0].part = 'invented-part'
    if (fault === 'reordered-sources') event.coverage[0].sources.reverse()
    const error = (() => { try { validateConversationHistory(session.events, 7) } catch (cause) { return cause } })()
    expect(error).toMatchObject({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT' })
    expect(Object.keys(error as object).sort()).toEqual(['code', 'reason', 'seq'])
    expect(String(error)).not.toContain('SENSITIVE_BODY')
  })

  it.each(['reset', 'summary'] as const)('keeps consumed sources hidden after a later legacy %s hides R itself', kind => {
    const session = fixture()
    session.events.push(kind === 'reset' ? { type: 'compaction/reset', seq: 12, removedSeqs: [11] } : { type: 'compaction/summary', seq: 12, text: 'legacy', shadowedSeqs: [11] })
    expect(labels(session)).toEqual(kind === 'reset' ? ['H', 'tail'] : ['H', 'tail', 'legacy'])
    session.events.push({ ...replacement(session), seq: 13, replacementId: 'stale' })
    expect(() => validateConversationHistory(session.events, 7)).toThrowError(expect.objectContaining({ reason: 'missing-source' }))
  })
  it('requires the exact accepted parallel/native/image bundle and preserves native prefix data', () => {
    const session = acceptedParallel(), raw = JSON.stringify(session)
    expect(labels(session)).toEqual(['H', 'S'])
    const prefix = projectConversation(session, { throughSeq: 12 }).items[1]!
    expect(prefix.ref).toEqual({ kind: 'exchange', at: { seq: 4, part: 'call' } })
    expect(prefix.messages.map(message => message.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
    expect(prefix.messages[0]).toMatchObject({ providerContinuation: { producerWitness: { version: 1 } }, thinkingBlocks: [{ signature: 'signed' }] })
    expect(JSON.stringify(session)).toBe(raw)
    for (const omitted of [5, 6, 7, 8]) {
      const broken = acceptedParallel(), record = broken.events[13] as any
      record.coverage[0].sources.splice(omitted, 1)
      expect(() => validateConversationHistory(broken.events, 7)).toThrowError(expect.objectContaining({ reason: 'coverage-mismatch' }))
    }
  })

  it('does not retroactively regroup a valid replacement when a future legacy callId is reused', () => {
    const session = acceptedParallel()
    // Strip the explicit-region fence/acceptance while preserving literal
    // coordinates: the replacement manifest is independently handwritten.
    session.events[0] = { type: 'plan/mode', seq: 0, mode: 'off' }
    session.events[7] = { type: 'plan/mode', seq: 7, mode: 'off' }
    ;(session.events[13] as any).coverage[0].sources.splice(4, 1)
    session.events.push({ type: 'step/start', seq: 14 }, { type: 'tool/call', seq: 15, callId: 'a', name: 'read', args: {} },
      { type: 'assistant/message', seq: 16, text: 'later' }, { type: 'tool/result', seq: 17, callId: 'a', name: 'read', output: 'LATER' }, { type: 'step/end', seq: 18 })
    expect(labels(session).slice(0, 2)).toEqual(['H', 'S'])
    expect(labels(session)).not.toContain('Checking')
    expect(labels(session)).not.toContain('"A"')
  })

  it('does not split an unrelated pending tool bundle at the replacement archive position', () => {
    const session = fixture(), event = replacement(session)
    session.events = [...session.events.slice(0, 8),
      { type: 'step/start', seq: 8 }, { type: 'tool/call', seq: 9, callId: 'tail', name: 'read', args: {} },
      { type: 'assistant/message', seq: 10, text: 'tail' }, event,
      { type: 'tool/result', seq: 12, callId: 'tail', name: 'read', output: 'tail-result' }, { type: 'step/end', seq: 13 },
    ]
    const items = projectConversation(session).items
    expect(items.map(item => item.kind)).toEqual(['input', 'summary', 'exchange'])
    expect(items[2]!.exchange).toMatchObject({ state: 'closed', calls: [{ callId: 'tail', result: { seq: 12 } }] })
    expect(items[2]!.sources.map(source => [source.seq, source.part])).toEqual(expect.arrayContaining([[8, 'step'], [9, 'call'], [10, 'message'], [12, 'result']]))
  })
  it('inserts at coverage position and preserves a prefix', () => {
    const session = fixture()
    expect(labels(session)).toEqual(['H', 'S11', 'tail'])
    expect(deriveMessagesUpTo(session, 10).map(message => message.content)).toEqual(['H', 'E1', 'E2', 'tail'])
    expect(projectConversation(session).items[1]).toMatchObject({ ref: { kind: 'summary', at: { seq: 11, part: 'message' } }, provenance: { kind: 'summary', authority: 'derived' }, replacement: { replacementId: 'r11' } })
  })

  it('keeps nested consumption monotone when a later rewind hides the summary', () => {
    const session = fixture()
    session.events.push({ type: 'compaction/replacement', version: 1, seq: 12, replacementId: 'r12', text: 'S12', coverage: [
      { item: { kind: 'summary', at: { seq: 11, part: 'message' } }, sources: [{ seq: 11, part: 'message' }] },
      { item: { kind: 'exchange', at: { seq: 9, part: 'message' } }, sources: [{ seq: 8, part: 'step' }, { seq: 9, part: 'message' }] },
    ], insertBefore: { kind: 'summary', at: { seq: 11, part: 'message' } } } as SessionEvent)
    expect(labels(session)).toEqual(['H', 'S12'])
    session.events.push({ type: 'rewind/point', version: 1, seq: 13, targetTurn: 0, anchorSeq: 12, mode: 'conversation', fileOps: [] })
    expect(labels(session)).toEqual(['H'])
  })

  it('round trips structural framing with positional semantics', () => {
    const text = toJSONL(fixture())
    expect(JSON.parse(text.split('\n')[1]!).recordKind).toBe('session/fact-batch')
    expect(labels(fromJSONL(text))).toEqual(['H', 'S11', 'tail'])
  })

  it.each([3, 11])('rejects a future duplicate of established address %s at that append', seq => {
    const session = fixture()
    const index = createConversationValidationIndex(session.events, { formatVersion: 7 })
    expect(() => index.stage([{ type: 'assistant/message', seq, text: 'collision' }])).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason: 'unsafe-address' }))
    expect(index.eventCount).toBe(12)
    expect(() => validateConversationHistory([...session.events, { type: 'assistant/message', seq, text: 'collision' }], 7)).toThrow()
    expect(() => validateConversationHistory([{ type: 'assistant/message', seq, text: 'A' }, { type: 'assistant/message', seq, text: 'B' }], 7)).not.toThrow()
  })

  it('does not let future closure or rewind bless an earlier replacement', () => {
    const session = fixture()
    session.events.splice(10, 0, { ...replacement(session), seq: 10, replacementId: 'too-early', coverage: [{ item: { kind: 'exchange', at: { seq: 9, part: 'message' } }, sources: [{ seq: 8, part: 'step' }, { seq: 9, part: 'message' }] }], insertBefore: { kind: 'exchange', at: { seq: 9, part: 'message' } } })
    session.events.splice(12)
    session.events[11] = { type: 'step/end', seq: 11 }
    session.events.push({ type: 'rewind/point', version: 1, seq: 12, anchorSeq: 8, targetTurn: 0, mode: 'conversation', fileOps: [] })
    expect(() => validateConversationHistory(session.events, 7)).toThrowError(expect.objectContaining({ reason: 'incomplete-unit' }))
  })

  it('compares address values independently of JSON object property order', () => {
    const session = fixture()
    replacement(session).coverage[0].sources[0] = { part: 'step', seq: 2 }
    expect(labels(session)).toEqual(['H', 'S11', 'tail'])
  })

  it('rejects selecting an exchange while an input shares its physical step', () => {
    const session = fixture()
    const event = { ...replacement(session), seq: 6, coverage: [replacement(session).coverage[0]] }
    session.events = [...session.events.slice(0, 4), { type: 'user/message', seq: 4, text: 'steer' }, { type: 'step/end', seq: 5 }, event]
    expect(() => validateConversationHistory(session.events, 7)).toThrowError(expect.objectContaining({ reason: 'incomplete-unit' }))
  })

  it.each(['format', 'forward', 'missing', 'order', 'insert', 'duplicate-id', 'protected', 'unknown-field'])( 'refuses %s before staging commits', fault => {
    const session = fixture()
    const event = replacement(session)
    if (fault === 'format') session.formatVersion = 6
    if (fault === 'forward') event.coverage[0].item.at.seq = 11
    if (fault === 'missing') event.coverage[0].sources.pop()
    if (fault === 'order') event.coverage.reverse()
    if (fault === 'insert') event.insertBefore = event.coverage[1].item
    if (fault === 'unknown-field') event.authority = 'human'
    if (fault === 'duplicate-id') session.events.push({ ...event, seq: 12 })
    if (fault === 'protected') {
      event.coverage = [{ item: { kind: 'input', at: { seq: 1, part: 'message' } }, sources: [{ seq: 1, part: 'message' }] }]
      event.insertBefore = event.coverage[0].item
    }
    expect(() => validateConversationHistory(session.events, session.formatVersion)).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT' }))
    const index = createConversationValidationIndex(session.events.slice(0, 11), { formatVersion: session.formatVersion })
    expect(() => index.stage(session.events.slice(11))).toThrowError(expect.objectContaining({ code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT' }))
    expect(index.eventCount).toBe(11)
  })
})
