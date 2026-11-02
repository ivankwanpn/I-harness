import { expect, it, vi } from 'vitest'
import { validateSemanticSeed } from '../src/conversation/seed-codec.ts'
import { seedHash } from '../src/conversation/seed-digest.ts'
import { exportConversationSeed, exportSelectedResultsConversationSeed } from '../src/conversation/seed-export.ts'
import { codecSeed, codecRow, codecPage, codecWire, sealCodecSeed } from './fixtures/selected-results.ts'
import { validateSelectedResultsRecordPrefix, semanticSeedFromRecords, validateSemanticSeedStructure } from '../src/conversation/seed-codec.ts'
import { createConversationValidationIndex, createBootstrapConversationIndex } from '../src/conversation/validation.ts'
import { semanticSeedResultRefs } from '../src/results/seed-refs.ts'
import { captureSelectedResultsBootstrapPreparationFacts, captureBootstrapPreparationFacts } from '../src/conversation/bootstrap-facts.ts'
import { compileSelectedResultsSemanticSeed, compileSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { createManagedSessionState, createBootstrapManagedSessionState } from '../src/managed/view.ts'
import { createCompletedPassiveContext } from '../src/conversation/passive-seed-context.ts'
import { captureSeedSelectionForResults } from '../src/conversation/seed-capture.ts'
import { projectSelectedResults } from '../src/conversation/selected-results.ts'
import type { Session } from '../src/events/types.ts'
import type { FactOwner } from '../src/managed/ports.ts'
import { bootstrapMemorySession } from '../src/managed/memory-bootstrap.ts'
import { resolveSeedBoundary } from '../src/conversation/seed-selection.ts'
import { canonicalJsonData } from '../src/serialization/json-data.ts'
import { createSeedOriginNormalizer } from '../src/conversation/seed-origins.ts'
import * as originsOwner from '../src/conversation/seed-origins.ts'
import * as resultOwner from '../src/conversation/selected-results.ts'
import * as captureOwner from '../src/conversation/seed-capture.ts'
import * as passiveOwner from '../src/projection/passive-code-store/capture.ts'
import * as renderer from '../src/conversation/render-items.ts'
import { normalizeInheritedCodeStore } from '../src/projection/passive-code-store/inherited.ts'
import { replaySessionCodeStore } from '../src/projection/passive-code-store/restore.ts'
import { literalSeed } from './fixtures/format11-seed.ts'
import { literalSession } from './fixtures/semantic-observation.ts'

function heldSource(source: Session, sessionId: string) {
  const managed = createManagedSessionState(source, { sessionId }), factOwner = {} as FactOwner
  managed.bindOwner(factOwner)
  let current = true
  const assertCurrent = () => { if (!current) throw Error('retired source') }
  const owner = { kind: 'held-public-fork' as const, view: managed.view, factOwner, sourceSessionId: sessionId, assertCurrent }
  const inherited = { assertCurrent, async *legacy() { assertCurrent() } }
  const context = () => { const result = createCompletedPassiveContext(owner, { kind: 'completed' }); if (result.kind !== 'ready') throw Error(result.reason); return result.context }
  return { managed, owner, inherited, context, retire() { current = false } }
}
function declaredSource(): Session {
  const events: any[] = [{ type: 'turn/start' }, { type: 'step/start' }, { type: 'tool/call', callId: 'c', name: 'read', args: {} },
    { type: 'assistant/message', text: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] }, { type: 'tool/dispatch', callId: 'c', eventSeq: 2 },
    { type: 'tool/result', callId: 'c', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: codecRow().ref } } },
    { type: 'step/end' }, { type: 'turn/end' }]
  return { formatVersion: 13, events: events.map((event, seq) => ({ ...event, seq })) }
}

it('keeps result-only historical origin zero across actual held S→A→B metadata projection after validated producer consumption', async () => {
  const source = heldSource(declaredSource(), 'S')
  const a = await exportSelectedResultsConversationSeed(source.context(), source.inherited)
  expect(a.kind).toBe('seed'); if (a.kind !== 'seed') throw Error(a.kind === 'refused' ? a.reason : a.kind)
  const aWire = codecWire(a), aSource = heldSource(aWire, 'A')
  // Codec/read fixture only: no old installer or new durable route is invoked.
  const groupSeqs = aWire.records.filter((record: any) => record.type === 'conversation/seed-group').map((record: any) => record.seq)
  aSource.managed.stage([{ type: 'compaction/reset', seq: aWire.events.length, removedSeqs: groupSeqs }]).install()
  source.retire()
  const selected = aSource.context()
  expect(selected.selected.groups).toHaveLength(0)
  const b = await exportSelectedResultsConversationSeed(selected, aSource.inherited)
  expect(b.kind).toBe('seed'); if (b.kind !== 'seed') throw Error(b.kind === 'refused' ? b.reason : b.kind)
  expect(b.seed.groups).toHaveLength(0)
  expect(b.seed.results.summary.rows).toBe(1)
  expect(b.seed.origins).toEqual([{ kind: 'session', sessionId: 'A', revision: b.sourceObservationDigest }, { kind: 'session', sessionId: 'S', revision: a.sourceObservationDigest }])
  const row = b.seed.results.pages[0]!.rows[0]!
  expect(row.original).toEqual(a.seed.results.pages[0]!.rows[0]!.original)
  expect(row.basis).toEqual({ kind: 'inherited', parentSeedDigest: a.digest, parentResultsDigest: a.seed.results.summary.digest, row: 0 })
  expect(row.branchEvidence.every(at => at.origin === 1)).toBe(true)
  expect(compileSelectedResultsSemanticSeed(b).records).toEqual(codecWire(b).records)
  expect(semanticSeedFromRecords(codecWire(b).header.semanticSeed, codecWire(b).events)).toEqual(b.seed)
})

