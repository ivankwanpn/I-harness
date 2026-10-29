import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { decodeSavedCalls } from '../src/saved-process-index.ts'
import { buildSavedProcessIndex, createFixedSavedSelection, buildObservedSavedProcessIndex } from '../src/saved-process-index.ts'

const nativeFor = (instanceId = 'a') => ({ version: 1, jobId: 'j', instanceId, ownerSessionId: 'owner', sourceId: 's' })
function snapshotFields(value: any) {
  if (typeof value.text !== 'string' || !value.native_job) return value
  const ref = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'd'.repeat(64), codec: 'exec-frames-v1', encodedBytes: 12, contentDigest: 'e'.repeat(64), completeness: 'complete' }
  return { source: { kind: 'retained-summary' }, scope: 'captured', completeness: 'complete', total_bytes: 11, stderr_total_bytes: 0, total_raw_bytes: 11,
    digest: createHash('sha256').update('prefixlater').digest('hex'), stderr_digest: createHash('sha256').update('').digest('hex'), digest_format: 'sha256-raw-v1',
    offset_bytes: 0, next_offset_bytes: (value.offset_bytes ?? 0) + Buffer.byteLength(value.text), truncated: (value.offset_bytes ?? 0) + Buffer.byteLength(value.text) < 11,
    full_result: { tool: 'context_output_read', args: { ref, maxBytes: 32768 }, access: 'catalog-required', catalog_from: 'envelope.dependencies.ref' }, ...value }
}
const savedEnvelope = (value: object) => ({ execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: snapshotFields(value) } })
const originalPair = (callId: string, name: string, args: object, value: object, seq: number) => [
  { type: 'tool/call', callId, name, args, seq },
  { type: 'tool/dispatch', callId, eventSeq: seq, seq: seq + 1 },
  { type: 'tool/result', callId, name, envelope: savedEnvelope(value), seq: seq + 2 },
]
const startingFacts = () => originalPair('start', 'shell', {}, { job_id: 'j', native_job: nativeFor() }, 1)
const selectedInitial = (events: any[]) => ({ session: { formatVersion: 13, events }, highWater: events.length }) as never

