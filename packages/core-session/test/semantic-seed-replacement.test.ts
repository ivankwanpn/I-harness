import { expect, it } from 'vitest'
import { append, createSession, projectConversation, readConversationState, validateSemanticSeed, fromJSONL, toJSONL, createNondurableFactOwner, createManagedSessionState, exportConversationSeed, legacyPrefixDigest, readGenerationActions, readInbox } from '../src/index.ts'
import { literalReady, literalSeed } from './fixtures/format11-seed.ts'
import { bootstrapMemorySession, createBootstrapManagedSessionState } from '../src/managed/bootstrap.ts'
import { observationHash } from './fixtures/semantic-observation.ts'

it('reads literal inherited observations without creating pending work or effects', () => {
  expect(validateSemanticSeed(literalSeed)).toEqual(literalSeed)
  const projected = projectConversation(literalReady)
  expect(projected.items.map(item => item.messages.map(message => message.content))).toEqual([['inherited preface'], ['', 'seed exact']])
  expect(projected.items[1]!.exchange?.acceptance).toBe('inherited-observation')
  expect(projected.items.every(item => item.provenance.kind === 'inherited' && item.provenance.authority === 'observation')).toBe(true)
  expect(projected.items[0]!.sources.map(ref => ref.part)).toEqual(['item:0', 'group'])
  expect(readConversationState(literalReady, projected)).toMatchObject({ kind: 'available', state: { pendingInputIds: [], unsettledDelegationIds: [], effects: [] } })
  expect(fromJSONL(toJSONL(literalReady))).toMatchObject(literalReady)
  expect(createManagedSessionState(literalReady).view).toEqual(literalReady)
})

it('requires whole local seed-group coverage and retains consumption after hiding its summary', () => {
  const source = structuredClone(literalReady)
  const projection = projectConversation(source)
  const coverage = projection.items.map(item => ({ item: item.ref!, sources: [...item.sources].map(ref => ({ seq: ref.seq!, part: ref.part })).sort((a, b) => a.seq - b.seq || a.part.localeCompare(b.part)) }))
  const replacement = { type: 'compaction/replacement' as const, version: 1 as const, replacementId: 'whole', text: 'whole summary', coverage, insertBefore: coverage[0]!.item }
  expect(() => append(source, { ...replacement, coverage: coverage.slice(0, 1) })).toThrow(/incomplete-unit/)
  append(source, replacement)
  expect(projectConversation(source).items.map(item => item.messages[0]!.content)).toEqual(['whole summary'])
  append(source, { type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: 3, mode: 'conversation', fileOps: [] })
  expect(projectConversation(source).items).toEqual([])
})

it('refuses public incomplete reservations, including cached mutable header changes and actions', () => {
  for (const length of [0, 1, 2]) {
    const partial = { ...structuredClone(literalReady), events: structuredClone(literalReady.events.slice(0, length)) }
    expect(() => projectConversation(partial)).toThrow(/bootstrap-incomplete/)
    expect(() => createManagedSessionState(partial)).toThrow(/bootstrap-incomplete/)
    expect(() => append(partial, { type: 'turn/start' })).toThrow(/bootstrap-incomplete/)
    expect(() => createNondurableFactOwner(partial).beginAction()).toThrow(/bootstrap-incomplete/)
    expect(() => readInbox(partial).pending()).toThrow(/bootstrap-incomplete/)
  }
  const changed = structuredClone(literalReady)
  append(changed, { type: 'turn/start' })
  changed.header!.semanticSeed!.manifestDigest = 'c'.repeat(64)
  expect(() => append(changed, { type: 'user/message', text: 'bad cache' })).toThrow()
})

it('atomically installs a complete standalone seed before exposing it to observers', () => {
  const target = createSession()
  const receipt = bootstrapMemorySession(target, literalReady.header!, literalReady.events, () => true)
  expect(receipt).toEqual({ kind: 'memory-ready', seedLength: 2 })
  expect(projectConversation(target).items[1]!.messages[1]!.content).toBe('seed exact')
  expect(target.header?.parentSession).toBeUndefined()
  expect(() => bootstrapMemorySession(target, literalReady.header!, literalReady.events, () => true)).toThrow()
  const alreadyBound = createSession()
  createNondurableFactOwner(alreadyBound)
  expect(() => bootstrapMemorySession(alreadyBound, literalReady.header!, literalReady.events, () => true)).toThrow(/pristine|unbound/)
  const exported = exportConversationSeed(target, { kind: 'anonymous' }, { kind: 'completed', atSeq: 1 })
  expect(exported).toEqual({ kind: 'refused', reason: 'ambiguous-boundary' })
})

it('ignores local v1 prune substitutes for inherited result call IDs', () => {
  const source = structuredClone(literalReady)
  append(source, { type: 'compaction/prune', version: 1, pruned: [{ callId: 'same', head: 'wrong', tail: '', removedBytes: 100 }] })
  expect(projectConversation(source).items[1]!.messages[1]!.content).toBe('seed exact')
})