it('retains an inherited closed result beside an unrelated open omission in the same turn', async () => {
  const session = declaredSource()
  session.events.splice(-1, 0, { type: 'step/start' }, { type: 'tool/call', callId: 'open', name: 'pending', args: {} })
  session.events = session.events.map((event, seq) => ({ ...event, seq }))
  const source = heldSource(session, 'S'), a = await exportSelectedResultsConversationSeed(source.context(), source.inherited)
  if (a.kind !== 'seed') throw Error('first source refused')
  expect(a.seed.omissions).toHaveLength(1); expect(a.seed.results.summary.rows).toBe(1)
  const reader = heldSource(codecWire(a), 'A'), b = await exportSelectedResultsConversationSeed(reader.context(), reader.inherited)
  if (b.kind !== 'seed') throw Error('descendant refused')
  expect(b.seed.omissions).toHaveLength(1)
  expect(b.seed.results.summary.rows).toBe(1)
  expect(b.seed.results.pages[0]!.rows[0]!.original).toEqual(a.seed.results.pages[0]!.rows[0]!.original)
})

it('binds one frozen origin plan to its original context, one payload capture and every iterator currentness check', async () => {
  const source = heldSource(declaredSource(), 'S'), context = source.context()
  const outcome = await projectSelectedResults(context, source.inherited)
  expect(outcome.kind).toBe('selected'); if (outcome.kind !== 'selected') throw Error(outcome.reason)
  expect(() => captureSeedSelectionForResults(source.context(), outcome.results)).toThrow()
  expect(() => captureSeedSelectionForResults(context, { ...outcome.results })).toThrow()
  const captured = captureSeedSelectionForResults(context, outcome.results)
  expect(captured.groups).not.toHaveLength(0)
  expect(() => captureSeedSelectionForResults(context, outcome.results)).toThrow()
  const iterator = outcome.results.pages()[Symbol.asyncIterator]()
  await iterator.next(); source.retire()
  await expect(iterator.next()).rejects.toThrow('retired source')
  await expect(iterator.return!()).rejects.toThrow('retired source')
})

it('finalizes one held plan before the single conversation/passive capture and compiles repeatably without recapture', async () => {
  const source = heldSource(declaredSource(), 'S'), context = source.context(), real = originsOwner.createSeedOriginNormalizer
  const finalizations: ReturnType<typeof vi.fn>[] = []
  const factory = vi.spyOn(originsOwner, 'createSeedOriginNormalizer').mockImplementation(() => {
    const normalizer = real(), finalize = normalizer.finalize
    const observed = vi.fn(finalize); finalizations.push(observed); normalizer.finalize = observed
    return normalizer
  })
  const project = vi.spyOn(resultOwner, 'projectSelectedResults'), capture = vi.spyOn(captureOwner, 'captureSeedSelectionForResults'), old = vi.spyOn(captureOwner, 'captureSeedSelection')
  const passive = vi.spyOn(passiveOwner, 'capturePassiveCodeStoreData'), originalRender = renderer.renderConversationItems
  const render = vi.spyOn(renderer, 'renderConversationItems').mockImplementation((...args) => {
    expect(finalizations).toHaveLength(1); expect(finalizations[0]).toHaveBeenCalledTimes(1)
    return originalRender(...args)
  })
  try {
    const exported = await exportSelectedResultsConversationSeed(context, source.inherited)
    expect(exported.kind).toBe('seed'); if (exported.kind !== 'seed') throw Error('source refused')
    expect(factory).toHaveBeenCalledTimes(1); expect(project).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledTimes(1)
    expect(passive).toHaveBeenCalledTimes(1); expect(render).toHaveBeenCalledTimes(1); expect(old).not.toHaveBeenCalled()
    expect(finalizations[0]).toHaveBeenCalledTimes(1)
    const once = canonicalJsonData(compileSelectedResultsSemanticSeed(exported)), twice = canonicalJsonData(compileSelectedResultsSemanticSeed(exported))
    expect(twice).toBe(once); expect(capture).toHaveBeenCalledTimes(1); expect(render).toHaveBeenCalledTimes(1)
  } finally { vi.restoreAllMocks() }
})

it('refuses source retirement during metadata await and before later payload capture', async () => {
  const source = heldSource(declaredSource(), 'S'), context = source.context()
  expect(await projectSelectedResults(context, { assertCurrent: source.inherited.assertCurrent, async *legacy() { await Promise.resolve(); source.retire() } })).toEqual({ kind: 'refused', reason: 'source-changed' })
  const next = heldSource(declaredSource(), 'T'), nextContext = next.context(), projected = await projectSelectedResults(nextContext, next.inherited)
  if (projected.kind !== 'selected') throw Error('source refused')
  next.retire()
  expect(() => captureSeedSelectionForResults(nextContext, projected.results)).toThrow('retired source')
})

// Pure codec fixtures establish metadata shape/integrity, never writer authority.
function emptyV3(profile = 'child-history'): any {
  const summary = { version: 1, rows: 0, pages: 0, digest: seedHash('ih.selected-results.end.v1', {
    previous: seedHash('ih.selected-results.start.v1', { version: 1, rows: 0, pages: 0 }), rows: 0, pages: 0 }) }
  const common = { profile, selection: profile === 'public-completed' ? { kind: 'completed' } : { kind: 'all' },
    turns: { total: 0, completed: [], unframedPrefix: false }, omissions: [], artifacts: [], groups: [], results: { summary, pages: [] } }
  const preimage = { version: 3, source: { kind: 'session', sessionId: 'source' }, inheritedOrigins: [], ...common }
  return { version: 3, origins: [{ kind: 'session', sessionId: 'source', revision: seedHash('ih.semantic-seed.source.v3', preimage) }], ...common }
}