it('detects immutable summary conflicts in initial nonzero observations', () => {
  const events = [...startingFacts(), ...originalPair('prefix', 'job_output', { job_id: 'j' }, { job_id: 'j', native_job: nativeFor(), text: 'prefix', offset_bytes: 0, digest: 'a'.repeat(64) }, 4),
    ...originalPair('tail', 'job_output', { job_id: 'j', offset_bytes: 6 }, { job_id: 'j', native_job: nativeFor(), text: 'tail', offset_bytes: 6, digest: 'b'.repeat(64) }, 7)]
  expect(buildSavedProcessIndex(events, 'owner').select('j', 'a').kind).toBe('conflict')
})
it('does not publish an initially ambiguous completed invocation followed by an overlapping pending call', () => {
  const events = [...startingFacts(), { type: 'tool/call', callId: 'start', name: 'shell', args: {}, seq: 4 }, { type: 'tool/call', callId: 'start', name: 'shell', args: {}, seq: 5 }]
  expect(() => createFixedSavedSelection(selectedInitial(events), 'owner', 'j')).toThrow()
})
it('explicit instance remains fixed across a different instance with the same id but id-only selection refuses', () => {
  const initial = selectedInitial(startingFacts()), fixed = createFixedSavedSelection(initial, 'owner', 'j', 'a'), loose = createFixedSavedSelection(initial, 'owner', 'j')
  const suffix = originalPair('other', 'shell', {}, { job_id: 'j', native_job: nativeFor('b') }, 4)
  fixed.append(3, suffix); loose.append(3, suffix)
  expect(fixed.current().nativeJob?.instanceId).toBe('a')
  expect(() => loose.current()).toThrow(/conflict/)
})
it('explicit native instance does not acquire or conflict with a new same-id legacy declaration', () => {
  const fixed = createFixedSavedSelection(selectedInitial(startingFacts()), 'owner', 'j', 'a')
  fixed.append(3, [{ type: 'tool/call', callId: 'legacy', name: 'shell', args: {}, seq: 4 }, { type: 'tool/result', callId: 'legacy', name: 'shell', output: { job_id: 'j' }, seq: 5 }])
  expect(fixed.current().nativeJob?.instanceId).toBe('a')
})
it('initial same-id legacy declaration preserves fully matched native snapshot and immutable evidence', () => {
  const legacy = [{ type: 'tool/call', callId: 'legacy', name: 'shell', args: {}, seq: 4 }, { type: 'tool/result', callId: 'legacy', name: 'shell', output: { job_id: 'j' }, seq: 5 }]
  const prefix = originalPair('prefix', 'job_output', { job_id: 'j', job_instance_id: 'a' }, { job_id: 'j', native_job: nativeFor(), text: 'prefix' }, 6)
  const events = [...startingFacts(), ...legacy, ...prefix]
  const index = buildSavedProcessIndex(events, 'owner')
  expect(index.select('j').kind).toBe('ambiguous-selector')
  expect(index.select('j', 'a')).toMatchObject({ kind: 'selected', candidate: { snapshot: { text: 'prefix' }, observation: { callId: 'prefix' }, sourceObservation: { callId: 'prefix' } } })
  const conflicting = originalPair('tail', 'job_output', { job_id: 'j', job_instance_id: 'a', offset_bytes: 6 }, { job_id: 'j', native_job: nativeFor(), text: 'later', offset_bytes: 6, digest: 'b'.repeat(64) }, 9)
  expect(buildSavedProcessIndex([...events, ...conflicting], 'owner').select('j', 'a').kind).toBe('conflict')
  const fixed = createFixedSavedSelection(selectedInitial(events), 'owner', 'j', 'a')
  fixed.append(events.length, conflicting)
  expect(() => fixed.current()).toThrow(/conflict/)
})
it.each(['jobId', 'sourceId'] as const)('same original native instance with changed %s conflicts in initial and suffix paths', field => {
  const native = { ...nativeFor(), [field]: 'other' }
  const changed = originalPair('redeclaration', 'shell', {}, { job_id: native.jobId, native_job: native }, 4)
  expect(buildSavedProcessIndex([...startingFacts(), ...changed], 'owner').select('j', 'a').kind).toBe('conflict')
  for (const selector of [undefined, 'a']) {
    const fixed = createFixedSavedSelection(selectedInitial(startingFacts()), 'owner', 'j', selector)
    fixed.append(3, changed)
    expect(() => fixed.current()).toThrow(/conflict/)
  }
})
it('unrelated foreign native identity stays unrelated while explicit selection preserves its original evidence', () => {
  const other = originalPair('other', 'shell', {}, { job_id: 'other', native_job: { ...nativeFor('c'), jobId: 'other', sourceId: 'different' } }, 4)
  const nativeB = originalPair('same-id', 'shell', {}, { job_id: 'j', native_job: nativeFor('b') }, 7)
  const index = buildSavedProcessIndex([...startingFacts(), ...other, ...nativeB], 'owner')
  expect(index.select('j').kind).toBe('ambiguous-selector'); expect(index.select('j', 'a').kind).toBe('selected')
  const fixed = createFixedSavedSelection(selectedInitial(startingFacts()), 'owner', 'j', 'a')
  fixed.append(3, other); fixed.append(6, nativeB)
  expect(fixed.current().nativeJob).toEqual(nativeFor())
})
it('unsupported foreign-owner declaration never becomes an owned competitor in initial or suffix indexing', () => {
  const foreign = originalPair('foreign', 'shell', {}, { job_id: 'j', native_job: { ...nativeFor('foreign'), ownerSessionId: 'elsewhere' } }, 4)
  expect(buildSavedProcessIndex([...startingFacts(), ...foreign], 'owner').select('j').kind).toBe('selected')
  const fixed = createFixedSavedSelection(selectedInitial(startingFacts()), 'owner', 'j')
  fixed.append(3, foreign); expect(fixed.current().nativeJob).toEqual(nativeFor())
})
it('unrelated orphan results cannot invalidate an original fixed selection', () => {
  const fixed = createFixedSavedSelection(selectedInitial(startingFacts()), 'owner', 'j', 'a')
  fixed.append(3, [{ type: 'tool/result', callId: 'foreign', name: 'other', output: 'text', seq: 4 }])
  expect(fixed.current().id).toBe('j')
})
it('nonmonotonic disjoint rewind markers do not hide an intervening visible declaration', () => {
  const events = [...originalPair('start', 'shell', {}, { job_id: 'j', native_job: nativeFor() }, 50), { type: 'rewind/point', anchorSeq: 100, seq: 200 }, { type: 'rewind/point', anchorSeq: 10, seq: 20 }]
  expect(buildSavedProcessIndex(events, 'owner').select('j').kind).toBe('selected')
})
it('rejects malformed semantic seed metadata even when falsy', () => {
  expect(() => buildObservedSavedProcessIndex({ session: { formatVersion: 13, header: { semanticSeed: false }, events: [] }, highWater: 0 } as never, 'owner')).toThrow(/Inherited/)
})

