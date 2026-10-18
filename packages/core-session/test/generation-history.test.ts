import { describe, expect, it } from 'vitest'
import { append, createSession, createNondurableFactOwner, fromJSONL, toJSONL, createConversationValidationIndex, captureFactGroup, resolveFactGroup, projectConversation, projectConversationCandidate, type SessionEvent } from '../src/index.ts'

const digest = 'a'.repeat(64)
const open = { type: 'context/action', version: 1, op: 'open', ownerSessionId: 'document', actionId: 'generation', purpose: 'main', origin: { kind: 'input', seq: 0 }, startedAt: 100, expiresAt: 3_600_100, trustedAt: 100 } as const
const bind = { type: 'context/action', version: 1, op: 'bind', executionDomain: 'physical', ownerSessionId: 'document', actionId: 'generation', retry: { mode: 'normal', maxRetries: 5 }, limits: { total: 20, main: 6, recovery: 6, summary: 8 }, trustedAt: 100 }
const reserve = (ordinal = 1, lane = 'main') => ({ type: 'context/attempt', version: 1, op: 'reserve', ownerSessionId: 'document', actionId: 'generation', attemptId: `physical-${ordinal}`, ordinal, lane, cause: 'initial', incarnation: 'owner-1', semanticId: digest, payloadId: digest, payloadKind: 'http-json-body', trustedAt: 100 })
const failed = (ordinal: number) => ({ type: 'context/attempt', version: 1, op: 'settle', ownerSessionId: 'document', actionId: 'generation', attemptId: `physical-${ordinal}`, disposition: 'failed', sendId: `send-${ordinal}`, trustedAt: 100 })
function session() {
  const value = createSession()
  append(value, { type: 'user/message', text: 'committed work', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  return value
}
const add = (value: ReturnType<typeof session>, event: object) => append(value, event as SessionEvent)

describe('generation accounting through the existing history owner', () => {
  it('semantic seed context remains source-linked through cold and candidate views and cannot enter live or foreign prefix positions', () => {
    const raw = { type: 'user/message' as const, text: 'inherited raw command', provenance: { kind: 'inherited' as const, authority: 'observation' as const, scope: 'turn' as const, producer: 'desktop.input' } }
    const derived = { type: 'user/message' as const, text: 'retained exact derived text', internal: true as const, source: { kind: 'plugin' as const, plugin: 'host-preparation' }, provenance: { kind: 'inherited' as const, authority: 'observation' as const, scope: 'turn' as const, producer: 'host.input-preparation' }, seedInputContext: { rawMessageSeq: 0 } }
    const value = createSession(); value.header = { parentSession: 'parent', seedLength: 2 }
    append(value, raw)
    for (const changed of [{ ...derived, seedInputContext: { rawMessageSeq: 1 } }, { ...derived, provenance: { ...derived.provenance, kind: 'human', authority: 'request' } }]) expect(() => add(value, changed)).toThrow()
    append(value, derived)
    const cold = fromJSONL(toJSONL(value)), projection = projectConversation(cold)
    expect(projection.items[1]!.sources.map(source => source.seq)).toContain(0)
    expect(projectConversationCandidate(cold, [{ type: 'compaction/reset', removedSeqs: [] }], { candidateId: 'seed' }).projection.items).toEqual(projection.items)
    expect(() => append(value, derived)).toThrow()
    const live = createSession(); append(live, raw)
    expect(() => append(live, derived)).toThrow()
    expect(() => createConversationValidationIndex(value.events, { formatVersion: 8, header: { parentSession: 'parent', seedLength: 1 } })).toThrow()
    const staged = createConversationValidationIndex([value.events[0]!], { formatVersion: 8, header: value.header })
    expect(() => staged.stage([{ ...derived, seq: 1, seedInputContext: { rawMessageSeq: 99 } }])).toThrow()
    expect(staged.eventCount).toBe(1)
    staged.stage([{ ...derived, seq: 1 }]).commit()
    expect(staged.eventCount).toBe(2)
  })
  it('the explicitly nondurable owner installs raw and derived preparation promotion atomically', async () => {
    const value = createSession(), action = createNondurableFactOwner(value).beginAction()
    await action.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'raw', text: '/raw', delivery: 'queue', intent: 'user', preparationPolicy: 'human-host', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } })
    await action.captureGeneration([{ ...open, origin: { kind: 'input', seq: 0 } }], () => true).admit()
    const envelope = { type: 'agent/input/preparation' as const, version: 1 as const, preparationId: 'prepare', actionId: 'generation', actionSeq: 1, admissionSeq: 0, inputId: 'raw' }
    await action.captureInputPreparation({ ...envelope, op: 'started', startedAt: 100 }, () => true).admit()
    const source = action.registerSettlementSource(async () => {})
    const result = { ...envelope, op: 'completed' as const, observations: [{ producer: 'host-preparation' as const, text: 'expanded observation' }] }
    await source.inputPreparation.capture(result).admit()
    const outcome = await action.facts.inputs.start({ type: 'agent/input/promoted', version: 1, inputId: 'raw' }, { type: 'user/message', text: '/raw', input: { inputId: 'raw', intent: 'user' }, provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } }, { ...result, seq: 3 })
    expect(outcome).toMatchObject({ kind: 'memory-committed', durability: 'nondurable' })
    expect(value.events.filter(event => event.type === 'agent/input/preparation').map(event => event.op)).toEqual(['started', 'completed', 'promoted'])
    expect(fromJSONL(toJSONL(value)).events).toHaveLength(value.events.length)
    await source.close(); action.finish()
  })
  it('round trips a bound physical reservation as format 8 without inventing a response', () => {
    const value = session()
    expect(() => { add(value, open); add(value, bind); add(value, reserve()) }).not.toThrow()
    const cold = fromJSONL(toJSONL(value))
    expect(cold.formatVersion).toBe(8)
    expect(cold.events.map(event => event.type)).toEqual(['user/message', 'context/action', 'context/action', 'context/attempt'])
  })

  it('pending binding spends nothing and denies a reservation', () => {
    const value = session()
    expect(() => add(value, open)).not.toThrow()
    expect(() => add(value, reserve())).toThrow()
    expect(value.events).toHaveLength(2)
  })

  it('reserves literal six original requests and denies the seventh without mutation', () => {
    const value = session()
    expect(() => { add(value, open); add(value, bind) }).not.toThrow()
    for (let ordinal = 1; ordinal <= 6; ordinal++) { add(value, reserve(ordinal)); add(value, failed(ordinal)) }
    expect(() => add(value, reserve(7))).toThrow()
    expect(value.events.filter(event => event.type === 'context/attempt' && event.op === 'reserve')).toHaveLength(6)
  })

  it('staged rejection preserves both indexes and accepts the next valid suffix', () => {
    const value = session()
    add(value, open); add(value, bind)
    const index = createConversationValidationIndex(value.events, { formatVersion: 8 })
    expect(() => index.stage([{ ...reserve(2), seq: 3 } as SessionEvent])).toThrow()
    expect(index.eventCount).toBe(3)
    index.stage([{ ...reserve(), seq: 3 } as SessionEvent]).commit()
    expect(index.eventCount).toBe(4)
  })

  it('refuses duplicate origins, duplicate binding, foreign owner and ordinal reuse', () => {
    const value = session()
    add(value, open); add(value, bind); add(value, reserve())
    for (const event of [{ ...open, actionId: 'replacement' }, bind, { ...reserve(2), ownerSessionId: 'other' }, reserve()]) {
      expect(() => add(value, event)).toThrow()
      expect(value.events).toHaveLength(4)
    }
  })

  it('refuses excessive retry policies, backward clocks, late bind and forbidden DTO slots', () => {
    const value = session()
    add(value, open)
    for (const event of [{ ...bind, retry: { mode: 'always', maxRetries: Number.MAX_SAFE_INTEGER } }, { ...bind, trustedAt: 99 }, { ...bind, body: 'secret' }, { ...bind, limits: { ...bind.limits, total: 21 } }]) expect(() => add(value, event)).toThrow()
    add(value, bind)
    add(value, { type: 'context/action', version: 1, op: 'close', ownerSessionId: 'document', actionId: 'generation', disposition: 'expired', trustedAt: 100 })
    expect(() => add(value, bind)).toThrow()
    expect(() => add(value, reserve())).toThrow()
  })

  it('allows three same-ordinal unsent rebinds and rejects a fourth or an issued rebind', () => {
    const value = session()
    add(value, open); add(value, bind); add(value, reserve())
    const base = { type: 'context/attempt', version: 1, op: 'rebind', ownerSessionId: 'document', actionId: 'generation', attemptId: 'physical-1', incarnation: 'owner-1', semanticId: digest, payloadId: 'b'.repeat(64), payloadKind: 'http-json-body', trustedAt: 100 }
    for (const rebind of [1, 2, 3]) {
      add(value, { type: 'context/attempt', version: 1, op: 'settle', ownerSessionId: 'document', actionId: 'generation', attemptId: 'physical-1', disposition: 'unsent', trustedAt: 100 })
      add(value, { ...base, rebind })
    }
    expect(() => add(value, { ...base, rebind: 4 })).toThrow()
    add(value, { type: 'context/attempt', version: 1, op: 'settle', ownerSessionId: 'document', actionId: 'generation', attemptId: 'physical-1', disposition: 'issued', sendId: 'send-1', trustedAt: 100 })
    expect(() => add(value, { ...base, rebind: 3 })).toThrow()
  })

  it('does not let seed import transport operational action authority', () => {
    const value = session()
    add(value, open)
    const captured = captureFactGroup({ kind: 'seed-import', events: value.events.slice(1) })
    expect(captured.kind).toBe('captured')
    if (captured.kind === 'captured') expect(() => resolveFactGroup(captured.group, createSession(), 0)).toThrow(/operational authority/)
  })
  it('the three-rebind ceiling belongs to the whole action rather than each later reservation', () => {
    const value = session(); add(value, open); add(value, bind); add(value, reserve())
    const rebound = { ...reserve(), op: 'rebind', payloadId: 'b'.repeat(64) }
    const { ordinal: _ordinal, lane: _lane, cause: _cause, ...candidate } = rebound
    for (const rebind of [1, 2, 3]) {
      add(value, { type: 'context/attempt', version: 1, op: 'settle', ownerSessionId: 'document', actionId: 'generation', attemptId: 'physical-1', disposition: 'unsent', trustedAt: 100 })
      add(value, { ...candidate, rebind })
    }
    add(value, failed(1)); add(value, reserve(2))
    add(value, { type: 'context/attempt', version: 1, op: 'settle', ownerSessionId: 'document', actionId: 'generation', attemptId: 'physical-2', disposition: 'unsent', trustedAt: 100 })
    expect(() => add(value, { ...candidate, attemptId: 'physical-2', rebind: 1 })).toThrow()
  })
  it('retains historical spend when limits lower and rejects every later increase, including cold reopen', () => {
    const value = session()
    add(value, open); add(value, bind)
    for (let ordinal = 1; ordinal <= 3; ordinal++) { add(value, reserve(ordinal)); add(value, failed(ordinal)) }
    const constraint = { type: 'context/action', version: 1, op: 'constrain', ownerSessionId: 'document', actionId: 'generation', trustedAt: 100, expiresAt: 1000, limits: { total: 1, main: 1, recovery: 1, summary: 8 } }
    expect(() => add(value, constraint)).not.toThrow()
    const cold = fromJSONL(toJSONL(value))
    expect(cold.events.filter(event => event.type === 'context/attempt' && event.op === 'reserve')).toHaveLength(3)
    expect(() => add(cold, { ...constraint, limits: bind.limits })).toThrow()
    expect(() => add(cold, { ...constraint, expiresAt: 2000 })).toThrow()
    expect(() => add(cold, reserve(4))).toThrow()
  })

  it('rejects inherited and observation inputs as main origins', () => {
    for (const kind of ['inherited', 'plugin'] as const) {
      const value = createSession()
      append(value, { type: 'user/message', text: 'observation', provenance: { kind, authority: 'observation', scope: 'turn', producer: 'fixture' } })
      expect(() => add(value, open)).toThrow()
    }
  })

  it('the physical accepted linkage rejects foreign or changed B2 payload facts without mutating staged history', () => {
    const value = session()
    append(value, { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
    add(value, open); add(value, bind)
    append(value, { type: 'step/start', actionId: 'generation', attemptId: 'logical-attempt' })
    add(value, reserve())
    add(value, { type: 'context/attempt', version: 1, op: 'settle', ownerSessionId: 'document', actionId: 'generation', attemptId: 'physical-1', disposition: 'completed', sendId: 'send-1', trustedAt: 100 })
    const request = { version: 1, ownerSessionId: 'document', observationLifetimeId: 'observation', candidateId: 'candidate', sendId: 'send-1', semanticId: digest, payloadId: digest, payloadKind: 'http-json-body', executionEpochId: 'epoch', coldCompatible: false,
      snapshot: { semanticRevision: digest, protectionRevision: digest, branchId: digest, contextEpoch: digest, surfaceRevision: digest }, projectionRevision: 0 }
    const accepted = { type: 'model/exchange-accepted', version: 2, seq: 8, exchangeId: 'exchange', actionId: 'generation', attemptId: 'logical-attempt', stepStartSeq: 4, assistantSeq: 7, callSeqs: [], request }
    const link = { type: 'context/action', version: 1, seq: 9, op: 'accepted', executionDomain: 'physical', ownerSessionId: 'document', actionId: 'generation', attemptId: 'physical-1', acceptedSeq: 8, sendId: 'send-1', trustedAt: 100 }
    const index = createConversationValidationIndex(value.events, { formatVersion: 8 })
    for (const changed of [{ ...request, ownerSessionId: 'foreign' }, { ...request, semanticId: 'b'.repeat(64) }, { ...request, payloadId: 'b'.repeat(64) }, { ...request, payloadKind: 'sdk-command-estimate' }]) {
      expect(() => index.stage([{ type: 'assistant/message', seq: 7, text: 'accepted' }, { ...accepted, request: changed }, link] as SessionEvent[])).toThrow()
      expect(index.eventCount).toBe(7)
    }
    index.stage([{ type: 'assistant/message', seq: 7, text: 'accepted' }, accepted, link] as SessionEvent[]).commit()
    expect(index.eventCount).toBe(10)
  })
  it('does not execute prepared-input accessors while capturing the atomic promotion group', () => {
    let reads = 0
    const preparation = { type: 'agent/input/preparation', version: 1, op: 'completed', get observations() { reads++; return [] } }
    const result = captureFactGroup({ kind: 'input-start', turn: { type: 'turn/start' }, message: { type: 'user/message', text: 'raw' }, preparation } as never)
    expect(result).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
    expect(reads).toBe(0)
  })
  it('a new child-local delegated admission opens independently while seed and foreign input identities refuse', () => {
    const value = createSession()
    value.header = { parentSession: 'parent', seedLength: 2 }
    append(value, { type: 'user/message', text: 'inherited seed', provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'session.seed', originSessionId: 'parent' } })
    append(value, { type: 'step/end' })
    append(value, { type: 'agent/input/admitted', version: 1, inputId: 'child-new', text: 'new delegated task', delivery: 'queue', intent: 'user', provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.initial', originSessionId: 'parent' } })
    const delegated = { ...open, origin: { kind: 'delegated-input', ref: 'admitted', seq: 2, inputId: 'child-new' } }
    expect(() => add(value, { ...delegated, origin: { ...delegated.origin, seq: 0 } })).toThrow()
    expect(() => add(value, { ...delegated, origin: { ...delegated.origin, inputId: 'foreign' } })).toThrow()
    expect(() => add(value, { ...open, origin: { kind: 'input', seq: 2 } })).toThrow()
    expect(() => add(value, delegated)).not.toThrow()
    expect(fromJSONL(toJSONL(value)).events.at(-1)).toMatchObject({ type: 'context/action', op: 'open', origin: delegated.origin })
    expect(() => add(value, { ...delegated, actionId: 'renewed' })).toThrow()
  })
})

it('local acceptance links only its own completed committed invocation in full, staged and cold validation', () => {
  const value = session()
  append(value, { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
  add(value, open); add(value, { ...bind, executionDomain: 'local-test' })
  append(value, { type: 'step/start', actionId: 'generation', attemptId: 'logical-attempt' })
  const envelope = { type: 'context/action', version: 1, ownerSessionId: 'document', actionId: 'generation', trustedAt: 100 }
  add(value, { ...envelope, op: 'local-invocation', localInvocationId: 'local-1', ordinal: 1, lane: 'main', incarnation: 'owner-1' })
  add(value, { ...envelope, op: 'local-settle', localInvocationId: 'local-1', disposition: 'completed' })
  const accepted = { type: 'model/exchange-accepted', version: 1, seq: 8, exchangeId: 'exchange', actionId: 'generation', attemptId: 'logical-attempt', stepStartSeq: 4, assistantSeq: 7, callSeqs: [] }
  const link = { ...envelope, seq: 9, op: 'accepted', executionDomain: 'local-test', localInvocationId: 'local-1', acceptedSeq: 8 }
  const index = createConversationValidationIndex(value.events, { formatVersion: 8 })
  for (const changed of [{ ...link, localInvocationId: 'foreign' }, { ...link, executionDomain: 'physical', attemptId: 'physical-1', sendId: 'send' }, { ...link, payloadId: digest }]) {
    const suffix = [{ type: 'assistant/message', seq: 7, text: 'local accepted' }, accepted, changed] as SessionEvent[]
    expect(() => index.stage(suffix)).toThrow(); expect(index.eventCount).toBe(7)
    expect(() => createConversationValidationIndex([...value.events, ...suffix], { formatVersion: 8 })).toThrow()
  }
  index.stage([{ type: 'assistant/message', seq: 7, text: 'local accepted' }, accepted, link] as SessionEvent[]).commit()
  const complete = { ...value, events: [...value.events, { type: 'assistant/message', seq: 7, text: 'local accepted' }, accepted, link] as SessionEvent[] }
  expect(fromJSONL(toJSONL(complete)).events).toEqual(complete.events)
  expect(complete.events.filter(event => event.type === 'context/attempt')).toHaveLength(0)
})