it('validates a complete zero-page child metadata seed without creating passive data', () => {
  const seed = emptyV3()
  expect(() => validateSemanticSeed(seed)).not.toThrow()
  expect(Object.hasOwn(seed, 'passive')).toBe(false)
})

it.each(['public-completed', 'child-history'])('roundtrips closed %s profiles with complete-prefix and shifted group coordinates', profile => {
  const exported = codecSeed(profile, [codecPage([codecRow()])]), wire = codecWire(exported)
  const compiled = compileSelectedResultsSemanticSeed(exported)
  expect(compiled.records).toEqual(wire.records)
  expect(compiled.dependencyDigest).toBe(wire.header.semanticSeed.dependencyDigest)
  expect(semanticSeedFromRecords(wire.header.semanticSeed, wire.events)).toEqual(exported.seed)
  expect(validateSelectedResultsRecordPrefix(wire.header.semanticSeed, [])).toEqual({ kind: 'prefix', resultPages: 0, groups: 0 })
  expect(validateSelectedResultsRecordPrefix(wire.header.semanticSeed, wire.records.slice(0, 1))).toEqual({ kind: 'prefix', resultPages: 0, groups: 0 })
  expect(validateSelectedResultsRecordPrefix(wire.header.semanticSeed, wire.records)).toEqual({ kind: 'complete', seed: exported.seed })
  expect(createConversationValidationIndex(wire.events, { formatVersion: 13, header: wire.header }).history().items).toEqual([])
  expect(semanticSeedResultRefs(wire)).toEqual([codecRow().ref])
  expect(() => semanticSeedResultRefs({ ...wire, events: wire.records })).toThrow('bootstrap-incomplete')
  expect(() => compileSemanticSeed(exported)).toThrow('Legacy semantic seed')
})

it('retains A/B/A extent runs and distinct uses of one ref while deduplicating immutable roots', () => {
  const rows = [codecRow(0, 1), codecRow(1, 2), codecRow(2, 1)]
  rows[2].original.slot = 'envelope.dependencies.ref'; rows[2].use = { kind: 'dependency-catalog', count: 7 }
  const exported = codecSeed('child-history', rows.map((row, ordinal) => codecPage([row], ordinal)))
  expect(() => validateSemanticSeed(exported.seed)).not.toThrow()
  const wire = codecWire(exported)
  expect(wire.records.map((r: any) => r.seq)).toEqual([0, 1, 2, 3])
  expect(semanticSeedResultRefs(wire)).toEqual([rows[0].ref])
  for (let end = 1; end < wire.records.length; end++) expect(validateSelectedResultsRecordPrefix(wire.header.semanticSeed, wire.records.slice(0, end))).toEqual({ kind: 'prefix', resultPages: end - 1, groups: 0 })
})

it.each([
  (s: any) => { s.passive = undefined }, (s: any) => { s.passive = {} }, (s: any) => { s.profile = 'public-completed' },
  (s: any) => { s.selection = { kind: 'completed' } }, (s: any) => { s.results.extra = true },
  (s: any) => { s.results.pages[0].rows[0].branchEvidence[0].origin = 1 },
  (s: any) => { s.results.pages[0].rows[0].basis.unit.at.origin = 1 },
  (s: any) => { s.results.pages[0].rows[0].original.item = 0 },
  (s: any) => { s.results.pages[0].extent.first = 2 }, (s: any) => { s.results.pages[0].firstRow = 1 },
])('rejects closed-profile/table tampering even after independent commitment recomputation (%#)', mutate => {
  const exported = codecSeed('child-history', [codecPage([codecRow()])]); mutate(exported.seed)
  if (!Object.hasOwn(exported.seed, 'passive') || exported.seed.passive !== undefined) sealCodecSeed(exported.seed)
  expect(() => validateSemanticSeed(exported.seed)).toThrow()
  expect(() => validateSemanticSeedStructure(exported.seed)).toThrow()
})

it('denies incomplete/reordered/duplicate pages, summary mismatches and post-prefix resource records', () => {
  const wire = codecWire(codecSeed('child-history', [codecPage([codecRow()])]))
  expect(() => semanticSeedFromRecords(wire.header.semanticSeed, wire.records.slice(0, 1))).toThrow()
  for (const mutate of [
    (w: any) => { w.records[1].ordinal = 1 }, (w: any) => { w.records[1].seq = 2 },
    (w: any) => { w.header.semanticSeed.results.rows = 2 }, (w: any) => { w.header.semanticSeed.resultPageCount = Number.MAX_SAFE_INTEGER },
    (w: any) => { w.records[1].page.rows[0].use = { kind: 'dependency-catalog', count: 0 } },
  ]) { const bad = structuredClone(wire); mutate(bad); expect(() => validateSelectedResultsRecordPrefix(bad.header.semanticSeed, bad.records)).toThrow() }
  expect(() => createConversationValidationIndex([...wire.events, { ...wire.records[1], seq: wire.events.length }], { formatVersion: 13, header: wire.header })).toThrow()
  expect(() => createConversationValidationIndex(wire.records, { formatVersion: 13 })).toThrow()
  const corrupted = structuredClone(wire)
  corrupted.records[1].page.rows[0].ref.encodedBytes++
  expect(() => semanticSeedFromRecords(corrupted.header.semanticSeed, corrupted.records)).toThrow()
  const dependency = structuredClone(wire); dependency.header.semanticSeed.dependencyDigest = 'f'.repeat(64)
  expect(() => semanticSeedResultRefs(dependency)).toThrow()
})