it('pending shell calls remain selection-unknown until an original suffix result resolves them', () => {
  const events = [...startingFacts(), { type: 'tool/call', callId: 'pending', name: 'shell', args: {}, seq: 4 }]
  const fixed = createFixedSavedSelection(selectedInitial(events), 'owner', 'j', 'a')
  expect(() => fixed.current()).toThrow(/unknown/)
  fixed.append(4, [{ type: 'tool/dispatch', callId: 'pending', eventSeq: 4, seq: 5 }])
  expect(() => fixed.current()).toThrow(/unknown/)
  fixed.append(5, [{ type: 'tool/result', callId: 'pending', name: 'shell', envelope: savedEnvelope({ job_id: 'other', native_job: { ...nativeFor('b'), jobId: 'other' } }), seq: 6 }])
  expect(fixed.current().id).toBe('j')
})
it('Code Mode keeps actual cell parent across suffix dispatch/result and matching terminal state', () => {
  const prefix = [...startingFacts(), { type: 'code/cell', cellId: 'cell', sessionId: 'owner', parentCallId: 'outer', state: 'started', seq: 4 },
    { type: 'code/call', cellId: 'cell', parentCallId: 'outer', callId: 'nested', name: 'job_output', args: { job_id: 'j', job_instance_id: 'a' }, seq: 5 }]
  const fixed = createFixedSavedSelection(selectedInitial(prefix), 'owner', 'j', 'a')
  fixed.append(5, [{ type: 'code/dispatch', cellId: 'cell', callId: 'nested', eventSeq: 5, seq: 6 }])
  fixed.append(6, [{ type: 'code/result', cellId: 'cell', callId: 'nested', name: 'job_output', envelope: savedEnvelope({ job_id: 'j', native_job: nativeFor(), text: 'prefix' }), seq: 7 },
    { type: 'code/cell', cellId: 'cell', sessionId: 'owner', parentCallId: 'outer', state: 'completed', seq: 8 }])
  expect(fixed.current().id).toBe('j')
  const complete = [...prefix.slice(3), { type: 'code/dispatch', cellId: 'cell', callId: 'nested', eventSeq: 5, seq: 6 },
    { type: 'code/result', cellId: 'cell', callId: 'nested', name: 'job_output', envelope: savedEnvelope({ job_id: 'j', native_job: nativeFor(), text: 'prefix' }), seq: 7 }]
  expect(decodeSavedCalls(complete, 'owner')[0]).toMatchObject({ surface: 'code', cellId: 'cell', parentCallId: 'outer', callSeq: 5, dispatchSeq: 6 })
  const foreign = structuredClone(complete); (foreign[0] as any).parentCallId = 'foreign'
  expect(decodeSavedCalls(foreign, 'owner')).toEqual([])
})
it('selected code declaration rejects a later conflicting parent and rewind of its cell proof', () => {
  const events = [{ type: 'code/cell', cellId: 'c', sessionId: 'owner', parentCallId: 'outer', state: 'started', seq: 1 },
    { type: 'code/call', cellId: 'c', parentCallId: 'outer', callId: 'a', name: 'shell', args: {}, seq: 2 },
    { type: 'code/dispatch', cellId: 'c', callId: 'a', eventSeq: 2, seq: 3 },
    { type: 'code/result', cellId: 'c', callId: 'a', name: 'shell', envelope: savedEnvelope({ job_id: 'j', native_job: nativeFor() }), seq: 4 }]
  const fixed = createFixedSavedSelection(selectedInitial(events), 'owner', 'j', 'a')
  fixed.append(4, [{ type: 'code/cell', cellId: 'c', sessionId: 'owner', parentCallId: 'foreign', state: 'completed', seq: 5 }])
  expect(() => fixed.current()).toThrow(/conflict/)
  const rewound = createFixedSavedSelection(selectedInitial(events), 'owner', 'j', 'a')
  rewound.append(4, [{ type: 'rewind/point', anchorSeq: 1, seq: 2 }])
  expect(() => rewound.current()).toThrow(/conflict/)
})
it('does not rescan the original event array on page checkpoints and never adopts a newer prefix', () => {
  let locked = false
  const events = new Proxy([...startingFacts(), ...originalPair('p', 'job_output', { job_id: 'j' }, { job_id: 'j', native_job: nativeFor(), text: 'prefix' }, 4)], { get(target, key, receiver) { if (locked) throw new Error('prefix rescanned'); return Reflect.get(target, key, receiver) } })
  const fixed = createFixedSavedSelection(selectedInitial(events), 'owner', 'j', 'a')
  locked = true
  fixed.append(6, originalPair('next', 'job_output', { job_id: 'j' }, { job_id: 'j', native_job: nativeFor(), text: 'prefixlater' }, 7))
  const selected = fixed.current(); expect(selected.snapshot?.text).toBe('prefix'); expect(selected.observation?.callId).toBe('p'); expect(selected.declaration.callId).toBe('start')
  selected.snapshot!.text = 'changed'; expect(fixed.current().snapshot?.text).toBe('prefix')
})
it('rejects duplicate selected result and hides unsupported modern snapshots instead of promoting previews', () => {
  const fixed = createFixedSavedSelection(selectedInitial(startingFacts()), 'owner', 'j', 'a')
  fixed.append(3, [{ type: 'tool/result', callId: 'start', name: 'shell', envelope: savedEnvelope({ job_id: 'j', native_job: nativeFor() }), seq: 4 }])
  expect(() => fixed.current()).toThrow(/conflict/)
  const events = [...startingFacts(), ...originalPair('bad', 'job_output', { job_id: 'j' }, { job_id: 'j', native_job: nativeFor(), text: 'prefix', next_offset_bytes: 999 }, 4)]
  expect(buildSavedProcessIndex(events, 'owner').candidates[0]?.snapshot).toBeUndefined()
})
it('suffix rewind ranges apply to later nonmonotonic facts without rescanning or hiding unrelated originals', () => {
  const fixed = createFixedSavedSelection(selectedInitial(startingFacts()), 'owner', 'j')
  fixed.append(3, [{ type: 'rewind/point', anchorSeq: 10, seq: 20 }])
  fixed.append(4, originalPair('hidden', 'shell', {}, { job_id: 'j', native_job: nativeFor('b') }, 12))
  expect(fixed.current().nativeJob?.instanceId).toBe('a')
})
it('same-instance initial raw ref conflicts survive a later eligible prefix', () => {
  const ref = (c: string) => ({ version: 1, id: 'ctxv1_' + c.repeat(64), revision: 'd'.repeat(64), codec: 'exec-frames-v1', encodedBytes: 12, contentDigest: 'e'.repeat(64), completeness: 'complete' })
  const events = [...startingFacts(), ...originalPair('tail', 'job_output', { job_id: 'j', offset_bytes: 6 }, { job_id: 'j', native_job: nativeFor(), text: 'later', offset_bytes: 6, full_result: { args: { ref: ref('a') } } }, 4),
    ...originalPair('prefix', 'job_output', { job_id: 'j' }, { job_id: 'j', native_job: nativeFor(), text: 'prefix', full_result: { args: { ref: ref('b') } } }, 7)]
  expect(buildSavedProcessIndex(events, 'owner').select('j', 'a').kind).toBe('conflict')
})
it('keeps an authentic nonzero source observation separate from the zero-origin compatibility snapshot', () => {
  const events = [...startingFacts(), ...originalPair('prefix', 'job_output', { job_id: 'j' }, { job_id: 'j', native_job: nativeFor(), text: 'prefix' }, 4),
    ...originalPair('tail', 'job_output', { job_id: 'j', job_instance_id: 'a', offset_bytes: 6 }, { job_id: 'j', native_job: nativeFor(), text: 'later', offset_bytes: 6 }, 7)]
  const c = buildSavedProcessIndex(events, 'owner').candidates[0]!
  expect(c.snapshot?.text).toBe('prefix'); expect(c.snapshot?.truncated).toBe(true)
  expect(c.observation?.callId).toBe('prefix'); expect(c.sourceObservation?.callId).toBe('tail')
  const onlyTail = buildSavedProcessIndex([...startingFacts(), ...events.slice(6)], 'owner').candidates[0]!
  expect(onlyTail.snapshot).toBeUndefined(); expect(onlyTail.sourceObservation?.callId).toBe('tail')
})

