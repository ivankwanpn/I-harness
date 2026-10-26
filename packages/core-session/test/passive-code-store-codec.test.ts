import { expect, it } from 'vitest'
import { append, createSession, exportConversationSeed, type Session } from '../src/index.ts'
import type { FactOwner } from '../src/managed/ports.ts'
import { createManagedSessionState } from '../src/managed/view.ts'
import { validatePassiveCodeStore } from '../src/projection/passive-code-store/validate.ts'
import type { PassiveCodeStoreV1 } from '../src/projection/passive-code-store.ts'
import { semanticSeedFromRecords } from '../src/conversation/seed-codec.ts'
import type { SeedExport, SemanticSeedV2 } from '../src/conversation/seed-types.ts'
import { seedHash, semanticSeedDomain, seedPreimage } from '../src/conversation/seed-digest.ts'
import { replayPassiveCodeStore } from '../src/projection/passive-code-store.ts'

function heldExport(source: Session) {
  const managed = createManagedSessionState(source), factOwner = {} as FactOwner; managed.bindOwner(factOwner)
  return exportConversationSeed(managed.view, { kind: 'session', sessionId: 'o' }, { kind: 'completed' }, { kind: 'public-completed-passive', owner: { kind: 'held-public-fork', sourceSessionId: 'o', view: managed.view, factOwner, assertCurrent() {} } })
}
function ready(exported: Extract<SeedExport, { kind: 'seed' }>): Session {
  const seed = exported.seed, seedLength = seed.groups.length + 1, dependencyDigest = seedHash('ih.semantic-seed.dependencies.v1', seed.artifacts)
  const { groups, ...manifest } = seed
  const codec = seed.version === 2 ? 'semantic-seed-v2' : 'semantic-seed-v1'
  return { formatVersion: 13, header: { parentSession: 'source', seedLength, semanticSeed: { version: seed.version, codec, operationId: 'literal', requestDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), seedDigest: exported.digest, dependencyDigest, seedLength, groupCount: groups.length } as import('../src/events/bootstrap.ts').SeedHeader }, events: [
    { ...manifest, type: 'conversation/seed-manifest', seq: 0, codec, digest: exported.digest, groupCount: groups.length } as Session['events'][number],
    ...groups.map((group, ordinal) => ({ type: 'conversation/seed-group' as const, version: 1 as const, seq: ordinal + 1, manifestSeq: 0 as const, ordinal, group })),
    { type: 'session/bootstrap', version: 1, seq: seedLength, operationId: 'literal', manifestDigest: 'b'.repeat(64), dependencyClosureDigest: dependencyDigest, seedLength },
  ] }
}
function wire(seed: SemanticSeedV2): Extract<SeedExport, { kind: 'seed' }> {
  const observation = seedHash('ih.semantic-seed.source.v2', seedPreimage(seed))
  seed.origins = [{ kind: 'session', sessionId: 'o', revision: observation }, ...seed.origins.slice(1)]
  return { kind: 'seed', seed, digest: seedHash('ih.semantic-seed.v2', seed), sourceObservationDigest: observation }
}