it('does not expose selected membership from committed staging prefixes before completion', () => {
  const wire = codecWire(codecSeed('child-history', [codecPage([codecRow()])]))
  const backing: any[] = []
  const index = createBootstrapConversationIndex([], position => backing[position], 13, wire.header)
  index.stage(wire.records).commit()
  backing.push(...wire.records)
  expect(index.semanticSeedResultRefs()).toEqual([])
  index.stage(wire.events.slice(wire.records.length)).commit()
  expect(index.semanticSeedResultRefs()).toEqual([codecRow().ref])
  const staged = createBootstrapManagedSessionState({ ...wire, events: wire.records }, { sessionId: 'incomplete' }), factOwner = {} as FactOwner
  staged.bindOwner(factOwner)
  const context = createCompletedPassiveContext({ kind: 'held-public-fork', sourceSessionId: 'incomplete', view: staged.view, factOwner, assertCurrent() {} }, { kind: 'completed' })
  expect(context.kind).toBe('refused')
})

function addCodecGroups(exported: any) {
  exported.seed.groups = [1, 2].map(turn => ({ extent: { kind: 'framed', first: turn, last: turn }, items: [{ kind: 'summary', scope: 'turn', extent: { kind: 'framed', first: turn, last: turn },
    origins: [{ origin: 0, seq: turn, part: 'message' }], sourceProvenance: [{ origin: 0, kind: 'summary', authority: 'derived', scope: 'turn' }], messages: [{ role: 'user', content: 'summary' }] }] }))
  if (exported.seed.profile === 'public-completed') exported.seed.passive.codeStore.groups = [0, 0]
  return sealCodecSeed(exported.seed)
}
it('uses shifted group anchors and denies result-page boundaries while pages create no HistoryItems', () => {
  const exported = addCodecGroups(codecSeed('child-history', [codecPage([codecRow(0, 1)]), codecPage([codecRow(1, 2)], 1)])), wire = codecWire(exported)
  expect(compileSelectedResultsSemanticSeed(exported).records.map(record => [record.type, record.seq])).toEqual([
    ['conversation/seed-manifest', 0], ['conversation/seed-results', 1], ['conversation/seed-results', 2], ['conversation/seed-group', 3], ['conversation/seed-group', 4] ])
  expect(createConversationValidationIndex(wire.events, { formatVersion: 13, header: wire.header }).history().items).toHaveLength(2)
  expect(resolveSeedBoundary(wire, { kind: 'completed', atSeq: 1 })).toEqual({ kind: 'refused', reason: 'ambiguous-boundary' })
  expect(resolveSeedBoundary(wire, { kind: 'completed', atSeq: 3 })).toEqual({ kind: 'resolved', boundary: { last: 1 } })
  for (let end = 1; end < wire.records.length; end++) expect(validateSelectedResultsRecordPrefix(wire.header.semanticSeed, wire.records.slice(0, end))).toEqual({ kind: 'prefix', resultPages: Math.min(2, end - 1), groups: Math.max(0, end - 3) })
})

it('cuts inherited membership by turn extent even when the affected page physically precedes the cut group', () => {
  const first = codecRow(0, 1), second = codecRow(1, 2); second.ref.id = 'ctxv1_' + 'b'.repeat(64); second.ref.revision = 'b'.repeat(64)
  const wire = codecWire(addCodecGroups(codecSeed('child-history', [codecPage([first]), codecPage([second], 1)])))
  const cut = { ...wire, events: [...wire.events, { type: 'rewind/point', seq: wire.events.length, anchorSeq: 4 }] }
  expect(semanticSeedResultRefs(cut)).toEqual([first.ref])
  const hidden = { ...wire, events: [...wire.events, { type: 'compaction/reset', seq: wire.events.length, removedSeqs: [2] }] }
  expect(semanticSeedResultRefs(hidden)).toEqual([first.ref])
  const spanning = codecRow(); spanning.extent.last = 2
  const partial = codecWire(addCodecGroups(codecSeed('child-history', [codecPage([spanning])])))
  expect(() => semanticSeedResultRefs({ ...partial, events: [...partial.events, { type: 'rewind/point', seq: partial.events.length, anchorSeq: 3 }] })).toThrow('Ambiguous inherited result cut')
})

it('maps public passive cuts at resource pages only through actual inherited turn aliases and refuses unavailable aliases', () => {
  const exported = addCodecGroups(codecSeed('public-completed', [codecPage([codecRow()])])), wire = codecWire(exported), data = exported.seed.passive.codeStore
  const windows = [{ startRank: 1, endRank: 4, cutFrom: 1, markerSeq: 4, markerIndex: 4 }]
  expect(normalizeInheritedCodeStore(wire, data, data.latest, windows).emptyBase).toBe(false)
  expect(replaySessionCodeStore(wire)).toEqual({ kind: 'value', entries: [] })
  const unavailable = codecSeed('public-completed', [codecPage([codecRow()])]), noGroup = codecWire(unavailable)
  expect(() => normalizeInheritedCodeStore(noGroup, unavailable.seed.passive.codeStore, 0, windows)).toThrow('Unavailable inherited result cut')
  const span = codecRow(); span.extent.last = 2
  const partial = codecSeed('public-completed', [codecPage([span])])
  expect(() => normalizeInheritedCodeStore(codecWire(partial), partial.seed.passive.codeStore, 0, windows)).toThrow('Partial inherited result cut')
})