it('pairs only unique matching original calls and never promotes preview or duplicate calls', () => {
  const events = [
    { type: 'tool/call', callId: 'a', name: 'shell', args: {}, seq: 1 },
    { type: 'tool/result', callId: 'a', name: 'shell', seq: 2, envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: { job_id: 'one' } }, preview: 'forged' } },
    { type: 'tool/call', callId: 'b', name: 'shell', args: {}, seq: 3 },
    { type: 'tool/call', callId: 'b', name: 'shell', args: {}, seq: 4 },
    { type: 'tool/result', callId: 'b', name: 'shell', output: { job_id: 'two' }, seq: 5 },
    { type: 'tool/call', callId: 'c', name: 'shell', args: {}, seq: 6 },
    { type: 'tool/result', callId: 'c', name: 'shell', seq: 7, envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'artifact' }, preview: '{"job_id":"fake"}' } },
  ]
  expect(decodeSavedCalls(events, 'owner')).toMatchObject([{ callIndex: 0, resultIndex: 1, value: { job_id: 'one' }, provenance: 'inline' }])
})

it('rejects foreign cells, mismatched dispatches, hidden facts and failed envelopes', () => {
  const envelope = { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: { job_id: 'x' } } }
  const events = [
    { type: 'code/cell', cellId: 'c', sessionId: 'foreign', state: 'started', seq: 1 },
    { type: 'code/call', cellId: 'c', callId: 'a', name: 'shell', args: {}, seq: 2 },
    { type: 'code/result', cellId: 'c', callId: 'a', name: 'shell', envelope, seq: 3 },
    { type: 'tool/call', callId: 'b', name: 'shell', args: {}, seq: 4 },
    { type: 'tool/dispatch', callId: 'b', eventSeq: 9, seq: 5 },
    { type: 'tool/result', callId: 'b', name: 'shell', envelope, seq: 6 },
    { type: 'tool/call', callId: 'c', name: 'shell', args: {}, seq: 7 },
    { type: 'tool/result', callId: 'c', name: 'shell', envelope, seq: 8 },
    { type: 'rewind/point', anchorSeq: 7, seq: 9 },
    { type: 'tool/call', callId: 'd', name: 'shell', args: {}, seq: 10 },
    { type: 'tool/result', callId: 'd', name: 'shell', envelope: { ...envelope, execution: { outcome: 'failed', dispatch: 'dispatched' } }, seq: 11 },
  ]
  expect(decodeSavedCalls(events, 'owner')).toEqual([])
})