it('refuses malformed complete and interrupted prefixes through cold, projection and source paths', () => {
  const cases: ((value: typeof literalReady) => void)[] = [
    value => { delete value.header!.semanticSeed },
    value => { value.events[0] = { ...value.events[0]!, seq: 1 } },
    value => { value.events.splice(1, 1) },
    value => { if (value.events[1]!.type === 'conversation/seed-group') value.events[1]!.ordinal = 1 },
    value => { if (value.events[0]!.type === 'conversation/seed-manifest') value.events[0]!.groupCount = 2 },
    value => { if (value.events[0]!.type === 'conversation/seed-manifest') value.events[0]!.digest = 'c'.repeat(64) },
    value => { const record = value.events[2]!; if (record.type === 'session/bootstrap') record.operationId = 'other' },
    value => { value.events.push({ ...value.events[1]!, seq: 3 }) },
    value => { value.header!.seedLength = 1 },
    value => { value.events = value.events.slice(0, 1) },
  ]
  for (const mutate of cases) {
    const value = structuredClone(literalReady); mutate(value)
    expect(() => projectConversation(value)).toThrow()
    expect(exportConversationSeed(value, { kind: 'anonymous' }, { kind: 'all' })).toEqual({ kind: 'refused', reason: 'invalid-seed' })
    const body = Buffer.from(value.events.map(event => JSON.stringify(event)).join('\n') + '\n')
    const journal = { version: 1, legacyBodyBytes: body.length, legacyEventCount: value.events.length, legacyPrefixDigest: legacyPrefixDigest(value.events.length, body), separatorBytes: 0 }
    const text = JSON.stringify({ formatVersion: 11, ...value.header, journal }) + '\n' + body.toString('utf8')
    expect(() => fromJSONL(text)).toThrow()
  }
  const partial = { ...structuredClone(literalReady), events: [] }
  expect(() => readGenerationActions(partial.events, partial.header)).toThrow(/bootstrap-incomplete/)
})

it('checks the actual host guard even when the selected observation digest stays unchanged', () => {
  let hostRevision = 1
  const capturedRevision = hostRevision
  const before = exportConversationSeed(literalReady, { kind: 'anonymous' }, { kind: 'all' })
  hostRevision++
  const after = exportConversationSeed(literalReady, { kind: 'anonymous' }, { kind: 'all' })
  expect(after).toEqual(before)
  const target = createSession()
  expect(() => bootstrapMemorySession(target, literalReady.header!, literalReady.events, () => hostRevision === capturedRevision)).toThrow(/FACT_PRECONDITION_STALE/)
  expect(target.events).toEqual([]); expect(target.header).toBeUndefined()
})

it('validates canonical none and binds the whole actual initial admission plus original clocks', () => {
  const source = createSession()
  const input = { type: 'agent/input/admitted' as const, version: 1 as const, inputId: 'initial', text: 'fresh task', delivery: 'queue' as const, intent: 'system' as const,
    provenance: { kind: 'inherited' as const, authority: 'observation' as const, scope: 'turn' as const, producer: 'subagent.initial', originSessionId: 'parent' } }
  const initialStartedAt = 100, initialExpiresAt = 1000
  const initialInputDigest = observationHash('ih.bootstrap.initial-input.v1', { input, startedAt: initialStartedAt, expiresAt: initialExpiresAt })
  source.header = { parentSession: 'parent', seedLength: 0, semanticSeed: { version: 1, codec: 'semantic-seed-v1', operationId: 'none', requestDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64),
    seedDigest: observationHash('ih.semantic-seed.v1', { kind: 'none' }), dependencyDigest: observationHash('ih.semantic-seed.dependencies.v1', []), seedLength: 0, groupCount: 0,
    initialInputId: 'initial', initialInputDigest, initialStartedAt, initialExpiresAt } }
  source.events = [{ type: 'session/bootstrap', version: 1, seq: 0, operationId: 'none', manifestDigest: 'b'.repeat(64), dependencyClosureDigest: 'd'.repeat(64), seedLength: 0, initialInputId: 'initial', initialStartedAt, initialExpiresAt }, { ...input, seq: 1 }]
  expect(projectConversation(source).items).toEqual([])
  for (const mutate of [
    (value: typeof source) => { if (value.events[1]!.type === 'agent/input/admitted') value.events[1]!.text = 'changed' },
    (value: typeof source) => { if (value.events[1]!.type === 'agent/input/admitted') value.events[1]!.provenance!.producer = 'changed' },
    (value: typeof source) => { if (value.events[1]!.type === 'agent/input/admitted') value.events[1]!.clientToken = 'optional-field' },
    (value: typeof source) => { value.header!.semanticSeed!.initialExpiresAt = 2000; if (value.events[0]!.type === 'session/bootstrap') value.events[0]!.initialExpiresAt = 2000 },
    (value: typeof source) => { value.header!.semanticSeed!.seedDigest = 'c'.repeat(64) },
    (value: typeof source) => { value.header!.semanticSeed!.dependencyDigest = 'c'.repeat(64) },
  ]) { const changed = structuredClone(source); mutate(changed); expect(() => projectConversation(changed)).toThrow() }
})

it('stages the managed prefix under the internal bridge and validates each complete group before installation', () => {
  const state = createBootstrapManagedSessionState({ formatVersion: 11, header: literalReady.header, events: [] })
  expect(() => projectConversation(state.view)).toThrow(/bootstrap-incomplete/)
  state.stage([structuredClone(literalReady.events[0]!)]).install()
  expect(() => projectConversation(state.view)).toThrow(/bootstrap-incomplete/)
  const bad = structuredClone(literalReady.events[1]!)
  if (bad.type !== 'conversation/seed-group') throw Error('seed group required')
  Object.assign(bad.group.items[0]!, { permission: 'forged' })
  expect(() => state.stage([bad])).toThrow()
  expect(state.view.events).toHaveLength(1)
  state.stage([structuredClone(literalReady.events[1]!)]).install()
  expect(() => projectConversation(state.view)).toThrow(/bootstrap-incomplete/)
  state.stage([structuredClone(literalReady.events[2]!)]).install()
  expect(projectConversation(state.view)).toEqual(projectConversation(literalReady))
})