it('counts the entire UTF8 resource envelope at the 65536 byte boundary, including escaping and Unicode', () => {
  const row = codecRow(); row.protocol = 'legacy'; delete row.use
  row.original = { kind: 'local', sessionId: 'source', seq: 4, event: 'context/result-ref', slot: 'ref' }
  row.ref = { id: 'ctx_' + 'c'.repeat(64), workspaceId: 'w', sessionId: 'source', callId: 'c', label: '界\\"', revision: 'c'.repeat(64), bytes: 12, originalBytes: 12, complete: true, expiresAt: 9999999999999 }
  const page = codecPage([row]), record = { type: 'conversation/seed-results', version: 1, seq: 1, manifestSeq: 0, ordinal: 0, page }
  const overhead = Buffer.byteLength(canonicalJsonData(record))
  row.ref.label += 'x'.repeat(65536 - overhead)
  expect(Buffer.byteLength(canonicalJsonData(record))).toBe(65536)
  expect(() => validateSemanticSeed(codecSeed('child-history', [page]).seed)).not.toThrow()
  row.ref.label += 'x'
  expect(() => validateSemanticSeed(codecSeed('child-history', [page]).seed)).toThrow()
})

it('requires page row limits and the canonical same-extent flush boundary', () => {
  const rows = Array.from({ length: 101 }, (_, i) => {
    const row = codecRow(i); row.protocol = 'legacy'; delete row.use
    row.original = { kind: 'local', sessionId: 's', seq: i, event: 'context/result-ref', slot: 'ref' }
    row.ref = { id: 'r', revision: 'v', sessionId: 's', workspaceId: 'w', callId: 'c', label: '', bytes: 0, originalBytes: 0, complete: true, expiresAt: 1 }
    return row
  })
  expect(() => validateSemanticSeed(codecSeed('child-history', [codecPage(rows)]).seed)).toThrow()
  expect(() => validateSemanticSeed(codecSeed('child-history', [codecPage(rows.slice(0, 100)), codecPage(rows.slice(100), 1)]).seed)).not.toThrow()
  expect(() => validateSemanticSeed(codecSeed('child-history', [codecPage(rows.slice(0, 99)), codecPage(rows.slice(99), 1)]).seed)).toThrow()
})

it('normalizes historical descriptors by exact identity and UTF8 order independently of encounter order, including old zero and two revisions', () => {
  // Internal normalization mechanism only; these descriptors grant no B1 row.
  const descriptors = [{ kind: 'session', sessionId: 'z', revision: 'a'.repeat(64) }, { kind: 'session', sessionId: 'same', revision: 'b'.repeat(64) },
    { kind: 'session', sessionId: 'same', revision: 'a'.repeat(64) }, { kind: 'anonymous', contentDigest: 'c'.repeat(64) }]
  const normalize = (order: number[]) => {
    const owner = createSeedOriginNormalizer(), manifest: any = { origins: descriptors }, provisional = new Map<number, number>()
    for (const slot of order) provisional.set(slot, owner.origin(manifest, slot))
    const origins = owner.finalize()
    expect(owner.origin(manifest, 0)).toBe(3)
    expect(owner.remap(0)).toBe(0)
    expect(() => owner.origin({ origins: [{ kind: 'session', sessionId: 'unused', revision: 'd'.repeat(64) }] } as any, 0)).toThrow()
    return { origins, slots: descriptors.map((_, slot) => owner.remap(provisional.get(slot)!)) }
  }
  const expected = { origins: [descriptors[3], descriptors[2], descriptors[0], descriptors[1]], slots: [3, 4, 2, 1] }
  expect(normalize([0, 1, 2, 3, 0, 1])).toEqual(expected)
  expect(normalize([3, 2, 1, 0, 1, 0])).toEqual(expected)
})

it('collects the actual selected conversation, artifact, omission-only and result union through the shared frozen owner', async () => {
  const descriptors: any[] = [{ kind: 'session', sessionId: 'z', revision: 'a'.repeat(64) }, { kind: 'anonymous', contentDigest: 'b'.repeat(64) },
    { kind: 'session', sessionId: 'same', revision: 'c'.repeat(64) }, { kind: 'session', sessionId: 'same', revision: 'd'.repeat(64) },
    { kind: 'session', sessionId: 'omission-only', revision: 'e'.repeat(64) }, { kind: 'anonymous', contentDigest: 'f'.repeat(64) }]
  const capture = async (reversed: boolean) => {
    const seed: any = structuredClone(literalSeed), order = reversed ? [5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5]
    seed.origins = [seed.origins[0], ...order.map(index => descriptors[index])]
    const at = (descriptor: number, part: string) => ({ origin: 1 + order.indexOf(descriptor), seq: 4, part })
    const input = { ...seed.groups[0].items[0], kind: 'input', origins: [at(0, 'message')], sourceProvenance: [{ origin: at(0, 'message').origin, kind: 'human', authority: 'request', scope: 'turn' }],
      input: { raw: [at(0, 'message')], derivedContext: [at(1, 'message')], media: [], omittedWork: 0 } }
    const exchange = seed.groups[0].items[1]
    exchange.origins = [at(1, 'call')]; exchange.sourceProvenance = [{ origin: at(2, 'call').origin, kind: 'plugin', authority: 'observation', scope: 'turn' }]
    exchange.calls[0].source = [at(0, 'call')]
    exchange.results = [{ kind: 'envelope', message: 1, source: [at(1, 'result')], media: [], execution: { outcome: 'succeeded', dispatch: 'dispatched' },
      sourceRetention: { kind: 'artifact', artifact: 0 }, dependencies: { kind: 'catalog', artifact: 0, count: 7 } }]
    seed.groups[0].items = [input, exchange]
    seed.artifacts = [{ ref: codecRow().ref, origins: [at(3, 'result')], uses: [{ kind: 'result' }, { kind: 'dependency-catalog', count: 7 }] }]
    seed.omissions = [{ extent: { kind: 'framed', first: 1, last: 2 }, source: [at(4, 'step')], state: 'open', calls: 1, relatedInputs: [0], digest: '0'.repeat(64) }]
    const session = literalSession(seed)
    for (const event of [{ type: 'turn/start' }, { type: 'user/message', text: 'local A' }, { type: 'turn/end' }]) session.events.push({ ...event, seq: session.events.length } as any)
    const source = heldSource(session, 'A'), exported = await exportSelectedResultsConversationSeed(source.context(), source.inherited)
    if (exported.kind !== 'seed') throw Error('source refused: ' + exported.kind)
    return exported
  }
  const a = await capture(false), b = await capture(true)
  expect(a).toEqual(b)
  expect(a.seed.origins.slice(1)).toEqual([descriptors[1], descriptors[0], descriptors[2], descriptors[3], descriptors[4]])
  expect(a.seed.origins).toHaveLength(6)
  expect(a.seed.omissions[0]!.source[0]!.origin).toBe(5)
  expect(a.seed.artifacts[0]!.origins[0]!.origin).toBe(4)
  expect(a.seed.groups.at(-1)!.items[0]!.origins.every(at => at.origin === 0)).toBe(true)
  expect(a.seed.results.summary.rows).toBe(2)
  expect(a.seed.results.pages[0]!.rows.every(row => row.branchEvidence.every(at => at.origin === 0))).toBe(true)
})