it('keeps reused native ids ambiguous and selects only zero-origin output for each instance', async () => {
  const { buildSavedProcessIndex } = await import('../src/saved-process-index.ts')
  const identity = (instanceId: string) => ({ version: 1, jobId: 'bash-1', instanceId, ownerSessionId: 'owner', sourceId: 'process:1' })
  const fact = (callId: string, name: string, args: object, value: object) => [
    { type: 'tool/call', callId, name, args }, { type: 'tool/result', callId, name, envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: snapshotFields(value) } } },
  ]
  const events = [
    ...fact('a', 'shell', {}, { job_id: 'bash-1', native_job: identity('a') }),
    ...fact('b', 'shell', {}, { job_id: 'bash-1', native_job: identity('b') }),
    ...fact('c', 'job_output', { job_id: 'bash-1', job_instance_id: 'a' }, { job_id: 'bash-1', native_job: identity('a'), text: 'prefix', offset_bytes: 0 }),
    ...fact('d', 'job_output', { job_id: 'bash-1', job_instance_id: 'a', offset_bytes: 3 }, { job_id: 'bash-1', native_job: identity('a'), text: 'suffix', offset_bytes: 3 }),
  ]
  const index = buildSavedProcessIndex(events, 'owner')
  expect(index.select('bash-1')).toEqual({ kind: 'ambiguous-selector' })
  expect(index.select('bash-1', 'a')).toMatchObject({ kind: 'selected', candidate: { snapshot: { text: 'prefix' } } })
})

