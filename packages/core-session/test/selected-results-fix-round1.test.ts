import { expect, it, vi } from 'vitest'
import { createManagedSessionState, readOwnedSelectionMetadata } from '../src/managed/view.ts'
import type { FactOwner } from '../src/managed/ports.ts'
import type { Session } from '../src/events/types.ts'
import { createCompletedPassiveContext, isOriginalCompletedPassiveContext } from '../src/conversation/passive-seed-context.ts'
import { projectSelectedResults } from '../src/conversation/selected-results.ts'
import { captureSeedSelectionForResults } from '../src/conversation/seed-capture.ts'
import * as renderer from '../src/conversation/render-items.ts'
import { codecRef, codecSeed, codecWire } from './fixtures/selected-results.ts'
import { canonicalJsonData } from '../src/serialization/json-data.ts'
import { literalSeed } from './fixtures/format11-seed.ts'
import { literalSession } from './fixtures/semantic-observation.ts'
import { validateSelectedResultPage } from '../src/conversation/selected-results-codec.ts'
import { validateSeedHeader } from '../src/conversation/bootstrap-validation.ts'

function genuineContext(poisonOwnerBody = false) {
  const events: any[] = [{ type: 'turn/start' }, { type: 'user/message', text: 'before' }, { type: 'step/start' }, { type: 'user/message', text: 'inside' },
    { type: 'tool/call', callId: 'c', name: 'read', args: {} }, { type: 'assistant/message', text: '', toolCalls: [{ id: 'c', name: 'read', args: {} }] },
    { type: 'tool/dispatch', callId: 'c', eventSeq: 4 }, { type: 'tool/result', callId: 'c', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: codecRef } } },
    { type: 'step/end' }, { type: 'step/start' }, { type: 'user/message', text: 'open input' }, { type: 'tool/call', callId: 'open', name: 'pending', args: {} }, { type: 'turn/end' }]
  const session: Session = { formatVersion: 13, events: events.map((event, seq) => ({ ...event, seq })) }
  const managed = createManagedSessionState(session, { sessionId: 'local' }), factOwner = {} as FactOwner
  managed.bindOwner(factOwner)
  const selection = { kind: 'completed' as const }, owner = { kind: 'held-public-fork' as const, sourceSessionId: 'local', view: managed.view, factOwner, assertCurrent() {} }
  let unrelatedBodyReads = 0
  if (poisonOwnerBody) Object.defineProperty(owner, 'unrelatedBody', { enumerable: true, get() { unrelatedBodyReads++; throw Error('unrelated owner body read') } })
  const made = createCompletedPassiveContext(owner, selection)
  if (made.kind !== 'ready') throw Error(made.reason)
  return { context: made.context, selection, unrelatedBodyReads: () => unrelatedBodyReads, inherited: { assertCurrent() {}, async *legacy() {} } }
}
async function collect<T>(values: AsyncIterable<T>) { const result: T[] = []; for await (const value of values) result.push(value); return result }

it.each([
  ['selection', (c: any) => { c.selection.atSeq = 0 }],
  ['boundary', (c: any) => { c.boundary.lastTurn = 0 }],
  ['upper', (c: any) => { c.boundary.upper.eventCount = 0 }],
  ['groups reorder', (c: any) => { c.selected.groups.reverse() }],
  ['items reorder', (c: any) => { const group = c.selected.groups.find((g: any) => g.items.length > 1); if (!group) throw Error('fixture lacks multi-item group'); group.items.reverse() }],
  ['recipe', (c: any) => { c.selected.groups[0].items[0].recipes[0].index = 99 }],
  ['provenance', (c: any) => { c.selected.groups[0].items[0].provenance.scope = 'session' }],
  ['source address', (c: any) => { c.selected.groups[0].items[0].sources[0].seq = 99 }],
  ['omission', (c: any) => { c.selected.omissions[0].source[0].seq = 99 }],
  ['omission map', (c: any) => { c.selected.omittedInputs.clear() }],
  ['turn map', (c: any) => { c.source.turns.extents.set(0, { kind: 'unframed' }) }],
  ['capture anchor', (c: any) => { c.groups[0].anchor.seq = 99 }],
  ['rebase', (c: any) => { c.selected.rebase = () => ({ kind: 'unframed' }) }],
] as const)('I1 keeps authentic all-local-origin %s metadata immutable before the single capture', async (_name, mutate) => {
  const source = genuineContext(), context = source.context, projected = await projectSelectedResults(context, source.inherited)
  if (projected.kind !== 'selected') throw Error(projected.reason)
  const held = projected.results, pages = await collect(held.pages()), before = canonicalJsonData(pages), summary = held.summary
  expect(pages.flatMap(page => page.rows).every(row => row.branchEvidence.every(at => at.origin === 0))).toBe(true)
  expect(pages.flatMap(page => page.rows).length).toBeGreaterThan(0)
  const render = vi.spyOn(renderer, 'renderConversationItems')
  try {
    expect(() => mutate(context)).toThrow(TypeError)
    expect(render).not.toHaveBeenCalled()
    const captured = captureSeedSelectionForResults(context, held)
    expect(captured.groups).toHaveLength(context.selected.groups.length)
    expect(render).toHaveBeenCalledTimes(1)
    expect(canonicalJsonData(await collect(held.pages()))).toBe(before)
    expect(held.summary).toBe(summary)
    expect(context.owner.view.events).toHaveLength(13)
  } finally { vi.restoreAllMocks() }
})