it.each(['at', 'closedAt', 'consumedAt', 'latestConsumption', 'completedCell', 'branchEvidence'])('validates the named %s origin path, including basis-only referenced origins', path => {
  const row = codecRow(), address = { origin: 1, seq: 10, part: 'code/cell' }
  if (path === 'consumedAt' || path === 'latestConsumption') row.basis = { kind: 'consumed-closed', unit: { kind: 'exchange', at: { ...address, seq: 1 }, closedAt: { ...address, seq: 2 } }, consumedAt: { ...address, seq: 3 }, latestConsumption: { ...address, seq: 4 } }
  else if (path === 'completedCell') row.basis = { kind: 'standalone-native', unit: { kind: 'code-cell', at: { ...address, seq: 1 }, closedAt: address }, completedCell: address }
  else if (path === 'branchEvidence') row.branchEvidence = [address]
  else row.basis.unit = { ...row.basis.unit, at: { ...address, seq: 1 }, closedAt: { ...address, seq: 2 } }
  const exported = codecSeed('child-history', [codecPage([row])])
  exported.seed.origins.push({ kind: 'session', sessionId: 'historical', revision: 'b'.repeat(64) })
  const valid = sealCodecSeed(exported.seed)
  expect(() => validateSemanticSeed(valid.seed)).not.toThrow()
  const bad = structuredClone(valid.seed), changed = bad.results.pages[0].rows[0]
  if (path === 'branchEvidence') changed.branchEvidence[0].origin = 2
  else if (path === 'at' || path === 'closedAt') changed.basis.unit[path].origin = 2
  else changed.basis[path].origin = 2
  sealCodecSeed(bad)
  expect(() => validateSemanticSeed(bad)).toThrow()
})

it('requires the exact referenced imported-origin union even after table/source/seed rehashing', () => {
  const exported = codecSeed('child-history', [codecPage([codecRow()])])
  exported.seed.origins.push({ kind: 'session', sessionId: 'unused', revision: 'b'.repeat(64) })
  sealCodecSeed(exported.seed)
  expect(() => validateSemanticSeed(exported.seed)).toThrow()
  const duplicate = codecSeed('child-history', [codecPage([codecRow()])])
  duplicate.seed.origins.push({ kind: 'session', sessionId: 'h', revision: 'b'.repeat(64) }, { kind: 'session', sessionId: 'h', revision: 'b'.repeat(64) })
  duplicate.seed.results.pages[0].rows[0].branchEvidence = [{ origin: 1, seq: 1, part: 'result' }, { origin: 2, seq: 1, part: 'result' }]
  sealCodecSeed(duplicate.seed)
  expect(() => validateSemanticSeed(duplicate.seed)).toThrow()
})

it('refuses V3 through the actual old memory installer without installation or currentness callback', () => {
  const target: Session = { formatVersion: 13, events: [] }, wire = codecWire(codecSeed())
  let callbacks = 0
  expect(() => bootstrapMemorySession(target, wire.header, wire.events, () => { callbacks++; return true })).toThrow('Legacy memory bootstrap')
  expect(target.events).toEqual([]); expect(target.header).toBeUndefined(); expect(callbacks).toBe(0)
})

it('parses separate metadata-only facts V2 with exact safe prefix arithmetic while V1 stays closed', () => {
  const wire = codecWire(codecSeed()), header = wire.header.semanticSeed
  const facts: any = { version: 2, invocation: { version: 1, operationId: 'codec', targetSessionId: 'target', createdAt: '2026-10-28T00:00:00.000Z', requestDigest: 'a'.repeat(64) },
    manifestDigest: header.manifestDigest, seedDigest: header.seedDigest, dependencyDigest: header.dependencyDigest, sourceObservation: { kind: 'semantic', digest: wire.records[0].origins[0].revision },
    seedLength: 1, groupCount: 0, resultPageCount: 0, semantic: { version: 3, profile: 'child-history', selection: { kind: 'all' }, turns: wire.records[0].turns, results: header.results } }
  expect(captureSelectedResultsBootstrapPreparationFacts(facts)).toEqual(facts)
  expect(() => captureBootstrapPreparationFacts(facts)).toThrow()
  for (const mutate of [(f: any) => { f.seedLength = 0 }, (f: any) => { f.semantic.passive = {} }, (f: any) => { f.semantic.profile = 'public-completed' },
    (f: any) => { f.sourceObservation = { kind: 'none' } }, (f: any) => { f.semantic.results.digest = 'a'.repeat(64) }, (f: any) => { f.resultPageCount = 1 }]) {
    const bad = structuredClone(facts); mutate(bad); expect(() => captureSelectedResultsBootstrapPreparationFacts(bad)).toThrow()
  }
})