const store: PassiveCodeStoreV1 = { version: 1, units: 1, keys: ['x'], values: [{ valueJson: '{"z":1,"a":2}' }], rows: [{ kind: 'put', unit: 0, key: 0, value: 0 }, { kind: 'eligible', unit: 0, value: true }], cuts: [{ end: 0 }, { end: 2 }], latest: 1, completed: [{ turn: 1, cut: 1 }], groups: [0] }
const domain = { total: 1, completed: [[1, 1]] as const, unframedPrefix: false }
it('validates closed passive metadata and exact native values including fault aliases', () => {
  expect(validatePassiveCodeStore(store, domain, 1)).toEqual(store)
  expect(validatePassiveCodeStore({ version: 1, units: 0, keys: [], values: [], rows: [], cuts: [{ end: 0, overLimit: true }, { end: 0 }], latest: 1, completed: [], groups: [0] }, domain, 1).cuts).toHaveLength(2)
})
it.each([
  (s: any) => { s.version = 2 }, (s: any) => { s.extra = 1 }, (s: any) => { s.units = 2 },
  (s: any) => { s.rows[0].value = 9 }, (s: any) => { s.rows[1].value = 1 }, (s: any) => { s.rows[0].origin = 'bad' },
  (s: any) => { s.values[0].valueJson = '{"x":1,"x":2}' }, (s: any) => { s.values[0].valueJson = ' 1' },
  (s: any) => { s.values[0].valueJson = '"\\u0061"' }, (s: any) => { s.values[0].valueJson = '1e400' },
  (s: any) => { s.values[0].valueJson = 'NaN'; s.cuts[1].overLimit = true }, (s: any) => { s.values[0].extra = 1 },
  (s: any) => { s.cuts[1].overLimit = false }, (s: any) => { s.cuts[0].end = 2; s.cuts[1].end = 1 },
  (s: any) => { s.groups = [] }, (s: any) => { s.latest = 99 }, (s: any) => { s.completed.push({ turn: 1, cut: 0 }) },
  (s: any) => { s.rows[0].kind = 'touch'; delete s.rows[0].value },
])('refuses malformed passive wire case %s', mutate => {
  const bad = structuredClone(store); mutate(bad)
  expect(() => validatePassiveCodeStore(bad, domain, 1)).toThrow()
})
it('captures a held completed seed as V2 but keeps anonymous/no-option exports V1', () => {
  const source = createSession(); append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'one' })
  append(source, { type: 'code/store', version: 1, sessionId: 'o', cellId: 'c', writes: [['x', 7]] }); append(source, { type: 'code/cell', sessionId: 'o', cellId: 'c', state: 'completed' }); append(source, { type: 'turn/end' })
  const managed = createManagedSessionState(source), factOwner = {} as FactOwner; managed.bindOwner(factOwner)
  const owner = { kind: 'held-public-fork' as const, sourceSessionId: 'o', view: managed.view, factOwner, assertCurrent() {} }
  const captured = exportConversationSeed(managed.view, { kind: 'session', sessionId: 'o' }, { kind: 'completed' }, { kind: 'public-completed-passive', owner })
  expect(captured.kind === 'seed' && captured.seed.version).toBe(2)
  expect(exportConversationSeed(managed.view, { kind: 'anonymous' }, { kind: 'completed' }).kind).toBe('seed')
  const ordinary = exportConversationSeed(managed.view, { kind: 'session', sessionId: 'o' }, { kind: 'completed' })
  expect(ordinary.kind === 'seed' && ordinary.seed.version).toBe(1)
  expect(exportConversationSeed(managed.view, { kind: 'session', sessionId: 'wrong' }, { kind: 'completed' }, { kind: 'public-completed-passive', owner })).toEqual({ kind: 'refused', reason: 'source-unsupported' })
  let guards = 0
  expect(exportConversationSeed(managed.view, { kind: 'session', sessionId: 'o' }, { kind: 'completed' }, { kind: 'public-completed-passive', owner: { ...owner, assertCurrent() { if (++guards >= 3) throw Error('stale after capture') } } })).toEqual({ kind: 'refused', reason: 'source-changed' })
})
it('reconstructs from actual matching header and records and refuses codec mismatch', () => {
  const source: Session = { formatVersion: 13, events: [] }
  expect(() => semanticSeedFromRecords({ version: 2 } as any, source.events)).toThrow()
})
it('captures actual inherited V2 touches and exact valueJson through two nested core captures', () => {
  const source = createSession(); append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'one' })
  append(source, { type: 'code/store', version: 1, sessionId: 'o', cellId: 'c', writes: [['x', 'obsolete'.repeat(100)], ['y', 2], ['x', { z: 1, a: 2 }]] })
  append(source, { type: 'code/cell', sessionId: 'o', cellId: 'c', state: 'completed' }); append(source, { type: 'turn/end' })
  const original = heldExport(source); if (original.kind !== 'seed' || original.seed.version !== 2) throw Error('V2 required')
  const first = heldExport(ready(original)); expect(first.kind === 'seed' && first.seed.version).toBe(2)
  if (first.kind !== 'seed' || first.seed.version !== 2) throw Error('nested V2 required')
  const second = heldExport(ready(first)); if (second.kind !== 'seed' || second.seed.version !== 2) throw Error('nested V2 required')
  expect(replayPassiveCodeStore(second.seed.passive.codeStore, second.seed.passive.codeStore.latest)).toEqual({ kind: 'value', entries: [['x', { z: 1, a: 2 }], ['y', 2]] })
  expect(JSON.stringify(second.seed)).not.toContain('obsolete')
  expect(second.seed.passive.codeStore.values.some(value => value.valueJson === '{"z":1,"a":2}')).toBe(true)
  expect(semanticSeedFromRecords(ready(second).header!.semanticSeed!, ready(second).events)).toEqual(second.seed)
  const mismatch = ready(second); mismatch.header!.semanticSeed = { ...mismatch.header!.semanticSeed!, version: 1, codec: 'semantic-seed-v1' }
  expect(() => semanticSeedFromRecords(mismatch.header!.semanticSeed!, mismatch.events)).toThrow()
})
it('preserves an inherited group fault beside ordinary empty latest without V1 omission', () => {
  const source = createSession(); append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'one' }); append(source, { type: 'turn/end' })
  const ordinary = exportConversationSeed(source, { kind: 'session', sessionId: 'o' }, { kind: 'completed' }); if (ordinary.kind !== 'seed') throw Error('seed required')
  const seed: SemanticSeedV2 = { ...ordinary.seed, version: 2, selection: { kind: 'completed' }, passive: { codeStore: { version: 1, units: 0, keys: [], values: [], rows: [], cuts: [{ end: 0, overLimit: true }, { end: 0 }], latest: 1, groups: [0], completed: [{ turn: 1, cut: 1 }] } } }
  const preimage = { version: 2, source: { kind: 'session', sessionId: 'o' }, inheritedOrigins: [], selection: seed.selection, turns: seed.turns, omissions: seed.omissions, artifacts: seed.artifacts, groups: seed.groups, passive: seed.passive }
  const observation = seedHash('ih.semantic-seed.source.v2', preimage); seed.origins = [{ kind: 'session', sessionId: 'o', revision: observation }]
  const exported = heldExport(ready({ kind: 'seed', seed, digest: seedHash(semanticSeedDomain(seed), seed), sourceObservationDigest: observation }))
  expect(exported.kind === 'seed' && exported.seed.version).toBe(2)
  if (exported.kind !== 'seed' || exported.seed.version !== 2) throw Error('fault must remain V2')
  const data = exported.seed.passive.codeStore
  expect(replayPassiveCodeStore(data, data.latest)).toEqual({ kind: 'value', entries: [] })
  expect(replayPassiveCodeStore(data, data.groups[0]!)).toEqual({ kind: 'limit-exceeded' })
  const nested = heldExport(ready(exported)); if (nested.kind !== 'seed' || nested.seed.version !== 2) throw Error('nested fault must remain V2')
  expect(replayPassiveCodeStore(nested.seed.passive.codeStore, nested.seed.passive.codeStore.groups[0]!)).toEqual({ kind: 'limit-exceeded' })
  expect(replayPassiveCodeStore(nested.seed.passive.codeStore, nested.seed.passive.codeStore.latest)).toEqual({ kind: 'value', entries: [] })
})
it('validates decoded full-entry quota and complete readiness/prefix reconstruction before exposing V2', () => {
  const large = structuredClone(store)
  large.keys = ['x', 'y']; large.values = [{ valueJson: JSON.stringify('a'.repeat(2_100_000)) }, { valueJson: JSON.stringify('b'.repeat(2_100_000)) }]
  large.rows = [{ kind: 'put', unit: 0, key: 0, value: 0 }, { kind: 'put', unit: 0, key: 1, value: 1 }, { kind: 'eligible', unit: 0, value: true }]
  large.cuts = [{ end: 0 }, { end: 3 }]
  expect(() => validatePassiveCodeStore(large, domain, 1)).toThrow('Session store transfer limit exceeded')
  const source = createSession(); append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'one' })
  append(source, { type: 'code/store', version: 1, cellId: 'c', sessionId: 'o', writes: [['x', 7]] }); append(source, { type: 'code/cell', cellId: 'c', sessionId: 'o', state: 'completed' }); append(source, { type: 'turn/end' })
  const exported = heldExport(source); if (exported.kind !== 'seed') throw Error('seed required')
  const target = ready(exported), manifestOnly = { ...target, events: target.events.slice(0, 1) }
  expect(() => createManagedSessionState(manifestOnly)).toThrow('bootstrap-incomplete')
  const altered = structuredClone(target), manifest = altered.events[0]
  if (manifest?.type !== 'conversation/seed-manifest' || manifest.version !== 2) throw Error('V2 required')
  manifest.passive.codeStore.values = [{ valueJson: '8' }]
  expect(() => createManagedSessionState(altered)).toThrow()
})
it('translates original nonmonotone group aliases before union and preserves post-marker commits', () => {
  const conversation = createSession()
  for (const text of ['one', 'two']) { append(conversation, { type: 'turn/start' }); append(conversation, { type: 'user/message', text }); append(conversation, { type: 'turn/end' }) }
  const ordinary = exportConversationSeed(conversation, { kind: 'session', sessionId: 'o' }, { kind: 'completed' }); if (ordinary.kind !== 'seed') throw Error('seed required')
  const rows: PassiveCodeStoreV1['rows'][number][] = []
  for (let value = 0; value < 9; value++) rows.push({ kind: 'put', unit: 0, key: 0, value }, { kind: 'eligible', unit: 0, value: true })
  const data: PassiveCodeStoreV1 = { version: 1, units: 1, keys: ['basis'], values: Array.from({ length: 9 }, (_, value) => ({ valueJson: String(value + 1) })), rows,
    cuts: Array.from({ length: 10 }, (_, cut) => ({ end: cut * 2 })), latest: 9, completed: [{ turn: 1, cut: 9 }, { turn: 2, cut: 9 }], groups: [8, 3] }
  const source = ready(wire({ ...ordinary.seed, version: 2, selection: { kind: 'completed' }, passive: { codeStore: data } }))
  append(source, { type: 'rewind/point', version: 1, targetTurn: 2, anchorSeq: 2, mode: 'conversation', fileOps: [] })
  append(source, { type: 'code/store', version: 1, cellId: 'removed', sessionId: 'o', writes: [['branch', 8]] }); append(source, { type: 'code/cell', cellId: 'removed', sessionId: 'o', state: 'completed' })
  append(source, { type: 'rewind/point', version: 1, targetTurn: 1, anchorSeq: 1, mode: 'conversation', fileOps: [] })
  append(source, { type: 'code/store', version: 1, cellId: 'new', sessionId: 'o', writes: [['branch', 9]] }); append(source, { type: 'code/cell', cellId: 'new', sessionId: 'o', state: 'completed' })
  const exported = heldExport(source); if (exported.kind !== 'seed' || exported.seed.version !== 2) throw Error('V2 required')
  const result = exported.seed.passive.codeStore
  expect(replayPassiveCodeStore(result, result.latest)).toEqual({ kind: 'value', entries: [['basis', 3], ['branch', 9]] })
  const nested = heldExport(ready(exported)); if (nested.kind !== 'seed' || nested.seed.version !== 2) throw Error('nested V2 required')
  expect(replayPassiveCodeStore(nested.seed.passive.codeStore, nested.seed.passive.codeStore.latest)).toEqual({ kind: 'value', entries: [['basis', 3], ['branch', 9]] })
})