it('I1 detaches external selection aliases and blocks prototype/forEach Map and Set mutation without changing the held plan', async () => {
  const source = genuineContext(), context = source.context, selected = await projectSelectedResults(context, source.inherited)
  if (selected.kind !== 'selected') throw Error(selected.reason)
  ;(source.selection as any).atSeq = 0
  expect(context.selection).toEqual({ kind: 'completed' })
  expect(() => Map.prototype.clear.call(context.selected.omittedInputs)).toThrow(TypeError)
  expect(() => context.selected.omittedInputs.forEach((_value, _key, map) => map.clear())).toThrow(TypeError)
  const item = context.selected.groups.flatMap(group => group.items).find(item => item.receivedResults.size)!
  expect(() => item.receivedResults.clear()).toThrow(TypeError)
  expect(() => Set.prototype.clear.call(item.receivedResults)).toThrow(TypeError)
  expect(() => item.receivedResults.forEach((_value, _key, set) => set.clear())).toThrow(TypeError)
  expect(() => captureSeedSelectionForResults(context, selected.results)).not.toThrow()
})

it('I1 snapshots only named factory metadata without visiting unrelated held-owner body fields', async () => {
  const source = genuineContext(true), projected = await projectSelectedResults(source.context, source.inherited)
  if (projected.kind !== 'selected') throw Error(projected.reason)
  expect(() => captureSeedSelectionForResults(source.context, projected.results)).not.toThrow()
  expect(source.unrelatedBodyReads()).toBe(0)
})

it('I1 preserves invalid-selection refusal without executing malformed selection accessors during snapshot admission', () => {
  const { context } = genuineContext()
  let reads = 0
  const invalid = Object.defineProperty({ kind: 'completed' }, 'atSeq', { enumerable: true, get() { reads++; throw Error('selection accessor') } })
  expect(createCompletedPassiveContext(context.owner, invalid as any)).toEqual({ kind: 'refused', reason: 'invalid-selection' })
  expect(reads).toBe(0)
})

it('I1 retains the actual index-owned immutable fact metadata rather than cloning the source declaration population', () => {
  const { context } = genuineContext(), indexed = readOwnedSelectionMetadata(context.owner.view)!
  expect(context.source.facts[7]).toBe(indexed.facts[7])
  expect(Object.isFrozen(context.source.facts)).toBe(true)
  expect(() => { (context.source.facts[7] as any).type = 'changed' }).toThrow(TypeError)
})

it('I1 refuses copied passive-body fixture shells before V3 rendering without spending the authentic plan', async () => {
  const source = genuineContext(), context = source.context, projected = await projectSelectedResults(context, source.inherited)
  if (projected.kind !== 'selected') throw Error(projected.reason)
  const shell = { ...context, source: { ...context.source, view: context.source.view }, boundary: { ...context.boundary } }
  const render = vi.spyOn(renderer, 'renderConversationItems')
  try {
    expect(isOriginalCompletedPassiveContext(shell)).toBe(false)
    expect(() => captureSeedSelectionForResults(shell, projected.results)).toThrow(TypeError)
    expect(render).not.toHaveBeenCalled()
    expect(() => captureSeedSelectionForResults(context, projected.results)).not.toThrow()
    expect(render).toHaveBeenCalledTimes(1)
  } finally { vi.restoreAllMocks() }
})