it('binds an artifact descriptor only through an original selected invocation', async () => {
  const { buildSavedProcessIndex } = await import('../src/saved-process-index.ts')
  const ref = (c: string) => ({ version: 1, id: `ctxv1_${c.repeat(64)}`, revision: 'd'.repeat(64), codec: 'json-utf8-v1', encodedBytes: 12, contentDigest: 'e'.repeat(64), completeness: 'complete' })
  const native = { version: 1, jobId: 'bash-1', instanceId: 'instance', ownerSessionId: 'owner', sourceId: 'source' }
  const inline = { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: { job_id: 'bash-1', native_job: native } } }
  const artifact = { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'artifact', ref: ref('a') }, dependencies: { kind: 'artifact-set', count: 1, ref: ref('b') }, preview: 'forged' }
  const events = [{ type: 'tool/call', callId: 'a', name: 'shell', args: {} }, { type: 'tool/result', callId: 'a', name: 'shell', envelope: inline },
    { type: 'tool/call', callId: 'b', name: 'job_output', args: { job_id: 'bash-1', job_instance_id: 'instance', source_id: 'source' } },
    { type: 'tool/result', callId: 'b', name: 'job_output', envelope: artifact }]
  const selected = buildSavedProcessIndex(events, 'owner').select('bash-1', 'instance')
  expect(selected).toMatchObject({ kind: 'selected', candidate: { descriptor: { dto: ref('a'), catalog: ref('b') } } })
  artifact.retention.ref.id = ref('c').id
  expect(selected).toMatchObject({ candidate: { descriptor: { dto: ref('a') } } })
})

it('pairs sequential reused call ids when dispatches identify each original call', () => {
  const events = [
    { type: 'tool/call', callId: 'a', name: 'shell', args: {}, seq: 1 },
    { type: 'tool/dispatch', callId: 'a', eventSeq: 1, seq: 2 },
    { type: 'tool/result', callId: 'a', name: 'shell', output: { job_id: 'first' }, seq: 3 },
    { type: 'tool/call', callId: 'a', name: 'shell', args: {}, seq: 4 },
    { type: 'tool/dispatch', callId: 'a', eventSeq: 4, seq: 5 },
    { type: 'tool/result', callId: 'a', name: 'shell', output: { job_id: 'second' }, seq: 6 },
  ]
  expect(decodeSavedCalls(events, 'owner').map(c => c.value)).toEqual([{ job_id: 'first' }, { job_id: 'second' }])
})

it('rejects copied inherited prefixes while admitting a child with no copied events', async () => {
  const { buildObservedSavedProcessIndex } = await import('../src/saved-process-index.ts')
  const initial = { session: { formatVersion: 13, events: [], header: { parentSession: 'parent', seedLength: 1 } }, highWater: 0, documents: new Map() }
  expect(() => buildObservedSavedProcessIndex(initial as never, 'owner')).toThrow(/inherited/i)
  initial.session.header.seedLength = 0
  expect(buildObservedSavedProcessIndex(initial as never, 'owner').candidates).toEqual([])
})

it('keeps a fixed selected snapshot across suffixes and rejects later competing declaration or rewind', async () => {
  const { createFixedSavedSelection } = await import('../src/saved-process-index.ts')
  const native = { version: 1, jobId: 'j', instanceId: 'a', ownerSessionId: 'owner', sourceId: 's' }
  const env = savedEnvelope
  const events = [
    { type: 'tool/call', callId: 'a', name: 'shell', args: {}, seq: 1 },
    { type: 'tool/result', callId: 'a', name: 'shell', envelope: env({ job_id: 'j', native_job: native }), seq: 2 },
    { type: 'tool/call', callId: 'b', name: 'job_output', args: { job_id: 'j' }, seq: 3 },
    { type: 'tool/result', callId: 'b', name: 'job_output', envelope: env({ job_id: 'j', native_job: native, text: 'prefix' }), seq: 4 },
  ]
  const initial = { session: { formatVersion: 13, events }, highWater: 4 }
  const fixed = createFixedSavedSelection(initial as never, 'owner', 'j')
  fixed.append(4, [{ type: 'tool/call', callId: 'c', name: 'job_output', args: { job_id: 'j', job_instance_id: 'a', offset_bytes: 6 }, seq: 5 }])
  fixed.append(5, [{ type: 'tool/dispatch', callId: 'c', eventSeq: 5, seq: 6 }, { type: 'tool/result', callId: 'c', name: 'job_output', envelope: env({ job_id: 'j', native_job: native, text: 'later', offset_bytes: 6 }), seq: 7 }])
  expect(fixed.current().snapshot?.text).toBe('prefix')
  fixed.append(7, [{ type: 'tool/call', callId: 'd', name: 'shell', args: {}, seq: 8 }])
  fixed.append(8, [{ type: 'tool/dispatch', callId: 'd', eventSeq: 8, seq: 9 }, { type: 'tool/result', callId: 'd', name: 'shell', envelope: env({ job_id: 'j', native_job: { ...native, instanceId: 'b' } }), seq: 10 }])
  expect(() => fixed.current()).toThrow(/conflict/)
  const rewind = createFixedSavedSelection(initial as never, 'owner', 'j', 'a')
  rewind.append(4, [{ type: 'rewind/point', anchorSeq: 3, seq: 5 }])
  expect(() => rewind.current()).toThrow(/conflict/)
})

