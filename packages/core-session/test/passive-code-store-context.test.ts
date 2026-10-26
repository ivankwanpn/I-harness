import { expect, it } from 'vitest'
import { append, createSession, exportConversationSeed, type Session } from '../src/index.ts'
import type { FactOwner } from '../src/managed/ports.ts'
import { createManagedSessionState } from '../src/managed/view.ts'
import { createCompletedPassiveContext, type CompletedPassiveContext, type HeldSeedOwner } from '../src/conversation/passive-seed-context.ts'
import { projectPassiveCodeStore } from '../src/projection/passive-code-store/project.ts'
import { capturePassiveCodeStore, replayPassiveCodeStore } from '../src/projection/passive-code-store.ts'
import { originalRewindWindows, rewindCuts } from '../src/projection/rewind.ts'
import { literalReady } from './fixtures/format11-seed.ts'
import { literalSession } from './fixtures/semantic-observation.ts'
import { buildSelectionSource } from '../src/conversation/seed-selection.ts'

// These verify the core ownership predicate. Real acquisition is qualified by
// the persistence/full-host stages; this fixture does not issue a public host.
function held(session: Session): HeldSeedOwner {
  const managed = createManagedSessionState(session), factOwner = {} as FactOwner
  managed.bindOwner(factOwner)
  return { kind: 'held-public-fork', sourceSessionId: 'o', view: managed.view, factOwner, assertCurrent() {} }
}
function framed() {
  const source = createSession()
  append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'one' })
  append(source, { type: 'turn/end' })
  return source
}
function context(source: Session, atSeq?: number) {
  const result = createCompletedPassiveContext(held(source), { kind: 'completed', ...(atSeq === undefined ? {} : { atSeq }) })
  expect(result.kind).toBe('ready')
  if (result.kind !== 'ready') throw Error(result.reason)
  return result.context
}
function projected(context: CompletedPassiveContext) {
  const captured = capturePassiveCodeStore(projectPassiveCodeStore(context))
  return captured ? replayPassiveCodeStore(captured, captured.latest) : { kind: 'value', entries: [] }
}
function store(source: Session, value: unknown, cellId = 'c', sessionId = 'o') {
  // Literal source construction allows malformed deferred bodies, unlike
  // durable intake. Positional seq is still explicit in this pure fixture.
  source.events.push({ type: 'code/store', version: 1, cellId, sessionId, writes: [['x', value]], seq: source.events.length } as Session['events'][number])
  source.events.push({ type: 'code/cell', cellId, sessionId, state: 'completed', seq: source.events.length })
}
it('selects trailing committed stores before the next start and excludes both later puts and terminals', () => {
  const source = framed(); store(source, 7)
  append(source, { type: 'turn/start' }); store(source, 8, 'next')
  const selected = context(source, 1)
  expect(selected.boundary).toMatchObject({ kind: 'local-completed', lastTurn: 1, end: { index: 2, seq: 2 }, upper: { kind: 'before-event', at: { index: 5, seq: 5 } } })
  expect(projected(selected)).toEqual({ kind: 'value', entries: [['x', 7]] })
})
it('refuses in-range unfinished requests but keeps beyond-archive latest selection', () => {
  const source = framed(); append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'open' })
  expect(createCompletedPassiveContext(held(source), { kind: 'completed', atSeq: 4 })).toEqual({ kind: 'refused', reason: 'no-completed-boundary' })
  expect(exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'completed', atSeq: 4 })).toEqual({ kind: 'refused', reason: 'no-completed-boundary' })
  expect(context(source, 999).last).toBe(1)
})
it('distinguishes explicit inherited group from inherited default unframed local tail', () => {
  const exported = exportConversationSeed(framed(), { kind: 'anonymous' }, { kind: 'all' })
  if (exported.kind !== 'seed') throw Error('V1 fixture required')
  const source = literalSession(exported.seed); store(source, 7)
  const group = source.events.findIndex(event => event.type === 'conversation/seed-group')
  expect(context(source, group).boundary).toMatchObject({ kind: 'explicit-inherited-group', ordinal: 0, upper: { kind: 'before-event', at: { index: source.header!.seedLength } } })
  expect(projected(context(source, group))).toEqual({ kind: 'value', entries: [] })
  expect(context(source).boundary.kind).toBe('inherited-default')
  expect(projected(context(source))).toEqual({ kind: 'value', entries: [['x', 7]] })
  expect(createCompletedPassiveContext(held(source), { kind: 'completed', atSeq: 0 })).toEqual({ kind: 'refused', reason: 'ambiguous-boundary' })
  expect(createCompletedPassiveContext(held(structuredClone(literalReady)), { kind: 'completed', atSeq: 1 })).toEqual({ kind: 'refused', reason: 'ambiguous-boundary' })
})
it('requires a completed boundary while allowing completed code-only framing with zero groups', () => {
  const unframed = createSession(); store(unframed, 7)
  expect(createCompletedPassiveContext(held(unframed), { kind: 'completed' })).toEqual({ kind: 'refused', reason: 'no-completed-boundary' })
  const source = createSession(); append(source, { type: 'turn/start' }); store(source, 7); append(source, { type: 'turn/end' })
  expect(context(source).groups).toEqual([])
  expect(projected(context(source))).toEqual({ kind: 'value', entries: [['x', 7]] })
})
it('refuses mismatched owner, stale witness and nonpositional admission without repairing source', () => {
  const owner = held(framed())
  expect(createCompletedPassiveContext({ ...owner, factOwner: {} as FactOwner }, { kind: 'completed' })).toEqual({ kind: 'refused', reason: 'source-unsupported' })
  expect(createCompletedPassiveContext({ ...owner, assertCurrent() { throw Error('stale') } }, { kind: 'completed' })).toEqual({ kind: 'refused', reason: 'source-changed' })
  const bad = framed(); Object.assign(bad.events[1]!, { seq: 10 })
  expect(createCompletedPassiveContext(held(bad), { kind: 'completed' })).toEqual({ kind: 'refused', reason: 'source-unsupported' })
  expect(bad.events[1]!.seq).toBe(10)
})
it.each(['cycle', 'NaN', 'getter'])('keeps superseded %s bodies opaque and rejects selected bodies without execution', kind => {
  const cycle: unknown[] = []; cycle.push(cycle)
  let reads = 0
  const getter = Object.defineProperty({}, 'nested', { enumerable: true, get() { reads++; return 1 } })
  const body = kind === 'cycle' ? cycle : kind === 'NaN' ? NaN : getter
  const source = framed(); store(source, body); store(source, 7, 'later')
  expect(() => buildSelectionSource(source)).not.toThrow()
  // Raw context for deferred bodies: actual managed intake intentionally rejects
  // non-JSON graphs, so use the same structural SelectionSource after ownership.
  const clean = framed(); store(clean, 0); store(clean, 7, 'later')
  const selected = context(clean)
  selected.source = { ...selected.source, view: source }
  expect(projected(selected)).toEqual({ kind: 'value', entries: [['x', 7]] })
  source.events.splice(-2)
  selected.source = { ...selected.source, view: source }
  selected.boundary = { ...selected.boundary, upper: { kind: 'archive-end', eventCount: source.events.length } }
  expect(() => projected(selected)).toThrow(); expect(reads).toBe(0)
})
it('rejects eligible malformed slots and overwritten entry shapes while ignoring foreign and ineligible payloads', () => {
  const source = framed(); store(source, 1); store(source, 7, 'later')
  const selected = context(source)
  const first = source.events[3] as any
  let reads = 0
  Object.defineProperty(first.writes[0], '1', { enumerable: true, get() { reads++; return 1 } })
  selected.source = { ...selected.source, view: source }
  expect(() => projected(selected)).toThrow(); expect(reads).toBe(0)
  first.writes = [[123, 1]]
  expect(() => projected(selected)).toThrow()
  first.version = 999; first.writes = [['x', 1]]
  expect(() => projected(selected)).toThrow()
  first.sessionId = 'foreign'
  expect(projected(selected)).toEqual({ kind: 'value', entries: [['x', 7]] })
  first.sessionId = 'o'; source.events[4] = { ...source.events[4], state: 'failed' } as Session['events'][number]
  expect(projected(selected)).toEqual({ kind: 'value', entries: [['x', 7]] })
})
it('preserves original rewind windows before melding and retains post-marker branch commits', () => {
  const source = framed(); store(source, 7)
  append(source, { type: 'rewind/point', version: 1, targetTurn: 1, anchorSeq: 3, mode: 'conversation', fileOps: [] })
  store(source, 8, 'branch')
  append(source, { type: 'rewind/point', version: 1, targetTurn: 1, anchorSeq: 1, mode: 'conversation', fileOps: [] })
  store(source, 9, 'new')
  expect(originalRewindWindows(source)).toEqual([
    { cutFrom: 3, markerSeq: 5, markerIndex: 5, startRank: 3, endRank: 5 },
    { cutFrom: 1, markerSeq: 8, markerIndex: 8, startRank: 1, endRank: 8 },
  ])
  expect(rewindCuts(source)).toEqual([{ cutFrom: 1, markerSeq: 8 }])
  expect(projected(context(source))).toEqual({ kind: 'value', entries: [['x', 9]] })
})