it('refuses V3 parents through the old all exporter before inspecting history while none remains payload-free', () => {
  let reads = 0
  const view: any = { formatVersion: 13, header: { semanticSeed: { version: 3 } }, get events() { reads++; throw new Error('history read') } }
  expect(exportConversationSeed(view, { kind: 'session', sessionId: 'source' }, { kind: 'none' })).toEqual({ kind: 'none' })
  expect(reads).toBe(0)
  expect(exportConversationSeed(view, { kind: 'session', sessionId: 'source' }, { kind: 'all' })).toEqual({ kind: 'refused', reason: 'source-unsupported' })
  expect(reads).toBe(0)
})

it('resolves V3 result page ordinals to their exact physical seed coordinates',async()=>{
 const {seedLayout}=await import('../src/conversation/seed-layout.ts')
 const header=codecWire(codecSeed('public-completed',[codecPage([codecRow()])])).header.semanticSeed
 const layout=seedLayout({...header,groupCount:1,seedLength:3});expect(layout.resultPageSeq(0)).toBe(1);expect(layout.groupSeq(0)).toBe(2)
 for(const ordinal of [-1,1,Number.MAX_SAFE_INTEGER,0.5])expect(()=>layout.resultPageSeq(ordinal)).toThrow()
})

it('resolves only a surviving V3 seed-result anchor and exact global row',async()=>{
 const {createLegacyReadVisibility}=await import('../src/conversation/seed-retention.ts')
 const row=codecRow();row.protocol='legacy';delete row.use;row.original={kind:'local',sessionId:'source',seq:4,event:'context/result-ref',slot:'ref'}
 row.ref={id:'ctx_'+'c'.repeat(64),workspaceId:'w',sessionId:'source',callId:'c',label:'selected',revision:'c'.repeat(64),bytes:12,originalBytes:12,complete:true,expiresAt:9999999999999}
 const wire=codecWire(codecSeed('public-completed',[codecPage([row])])),visible=createLegacyReadVisibility(wire)
 if(visible.kind!=='visible')throw Error('Original seed is not visible')
 const anchor={kind:'seed-result' as const,manifestSeq:0 as const,pageOrdinal:0,rowOrdinal:0}
 expect(visible.resultRow(anchor,row.extent)).toEqual(row)
 expect(visible.resultRow({...anchor,rowOrdinal:1},row.extent)).toBeUndefined()
 expect(visible.resultRow({...anchor,pageOrdinal:1},row.extent)).toBeUndefined()
 expect(visible.resultRow(anchor,{kind:'framed',first:2,last:2})).toBeUndefined()
 const shadow=createLegacyReadVisibility({...wire,events:[...wire.events,{type:'compaction/reset',seq:wire.events.length,removedSeqs:[1]}]})
 if(shadow.kind!=='visible')throw Error('Original shadowed seed invalid');expect(shadow.resultRow(anchor,row.extent)).toBeUndefined()
})

it('admits only closed V3 seed-result metadata anchors',async()=>{
 const {inheritedResultMetadata}=await import('../src/conversation/history/result-inherited.ts')
 const ref={id:'ctx_'+'c'.repeat(64),workspaceId:'w',sessionId:'source',callId:'c',label:'selected',revision:'c'.repeat(64),bytes:12,originalBytes:12,complete:true,expiresAt:9999999999999},original={kind:'local',sessionId:'source',seq:4,event:'context/result-ref',slot:'ref'},extent={kind:'framed',first:1,last:1},anchor={kind:'seed-result',manifestSeq:0,pageOrdinal:0,rowOrdinal:0},input={ref,original,extent,anchor}
 expect(inheritedResultMetadata(input)).toEqual(input)
 for(const invalid of [{...anchor,pageOrdinal:-1},{...anchor,rowOrdinal:0.5},{...anchor,manifestSeq:1},{...anchor,extra:true}])expect(()=>inheritedResultMetadata({...input,anchor:invalid})).toThrow()
})

it('qualifies each inherited V3 legacy row once through its original metadata anchor',async()=>{
 const row=codecRow();row.protocol='legacy';delete row.use;row.original={kind:'local',sessionId:'source',seq:4,event:'context/result-ref',slot:'ref'}
 row.ref={id:'ctx_'+'c'.repeat(64),workspaceId:'w',sessionId:'source',callId:'c',label:'selected',revision:'c'.repeat(64),bytes:12,originalBytes:12,complete:true,expiresAt:9999999999999}
 const source=heldSource(codecWire(codecSeed('public-completed',[codecPage([row])])),'A'),anchor={kind:'seed-result' as const,manifestSeq:0 as const,pageOrdinal:0,rowOrdinal:0},metadata={ref:row.ref,original:row.original,extent:row.extent,anchor}
 const reader={assertCurrent:source.owner.assertCurrent,async *legacy(){yield metadata}},result=await projectSelectedResults(source.context(),reader)
 expect(result.kind).toBe('selected');if(result.kind!=='selected')throw Error(result.reason)
 const pages=[];for await(const page of result.results.pages())pages.push(page);expect(pages.flatMap(page=>page.rows)).toHaveLength(1);expect(pages[0]!.rows[0]).toMatchObject({protocol:'legacy',original:row.original,basis:{kind:'inherited',row:0}})
 const missing=await projectSelectedResults(source.context(),source.inherited);expect(missing.kind).toBe('refused')
 const duplicate=await projectSelectedResults(source.context(),{...reader,async *legacy(){yield metadata;yield metadata}});expect(duplicate.kind).toBe('refused')
})