it('seeds pending calls from the original prefix and permits later sequential call-id reuse', async () => {
  const { createFixedSavedSelection } = await import('../src/saved-process-index.ts')
  const native = { version: 1, jobId: 'j', instanceId: 'a', ownerSessionId: 'owner', sourceId: 's' }
  const env = savedEnvelope
  const events = [{ type: 'tool/call', callId: 'a', name: 'shell', args: {}, seq: 1 }, { type: 'tool/result', callId: 'a', name: 'shell', envelope: env({ job_id: 'j', native_job: native }), seq: 2 }, { type: 'tool/call', callId: 'pending', name: 'job_output', args: { job_id: 'other' }, seq: 3 }]
  const fixed = createFixedSavedSelection({ session: { formatVersion: 13, events }, highWater: 3 } as never, 'owner', 'j', 'a')
  fixed.append(3, [{ type: 'tool/dispatch', callId: 'pending', eventSeq: 3, seq: 4 }, { type: 'tool/result', callId: 'pending', name: 'job_output', envelope: env({ job_id: 'other' }), seq: 5 }])
  fixed.append(5, [{ type: 'tool/call', callId: 'a', name: 'job_output', args: { job_id: 'other' }, seq: 6 }, { type: 'tool/dispatch', callId: 'a', eventSeq: 6, seq: 7 }, { type: 'tool/result', callId: 'a', name: 'job_output', envelope: env({ job_id: 'other' }), seq: 8 }])
  expect(fixed.current().id).toBe('j')
})

it('rejects a later selected-instance observation with a conflicting immutable frame ref', async () => {
  const { createFixedSavedSelection } = await import('../src/saved-process-index.ts')
  const native = { version: 1, jobId: 'j', instanceId: 'a', ownerSessionId: 'owner', sourceId: 's' }
  const ref = (c: string) => ({ version: 1, id: `ctxv1_${c.repeat(64)}`, revision: 'd'.repeat(64), codec: 'exec-frames-v1', encodedBytes: 12, contentDigest: 'e'.repeat(64), completeness: 'complete' })
  const env = savedEnvelope
  const output = (r: object) => ({ job_id: 'j', native_job: native, text: 'x', full_result: { args: { ref: r } } })
  const events = [{ type: 'tool/call', callId: 'a', name: 'shell', args: {}, seq: 1 }, { type: 'tool/result', callId: 'a', name: 'shell', envelope: env({ job_id: 'j', native_job: native }), seq: 2 }, { type: 'tool/call', callId: 'b', name: 'job_output', args: { job_id: 'j' }, seq: 3 }, { type: 'tool/result', callId: 'b', name: 'job_output', envelope: env(output(ref('a'))), seq: 4 }]
  const fixed = createFixedSavedSelection({ session: { formatVersion: 13, events }, highWater: 4 } as never, 'owner', 'j', 'a')
  fixed.append(4, [{ type: 'tool/call', callId: 'c', name: 'job_output', args: { job_id: 'j', job_instance_id: 'a' }, seq: 5 }, { type: 'tool/result', callId: 'c', name: 'job_output', envelope: env(output(ref('b'))), seq: 6 }])
  expect(() => fixed.current()).toThrow(/conflict/)
})