function inheritedContext() {
  const session = literalSession(structuredClone(literalSeed)), managed = createManagedSessionState(session, { sessionId: 'A' }), factOwner = {} as FactOwner
  managed.bindOwner(factOwner)
  const made = createCompletedPassiveContext({ kind: 'held-public-fork', sourceSessionId: 'A', view: managed.view, factOwner, assertCurrent() {} }, { kind: 'completed' })
  if (made.kind !== 'ready') throw Error(made.reason)
  return made.context
}
function legacyObservation(index: number, label: string) {
  return { ref: { id: 'ref-' + index, workspaceId: 'workspace', sessionId: 'historical', callId: 'c', label, revision: 'revision', bytes: 1, originalBytes: 1, complete: true, expiresAt: 9999999999999 },
    original: { kind: 'local' as const, sessionId: 'historical', seq: index, event: 'context/result-ref' as const, slot: 'ref' as const }, extent: { kind: 'framed' as const, first: 1, last: 2 }, anchor: { kind: 'seed-group' as const, manifestSeq: 0 as const, ordinal: 0 } }
}
function expectedRow(index: number, label: string): any {
  const { ref, original, extent } = legacyObservation(index, label), at = { origin: 0, seq: 1, part: 'group' }
  return { protocol: 'legacy', ref, original, extent, basis: { kind: 'selected-observation', unit: { kind: 'exchange', at, closedAt: at } }, branchEvidence: [at] }
}
it('I2 stops before cloning an over-budget draft, closes inherited iteration and never advances to its poisoned continuation', async () => {
  const context = inheritedContext(), label = 'x'.repeat(63_000), limit = 8_388_608
  let accepted = 0, bytes = 0
  while (bytes + Buffer.byteLength(JSON.stringify({ kind: 'included', row: expectedRow(accepted, label) })) <= limit) {
    bytes += Buffer.byteLength(JSON.stringify({ kind: 'included', row: expectedRow(accepted++, label) }))
  }
  const valid = { ...expectedRow(accepted, label), ordinal: accepted }
  validateSelectedResultPage({ version: 1, ordinal: accepted, firstRow: accepted, extent: valid.extent, rows: [valid] }, 2, 1)
  let advances = 0, closed = 0, poisoned = false
  const render = vi.spyOn(renderer, 'renderConversationItems'), clone = vi.spyOn(globalThis, 'structuredClone')
  try {
    const outcome = await projectSelectedResults(context, { assertCurrent() {}, async *legacy() {
      try {
        for (let index = 0; index <= accepted; index++) { advances++; yield legacyObservation(index, label) }
        poisoned = true; throw Error('over-budget continuation must not be reached')
      } finally { closed++ }
    } })
    expect(outcome).toEqual({ kind: 'refused', reason: 'metadata-limit' })
    expect(advances).toBe(accepted + 1); expect(closed).toBe(1); expect(poisoned).toBe(false)
    expect(clone.mock.calls.filter(([value]) => (value as any)?.kind === 'included')).toHaveLength(accepted)
    expect(render).not.toHaveBeenCalled()
    console.log(JSON.stringify({ control: 'I2 bounded draft stop', accepted, advances, closed, poisoned, retainedDiagnosticBytes: bytes,
      nextDiagnosticBytes: Buffer.byteLength(JSON.stringify({ kind: 'included', row: expectedRow(accepted, label) })), budget: limit,
      retainedClassificationClones: clone.mock.calls.filter(([value]) => (value as any)?.kind === 'included').length, payloadRenders: render.mock.calls.length }))
  } finally { vi.restoreAllMocks() }
})

it('I2 accepts an exact final 8MiB page table with individually exact 65536-byte Unicode/escaped records', async () => {
  const context = inheritedContext(), labels = Array.from({ length: 128 }, (_, ordinal) => {
    const prefix = '界"\\', row = { ...expectedRow(ordinal, prefix), ordinal }
    const page = { version: 1, ordinal, firstRow: ordinal, extent: row.extent, rows: [row] }
    const record = { type: 'conversation/seed-results', version: 1, seq: 1 + ordinal, manifestSeq: 0, ordinal, page }
    return prefix + 'x'.repeat(65_536 - Buffer.byteLength(JSON.stringify(record)))
  })
  const projected = await projectSelectedResults(context, { assertCurrent() {}, async *legacy() { for (const [index, label] of labels.entries()) yield legacyObservation(index, label) } })
  expect(projected.kind).toBe('selected'); if (projected.kind !== 'selected') throw Error(projected.reason)
  const pages = await collect(projected.results.pages())
  expect(pages).toHaveLength(128)
  const sizes = pages.map((page, ordinal) => Buffer.byteLength(JSON.stringify({ type: 'conversation/seed-results', version: 1, seq: 1 + ordinal, manifestSeq: 0, ordinal, page })))
  expect(sizes.every(bytes => bytes === 65_536)).toBe(true)
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(8_388_608)
  expect(projected.results.summary).toMatchObject({ rows: 128, pages: 128 })
  console.log(JSON.stringify({ control: 'I2 exact final page bound', recordBytes: sizes[0], tableBytes: sizes.reduce((sum, size) => sum + size, 0), summary: projected.results.summary }))
})

it.each([false, true])('M1 validates V3 completion/optional-initial coordinates and total birth length without allocating records (initial=%s)', initial => {
  const header: any = { ...codecWire(codecSeed()).header.semanticSeed, ...(initial ? { initialInputId: 'input', initialInputDigest: 'c'.repeat(64), initialStartedAt: 1, initialExpiresAt: 2 } : {}) }
  const total = Number.MAX_SAFE_INTEGER
  const validSeedLength = total - 1 - (initial ? 1 : 0)
  expect(() => validateSeedHeader({ ...header, seedLength: validSeedLength, groupCount: validSeedLength - 1 })).not.toThrow()
  expect(() => validateSeedHeader({ ...header, seedLength: validSeedLength + 1, groupCount: validSeedLength })).toThrow()
})
it.each([1, 2])('M1 preserves literal V%s header arithmetic compatibility', version => {
  const { profile: _profile, results: _results, resultPageCount: _pages, ...common } = codecWire(codecSeed()).header.semanticSeed
  expect(() => validateSeedHeader({ ...common, version, codec: `semantic-seed-v${version}`, seedLength: Number.MAX_SAFE_INTEGER, groupCount: Number.MAX_SAFE_INTEGER - 1 } as any)).not.toThrow()
})