it('preserves original mixed V3 row order after legacy metadata qualification',async()=>{
 const legacy=codecRow(0);legacy.protocol='legacy';delete legacy.use;legacy.original={kind:'local',sessionId:'source',seq:4,event:'context/result-ref',slot:'ref'}
 legacy.ref={id:'ctx_'+'c'.repeat(64),workspaceId:'w',sessionId:'source',callId:'c',label:'selected',revision:'c'.repeat(64),bytes:12,originalBytes:12,complete:true,expiresAt:9999999999999}
 const managed=codecRow(1),source=heldSource(codecWire(codecSeed('public-completed',[codecPage([legacy,managed])])),'A'),metadata={ref:legacy.ref,original:legacy.original,extent:legacy.extent,anchor:{kind:'seed-result' as const,manifestSeq:0 as const,pageOrdinal:0,rowOrdinal:0}}
 const result=await projectSelectedResults(source.context(),{assertCurrent:source.owner.assertCurrent,async *legacy(){yield metadata}});expect(result.kind).toBe('selected');if(result.kind!=='selected')throw Error(result.reason)
 const rows=[];for await(const page of result.results.pages())rows.push(...page.rows);expect(rows.map(row=>row.protocol)).toEqual(['legacy','managed'])
})

it('preserves duplicate-reference V3 observations by exact row anchor and rejects copied anchors',async()=>{
 const ref={id:'ctx_'+'c'.repeat(64),workspaceId:'w',sessionId:'source',callId:'c',label:'selected',revision:'c'.repeat(64),bytes:12,originalBytes:12,complete:true,expiresAt:9999999999999}
 const rows=[0,1].map(ordinal=>{const row=codecRow(ordinal);row.protocol='legacy';delete row.use;row.ref=ref;row.original={kind:'local',sessionId:'source',seq:4+ordinal,event:'context/result-ref',slot:'ref'};return row})
 const source=heldSource(codecWire(codecSeed('public-completed',[codecPage(rows)])),'A'),metadata=rows.map((row,ordinal)=>({ref,original:row.original,extent:row.extent,anchor:{kind:'seed-result' as const,manifestSeq:0 as const,pageOrdinal:0,rowOrdinal:ordinal}}))
 const result=await projectSelectedResults(source.context(),{assertCurrent:source.owner.assertCurrent,async *legacy(){yield* metadata}});expect(result.kind).toBe('selected');if(result.kind!=='selected')throw Error(result.reason)
 const selected=[];for await(const page of result.results.pages())selected.push(...page.rows);expect(selected.map(row=>row.original.seq)).toEqual([4,5])
 const copied=await projectSelectedResults(source.context(),{assertCurrent:source.owner.assertCurrent,async *legacy(){yield metadata[0]!;yield {...metadata[1]!,anchor:metadata[0]!.anchor}}});expect(copied.kind).toBe('refused')
})

it('resolves V3 page ordinals separately from global row ordinals',async()=>{
 const {createLegacyReadVisibility}=await import('../src/conversation/seed-retention.ts')
 const ref={id:'ctx_'+'c'.repeat(64),workspaceId:'w',sessionId:'source',callId:'c',label:'selected',revision:'c'.repeat(64),bytes:12,originalBytes:12,complete:true,expiresAt:9999999999999}
 const rows=[0,1].map(ordinal=>{const row=codecRow(ordinal,ordinal+1);row.protocol='legacy';delete row.use;row.ref=ref;row.original={kind:'local',sessionId:'source',seq:4+ordinal,event:'context/result-ref',slot:'ref'};return row})
 const wire=codecWire(codecSeed('public-completed',[codecPage([rows[0]]),codecPage([rows[1]],1)])),visible=createLegacyReadVisibility(wire);if(visible.kind!=='visible')throw Error('Source unavailable')
 const second={kind:'seed-result' as const,manifestSeq:0 as const,pageOrdinal:1,rowOrdinal:1};expect(visible.resultRow(second,rows[1].extent)).toEqual(rows[1]);expect(visible.resultRow({...second,pageOrdinal:0},rows[1].extent)).toBeUndefined()
})

it('private Code fold matches V3 inherited page aliases and refuses unavailable cuts',async()=>{
 const {createExecutionCodeState}=await import('../src/projection/execution-code-state.ts')
 const exported=addCodecGroups(codecSeed('public-completed',[codecPage([codecRow()])])),wire=codecWire(exported)
 const fold=createExecutionCodeState(wire.header,'child');fold.append(wire.events,0)
 expect(fold.snapshot().store).toEqual(replaySessionCodeStore(wire,'child'))
 const point={type:'rewind/point' as const,version:1 as const,targetTurn:1,anchorSeq:1,mode:'conversation' as const,fileOps:[],seq:wire.events.length}
 fold.append([point],point.seq);wire.events.push(point)
 expect(fold.snapshot().store).toEqual(replaySessionCodeStore(wire,'child'))
 const unavailable=codecWire(codecSeed('public-completed',[codecPage([codecRow()])])),bad=createExecutionCodeState(unavailable.header,'child')
 bad.append(unavailable.events,0);bad.append([{...point,seq:unavailable.events.length}],unavailable.events.length)
 expect(()=>bad.snapshot()).toThrow('Unavailable inherited result cut')
})
