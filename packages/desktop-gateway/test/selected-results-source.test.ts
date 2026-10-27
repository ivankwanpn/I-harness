import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { committedFactSeqs, type ManagedArtifactRef, type ResultEnvelope, type SelectedResultRow } from '@i-harness/core-session'
import { createSessionCoordinator, type ManagedDocument } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createForkSourceWitness } from '../../session-persistence/src/fork-inline-host.ts'
import { createCompletedPassiveContext } from '../../core-session/src/conversation/passive-seed-context.ts'
import { projectSelectedResults } from '../../core-session/src/conversation/selected-results.ts'
import type { HeldSelectedResults, ResultClassification } from '../../core-session/src/conversation/selected-results-types.ts'
import { recordFixture } from './managed-fixture.ts'
import { createNativeConsumerOwners } from './helpers/native-consumer-fixture.ts'
import { observationHash } from '../../core-session/test/fixtures/semantic-observation.ts'
import { exportSelectedResultsConversationSeed } from '../../core-session/src/conversation/seed-export.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { codecWire } from '../../core-session/test/fixtures/selected-results.ts'
import { createManagedSessionState } from '../../core-session/src/managed/view.ts'
import type { FactOwner } from '../../core-session/src/managed/ports.ts'

const ref = (digit = 'a'): ManagedArtifactRef => ({ version: 1, id: 'ctxv1_' + digit.repeat(64), revision: digit.repeat(64), codec: 'json-utf8-v1', encodedBytes: 12, contentDigest: digit.repeat(64), completeness: 'source-limited' })
const envelope = (retained = ref(), catalog = false): ResultEnvelope => ({ version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'artifact', ref: retained }, ...(catalog ? { dependencies: { kind: 'artifact-set' as const, ref: retained, count: 7 } } : {}) })
const legacy = (callId: string, sessionId = 'source') => ({ id: 'ctx_' + 'c'.repeat(64), workspaceId: 'original-workspace', sessionId, callId, label: 'declared', revision: 'c'.repeat(64), bytes: 12, originalBytes: 12, complete: true, expiresAt: 9999999999999 })
async function setup() {
  const root = await mkdtemp(join(process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!, 'ledger-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'source' })
  const document = await coordinator.openManagedDocument('source')
  await recordFixture(document, { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
  await recordFixture(document, { type: 'turn/start' })
  return { root, coordinator, document, async close() { await coordinator.close() } }
}
async function accepted(document: ManagedDocument, callId = 'outer', result = envelope()) {
  const action = document.beginAction(), facts = action.facts, start = document.view.events.length
  try {
    committedFactSeqs(await facts.agent.lifecycle({ type: 'step/start', actionId: callId, attemptId: callId }))
    const [call] = committedFactSeqs(await facts.tools.call({ type: 'tool/call', callId, name: 'code_exec', args: {} }))
    committedFactSeqs(await facts.agent.accept({ type: 'assistant/message', text: '' }, { type: 'model/exchange-accepted', version: 1, exchangeId: callId, actionId: callId, attemptId: callId,
      stepStartSeq: { kind: 'prior', seq: start, expectedType: 'step/start' }, assistantSeq: { kind: 'group', position: 0, expectedType: 'assistant/message' }, callSeqs: [{ kind: 'prior', seq: call!, expectedType: 'tool/call' }] }))
    committedFactSeqs(await facts.tools.dispatch(callId, { kind: 'prior', seq: call!, expectedType: 'tool/call' }))
    const [resultSeq] = committedFactSeqs(await facts.tools.result({ type: 'tool/result', callId, name: 'code_exec', envelope: result }))
    committedFactSeqs(await facts.agent.lifecycle({ type: 'step/end' }))
    return { call: call!, result: resultSeq! }
  } finally { action.finish() }
}
async function native(document: ManagedDocument, options: { state?: 'completed' | 'failed' | 'running' | 'terminated' | 'interrupted'; sessionId?: string; parent?: string; name?: string; resultCell?: string; endParent?: string; dispatchOffset?: number; noStarted?: boolean; noParent?: boolean; noDispatch?: boolean; noResult?: boolean } = {}) {
  if (!options.noStarted) await recordFixture(document, { type: 'code/cell', cellId: 'cell', sessionId: options.sessionId, parentCallId: options.noParent ? undefined : options.parent ?? 'outer', state: 'started' })
  const action = document.beginAction()
  let call: number
  try {
    ;[call] = committedFactSeqs(await action.facts.code.record({ type: 'code/call', cellId: 'cell', parentCallId: options.noParent ? undefined : options.parent ?? 'outer', callId: 'nested', name: 'fixture', args: {} }))
    if (!options.noDispatch) committedFactSeqs(await action.facts.code.dispatch('cell', 'nested', { kind: 'prior', seq: call! + (options.dispatchOffset ?? 0), expectedType: 'code/call' }))
  } finally { action.finish() }
  const declared = document.view.events.length
  await recordFixture(document, { type: 'context/result-ref', ref: legacy('nested') })
  if (!options.noResult) await recordFixture(document, { type: 'code/result', cellId: options.resultCell ?? 'cell', callId: 'nested', name: options.name ?? 'fixture', envelope: envelope() })
  await recordFixture(document, { type: 'code/output', cellId: 'cell', envelope: { ...envelope(ref('b')), execution: { outcome: 'unknown', dispatch: 'not-dispatched' } } })
  await recordFixture(document, { type: 'code/cell', cellId: 'cell', sessionId: options.sessionId, parentCallId: options.noParent ? undefined : options.endParent ?? options.parent ?? 'outer', state: options.state ?? 'completed' })
  return { call: call!, declared }
}
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const value of iterable) result.push(value); return result }
async function reset(document: ManagedDocument, removedSeqs: number[]) {
  const action = document.beginAction()
  try { committedFactSeqs(await action.facts.compaction.commit([{ type: 'compaction/reset', removedSeqs }])) } finally { action.finish() }
}
async function inspect(fixture: Awaited<ReturnType<typeof setup>>, use?: (held: HeldSelectedResults) => Promise<void>, atSeq?: number) {
  const { coordinator, document } = fixture
  const witness = createForkSourceWitness(document)
  return coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async observation => {
    const assertCurrent = () => { observation.assertCurrent(); witness.assertUnchanged() }
    const created = createCompletedPassiveContext({ kind: 'held-public-fork', sourceSessionId: 'source', view: document.view, factOwner: document, assertCurrent }, { kind: 'completed', ...(atSeq === undefined ? {} : { atSeq }) })
    if (created.kind !== 'ready') throw Error('Actual context refused: ' + created.reason)
    // This actual source has no inherited bootstrap or old plan rows. The
    // protocol reader for nonempty inherited metadata belongs to Task5.
    const inherited = { assertCurrent, async *legacy() { assertCurrent(); if (document.view.header?.semanticSeed) throw Error('Inherited proof required') } }
    const outcome = await projectSelectedResults(created.context, inherited)
    if (outcome.kind !== 'selected') return { outcome, rows: [] as SelectedResultRow[], classifications: [] as ResultClassification[] }
    const pages = await collect(outcome.results.pages()), classifications = await collect(outcome.results.classifications())
    await use?.(outcome.results)
    return { outcome, rows: pages.flatMap(page => page.rows), classifications }
  })
}
it('keeps both finite observation uses while excluding an extra open native address for the same ref, including after later cell failure', async () => {
  const fixture = await setup()
  try {
    const outer = await accepted(fixture.document, 'outer', envelope(ref(), true))
    await native(fixture.document, { state: 'running' })
    await recordFixture(fixture.document, { type: 'turn/end' })
    const first = await inspect(fixture)
    expect(first.outcome.kind).toBe('selected')
    expect(first.rows.map(row => [row.original.seq, row.protocol === 'managed' ? row.use : null])).toEqual([[outer.result, { kind: 'result' }], [outer.result, { kind: 'dependency-catalog', count: 7 }]])
    expect(first.rows.map(row => row.ref)).toEqual([ref(), ref()])
    expect(first.classifications.filter(value => value.kind === 'excluded')).toHaveLength(3)
    await recordFixture(fixture.document, { type: 'code/cell', cellId: 'cell', parentCallId: 'outer', state: 'failed' })
    expect((await inspect(fixture)).rows).toEqual(first.rows)
  } finally { await fixture.close() }
})
it('excludes pending extra native declarations before their nested terminal result without revoking a closed finite observation', async () => {
  const fixture = await setup()
  try {
    await accepted(fixture.document)
    await native(fixture.document, { state: 'running', noResult: true })
    await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture)
    expect(result.outcome.kind).toBe('selected'); expect(result.rows).toHaveLength(1)
    expect(result.classifications.filter(row => row.kind === 'excluded')).toEqual([{ kind: 'excluded', reason: 'native-not-completed' }, { kind: 'excluded', reason: 'native-not-completed' }])
  } finally { await fixture.close() }
})
it('proves native managed/output and direct legacy by exact started/completed/call/dispatch/result and accepted parent metadata', async () => {
  const fixture = await setup()
  try {
    const outer = await accepted(fixture.document)
    const facts = await native(fixture.document)
    await recordFixture(fixture.document, { type: 'context/result-ref', ref: { ...legacy('outer'), id: 'ctx_' + 'd'.repeat(64) } })
    await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture)
    expect(result.outcome.kind).toBe('selected'); expect(result.rows).toHaveLength(5)
    const row = result.rows.find(row => row.original.seq === facts.declared)!
    expect(row).toMatchObject({ protocol: 'legacy', ref: { workspaceId: 'original-workspace' }, basis: { kind: 'standalone-native', unit: { kind: 'code-cell', at: { part: 'code/cell' }, closedAt: { part: 'code/cell' } } } })
    expect(row.branchEvidence).toContainEqual({ origin: 0, seq: facts.call, part: 'code/call' })
    expect(row.branchEvidence).toContainEqual({ origin: 0, seq: outer.call, part: 'call' })
    expect(row.branchEvidence).toContainEqual({ origin: 0, seq: outer.result, part: 'result' })
    const sameRefRows = result.rows.filter(row => row.protocol === 'managed' && row.ref.id === ref().id)
    expect(sameRefRows).toHaveLength(2); expect(sameRefRows[0]!.original.seq).not.toBe(sameRefRows[1]!.original.seq)
    const output = fixture.document.view.events.find(event => event.type === 'code/output')
    expect(output?.type === 'code/output' && output.envelope?.execution).toEqual({ outcome: 'unknown', dispatch: 'not-dispatched' })
  } finally { await fixture.close() }
})
it('binds the held summary to the specified start/page/end fold, with no model-visible body access', async () => {
  const fixture = await setup()
  try {
    await accepted(fixture.document); await recordFixture(fixture.document, { type: 'turn/end' })
    await inspect(fixture, async held => {
      const pages = await collect(held.pages())
      let previous = observationHash('ih.selected-results.start.v1', { version: 1, rows: held.summary.rows, pages: pages.length })
      for (const page of pages) previous = observationHash('ih.selected-results.page.v1', { previous, page })
      expect(held.summary.digest).toBe(observationHash('ih.selected-results.end.v1', { previous, rows: held.summary.rows, pages: pages.length }))
      expect(Object.isFrozen(pages[0]!.rows[0]!.ref)).toBe(true)
    })
  } finally { await fixture.close() }
})
it('does not discover an undeclared artifact even when its actual owner can read the complete bytes', async () => {
  const fixture = await setup(), owners = await createNativeConsumerOwners(fixture.coordinator, fixture.root)
  try {
    await owners.projects.bind('source')
    const source = await owners.runtime.sourceFor('source'), current = (await owners.projects.resultReadScopeFor('source'))!
    const scope = owners.runtime.contextOutput.registerResultScope({ operationId: 'undeclared', sessionId: 'source', callId: 'undeclared', source }, () => { current(); return !!fixture.coordinator.ownerOf('source') })
    const sink = await owners.runtime.contextOutput.beginResult(scope, 'text-utf8-v1')
    await sink.write(Buffer.from('OWNER READABLE UNDECLARED'))
    const saved = await sink.finish('complete')
    if (saved.kind !== 'committed') throw Error('Original owner publication refused')
    expect(await owners.runtime.contextOutput.readResult({ sessionId: 'source' }, { ref: saved.ref })).toMatchObject({ data: { kind: 'text', text: 'OWNER READABLE UNDECLARED' }, eof: true })
    await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture)
    expect(result.outcome.kind).toBe('selected'); expect(result.rows).toEqual([])
  } finally { await owners.close(); await fixture.close() }
})
it.each(['running', 'completed', 'killed', 'error'] as const)('selects job %s only with its actual retained terminal metadata', async status => {
  const fixture = await setup()
  try {
    const action = fixture.document.beginAction()
    try { committedFactSeqs(await action.facts.delivery.record({ type: 'job/status', version: 1, job: { jobId: 'job', kind: 'process', label: 'job', status, outputAvailable: true, result: { version: 1, revision: 'revision', kind: 'retained', envelope: envelope() } } })) } finally { action.finish() }
    await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture)
    expect(result.outcome.kind).toBe('selected')
    expect(result.rows).toHaveLength(status === 'running' ? 0 : 1)
    if (status === 'running') expect(result.classifications).toEqual([{ kind: 'excluded', reason: 'open' }])
    else expect(result.rows[0]!.basis).toMatchObject({ kind: 'selected-observation', unit: { kind: 'job' } })
  } finally { await fixture.close() }
})
it.each(['completed', 'error', 'cancelled', 'recovery-required'] as const)('selects subagent %s only with its matching actual start and retained revision', async outcome => {
  const fixture = await setup()
  try {
    const action = fixture.document.beginAction()
    try {
      committedFactSeqs(await action.facts.delivery.record({ type: 'subagent/start', version: 1, taskId: 'task', agentPath: '/fixture', role: 'fixture', description: 'fixture' }))
      committedFactSeqs(await action.facts.delivery.record({ type: 'subagent/end', version: 1, taskId: 'task', outcome, resultRevision: 'revision', envelope: envelope() }))
    } finally { action.finish() }
    await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture)
    expect(result.outcome.kind).toBe('selected'); expect(result.rows).toHaveLength(outcome === 'recovery-required' ? 0 : 1)
    if (outcome === 'recovery-required') expect(result.classifications).toEqual([{ kind: 'excluded', reason: 'unresolved' }])
    else expect(result.rows[0]!.basis).toMatchObject({ kind: 'selected-observation', unit: { kind: 'subagent' } })
  } finally { await fixture.close() }
})
it('keeps closed observation membership through complete replacement then reset, and expires escaped iterators with the actual held observation', async () => {
  const fixture = await setup()
  let escaped: HeldSelectedResults | undefined
  let escapedIterator: AsyncIterator<unknown> | undefined
  try {
    const outer = await accepted(fixture.document)
    await recordFixture(fixture.document, { type: 'context/result-ref', ref: legacy('outer') })
    await recordFixture(fixture.document, { type: 'turn/end' })
    const before = await inspect(fixture)
    expect(before.rows).toHaveLength(2)
    const { projectConversation } = await import('@i-harness/core-session')
    const items = projectConversation(fixture.document.view).items
    const coverage = items.map(item => ({ item: item.ref!, sources: [...item.sources, ...item.provenance.evidence].map(source => ({ seq: source.seq!, part: source.part })).filter((value, index, all) => all.findIndex(other => other.seq === value.seq && other.part === value.part) === index).sort((a, b) => a.seq - b.seq || a.part.localeCompare(b.part)) }))
    const action = fixture.document.beginAction(), replacement = fixture.document.view.events.length
    try { committedFactSeqs(await action.captureContextReduction!({ kind: 'context-reduction', events: [{ type: 'compaction/replacement', version: 1, replacementId: 'rewrite', text: 'summary', coverage, insertBefore: coverage[0]!.item }] }, () => true).admit()) } finally { action.finish() }
    await reset(fixture.document, [replacement])
    const after = await inspect(fixture, async held => { escaped = held; escapedIterator = held.pages()[Symbol.asyncIterator](); await escapedIterator.next() })
    expect(after.rows).toHaveLength(2)
    expect(after.rows.find(row => row.original.seq === outer.result)?.basis).toMatchObject({ kind: 'consumed-closed', consumedAt: { seq: replacement }, latestConsumption: { seq: replacement + 1 } })
    expect(after.rows.every(row => row.branchEvidence.length <= 16)).toBe(true)
    await expect(collect(escaped!.pages())).rejects.toThrow()
    await expect(escapedIterator!.return!()).rejects.toThrow()
  } finally { await fixture.close() }
})
it.each([
  [{ name: 'conflict' }, 'ambiguous'], [{ sessionId: 'foreign' }, 'ambiguous'], [{ parent: 'missing' }, 'unsupported-history'], [{ noParent: true }, 'unsupported-history'], [{ noStarted: true }, 'unsupported-history'],
  [{ noDispatch: true }, 'unsupported-history'], [{ noResult: true }, 'unsupported-history'],
  [{ resultCell: 'other-cell' }, 'ambiguous'], [{ endParent: 'other-parent' }, 'ambiguous'],
] as const)('refuses extra native proof %j as %s with no published prefix', async (options, reason) => {
  const fixture = await setup()
  try { await accepted(fixture.document); await native(fixture.document, options); await recordFixture(fixture.document, { type: 'turn/end' }); expect((await inspect(fixture)).outcome).toEqual({ kind: 'refused', reason }) }
  finally { await fixture.close() }
})
it.each(['failed', 'terminated', 'interrupted'] as const)('excludes extra native %s cells while preserving the independent finite result', async state => {
  const fixture = await setup()
  try {
    await accepted(fixture.document); await native(fixture.document, { state }); await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture)
    expect(result.outcome.kind).toBe('selected'); expect(result.rows).toHaveLength(1)
    expect(result.classifications.filter(row => row.kind === 'excluded')).toHaveLength(3)
  } finally { await fixture.close() }
})
it('excludes a native declaration whose original started endpoint was rewound even when its result and ref are on the current branch', async () => {
  const fixture = await setup()
  try {
    await accepted(fixture.document)
    const anchorSeq = fixture.document.view.events.length
    await recordFixture(fixture.document, { type: 'code/cell', cellId: 'cell', parentCallId: 'outer', state: 'started' })
    await recordFixture(fixture.document, { type: 'rewind/point', version: 1, anchorSeq, targetTurn: 1, mode: 'conversation', fileOps: [] })
    await native(fixture.document, { noStarted: true }); await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture)
    expect(result.outcome.kind).toBe('selected'); expect(result.rows).toHaveLength(1)
    expect(result.classifications.filter(row => row.kind === 'excluded' && row.reason === 'rewound')).toHaveLength(3)
  } finally { await fixture.close() }
})
it('refuses partial historical hiding of a producer and an oversized metadata row', async () => {
  const partial = await setup()
  try {
    const outer = await accepted(partial.document)
    await recordFixture(partial.document, { type: 'turn/end' })
    await reset(partial.document, [outer.result])
    expect((await inspect(partial)).outcome).toEqual({ kind: 'refused', reason: 'unsupported-history' })
  } finally { await partial.close() }
  const large = await setup()
  try {
    await accepted(large.document)
    await recordFixture(large.document, { type: 'context/result-ref', ref: { ...legacy('outer'), label: '字'.repeat(30_000) } })
    await recordFixture(large.document, { type: 'turn/end' })
    expect((await inspect(large)).outcome).toEqual({ kind: 'refused', reason: 'metadata-limit' })
  } finally { await large.close() }
})
it('reserves the complete specified resource-record envelope when bounding a held metadata page', async () => {
  const baseline = await setup()
  let labelBytes = 0
  try {
    await accepted(baseline.document); await recordFixture(baseline.document, { type: 'context/result-ref', ref: { ...legacy('outer'), label: '' } }); await recordFixture(baseline.document, { type: 'turn/end' })
    const row = (await inspect(baseline)).rows.find(row => row.protocol === 'legacy')!
    const page = { version: 1, ordinal: 1, firstRow: 1, extent: row.extent, rows: [row] }
    labelBytes = 65_536 - Buffer.byteLength(JSON.stringify(page)) - 20
  } finally { await baseline.close() }
  const bounded = await setup()
  try {
    await accepted(bounded.document); await recordFixture(bounded.document, { type: 'context/result-ref', ref: { ...legacy('outer'), label: 'x'.repeat(labelBytes) } }); await recordFixture(bounded.document, { type: 'turn/end' })
    expect((await inspect(bounded)).outcome).toEqual({ kind: 'refused', reason: 'metadata-limit' })
  } finally { await bounded.close() }
})
it('refuses a competing top-level/native call identity and a foreign legacy source', async () => {
  const duplicate = await setup()
  try {
    await accepted(duplicate.document); await accepted(duplicate.document, 'nested', envelope(ref('d'))); await native(duplicate.document)
    await recordFixture(duplicate.document, { type: 'turn/end' })
    expect((await inspect(duplicate)).outcome).toEqual({ kind: 'refused', reason: 'ambiguous' })
  } finally { await duplicate.close() }
  const foreign = await setup()
  try {
    await accepted(foreign.document); await recordFixture(foreign.document, { type: 'context/result-ref', ref: legacy('outer', 'other-source') }); await recordFixture(foreign.document, { type: 'turn/end' })
    expect((await inspect(foreign)).outcome).toEqual({ kind: 'refused', reason: 'ambiguous' })
  } finally { await foreign.close() }
})
it('refuses an ambiguous current call identity before publishing a represented result prefix', async () => {
  const fixture = await setup()
  try {
    await accepted(fixture.document)
    await recordFixture(fixture.document, { type: 'code/call', cellId: 'ambiguous', callId: 'outer', parentCallId: 'outer', name: 'fixture', args: {} })
    await recordFixture(fixture.document, { type: 'turn/end' })
    expect((await inspect(fixture)).outcome).toEqual({ kind: 'refused', reason: 'ambiguous' })
  } finally { await fixture.close() }
})
it('checks the actual source observation after inherited iterator awaits, including completion', async () => {
  const fixture = await setup()
  try {
    await accepted(fixture.document); await recordFixture(fixture.document, { type: 'turn/end' })
    const signal = new AbortController(), witness = createForkSourceWitness(fixture.document)
    await expect(fixture.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'], signal: signal.signal }, async observation => {
      const assertCurrent = () => { observation.assertCurrent(); witness.assertUnchanged() }
      const created = createCompletedPassiveContext({ kind: 'held-public-fork', sourceSessionId: 'source', view: fixture.document.view, factOwner: fixture.document, assertCurrent }, { kind: 'completed' })
      if (created.kind !== 'ready') throw Error(created.reason)
      expect(await projectSelectedResults({ ...created.context }, { assertCurrent, async *legacy() {} })).toEqual({ kind: 'refused', reason: 'unsupported-history' })
      const wrongIdentity = createCompletedPassiveContext({ ...created.context.owner, sourceSessionId: 'foreign' }, { kind: 'completed' })
      if (wrongIdentity.kind !== 'ready') throw Error(wrongIdentity.reason)
      expect(await projectSelectedResults(wrongIdentity.context, { assertCurrent, async *legacy() {} })).toEqual({ kind: 'refused', reason: 'ambiguous' })
      expect(await projectSelectedResults(created.context, { assertCurrent, async *legacy() { throw Error('Original inherited L1 proof unavailable') } })).toEqual({ kind: 'refused', reason: 'unsupported-history' })
      let reads = 0
      let closed = 0
      const poison = Object.defineProperty({}, 'extent', { enumerable: true, get() { reads++; throw Error('Invalid inherited metadata accessor') } })
      expect(await projectSelectedResults(created.context, { assertCurrent, async *legacy() { try { yield poison as never } finally { closed++ } } })).toEqual({ kind: 'refused', reason: 'unsupported-history' })
      expect(reads).toBe(0)
      expect(closed).toBe(1)
      const result = await projectSelectedResults(created.context, { assertCurrent, async *legacy() { signal.abort(); await Promise.resolve() } })
      expect(result).toEqual({ kind: 'refused', reason: 'source-changed' })
    })).rejects.toThrow('revoked')
  } finally { await fixture.close() }
})
it.each(['open', 'unresolved'] as const)('keeps %s top-level work excluded by its own closure', async state => {
  const fixture = await setup()
  try {
    await accepted(fixture.document)
    await recordFixture(fixture.document, { type: 'turn/end' })
    const action = fixture.document.beginAction()
    try {
      const start = fixture.document.view.events.length
      committedFactSeqs(await action.facts.agent.lifecycle({ type: 'step/start', actionId: 'tail', attemptId: 'tail' }))
      const [seq] = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', callId: 'tail', name: 'fixture', args: {} }))
      committedFactSeqs(await action.facts.agent.accept({ type: 'assistant/message', text: '' }, { type: 'model/exchange-accepted', version: 1, exchangeId: 'tail', actionId: 'tail', attemptId: 'tail', stepStartSeq: { kind: 'prior', seq: start, expectedType: 'step/start' }, assistantSeq: { kind: 'group', position: 0, expectedType: 'assistant/message' }, callSeqs: [{ kind: 'prior', seq: seq!, expectedType: 'tool/call' }] }))
      committedFactSeqs(await action.facts.tools.dispatch('tail', { kind: 'prior', seq: seq!, expectedType: 'tool/call' }))
      committedFactSeqs(await action.facts.tools.result({ type: 'tool/result', name: 'fixture', callId: 'tail', envelope: { ...envelope(ref('b')), execution: { outcome: 'unknown', dispatch: 'dispatched' } } }))
      if (state === 'unresolved') committedFactSeqs(await action.facts.agent.lifecycle({ type: 'step/end' }))
      // A completed boundary predates trailing unframed work; it is still
      // inside the exact upper until another turn starts.
    } finally { action.finish() }
    const result = await inspect(fixture)
    expect(result.outcome.kind).toBe('selected')
    expect(result.rows).toHaveLength(1)
    expect(result.classifications).toContainEqual({ kind: 'excluded', reason: state })
  } finally { await fixture.close() }
})
it('excludes hidden legacy facts and rewound native declarations while retaining independent selected observations', async () => {
  const fixture = await setup()
  try {
    await accepted(fixture.document)
    const first = fixture.document.view.events.length
    await recordFixture(fixture.document, { type: 'context/result-ref', ref: legacy('outer') })
    await reset(fixture.document, [first])
    const anchor = fixture.document.view.events.length
    await native(fixture.document)
    await recordFixture(fixture.document, { type: 'rewind/point', version: 1, targetTurn: 1, anchorSeq: anchor, mode: 'conversation', fileOps: [] })
    await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture)
    expect(result.rows).toHaveLength(1)
    expect(result.classifications).toContainEqual({ kind: 'excluded', reason: 'hidden' })
    expect(result.classifications.filter(row => row.kind === 'excluded' && row.reason === 'rewound')).toHaveLength(3)
  } finally { await fixture.close() }
})
it('excludes later-turn declarations beyond the exact completed upper', async () => {
  const fixture = await setup()
  try {
    await accepted(fixture.document); await recordFixture(fixture.document, { type: 'turn/end' })
    const atSeq = fixture.document.view.events.length - 1
    await recordFixture(fixture.document, { type: 'turn/start' }); await accepted(fixture.document, 'future', envelope(ref('b'))); await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture, undefined, atSeq)
    expect(result.rows).toHaveLength(1); expect(result.classifications).toContainEqual({ kind: 'excluded', reason: 'future' })
  } finally { await fixture.close() }
})
it('does not let a future native identity relabel an earlier closed legacy declaration', async () => {
  const fixture = await setup()
  try {
    await accepted(fixture.document, 'nested')
    await recordFixture(fixture.document, { type: 'context/result-ref', ref: legacy('nested') })
    await recordFixture(fixture.document, { type: 'turn/end' })
    const atSeq = fixture.document.view.events.length - 1
    await recordFixture(fixture.document, { type: 'turn/start' })
    await recordFixture(fixture.document, { type: 'code/call', cellId: 'future', callId: 'nested', name: 'future', parentCallId: 'nested', args: {} })
    await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture, undefined, atSeq)
    expect(result.outcome.kind).toBe('selected'); expect(result.rows).toHaveLength(2)
  } finally { await fixture.close() }
})
it('does not let a rewound top-level call make a current native declaration ambiguous', async () => {
  const fixture = await setup()
  try {
    const anchorSeq = fixture.document.view.events.length
    await accepted(fixture.document, 'nested'); await recordFixture(fixture.document, { type: 'turn/end' })
    await recordFixture(fixture.document, { type: 'rewind/point', version: 1, anchorSeq, targetTurn: 1, mode: 'conversation', fileOps: [] })
    await recordFixture(fixture.document, { type: 'turn/start' })
    await accepted(fixture.document); await native(fixture.document); await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture)
    expect(result.outcome.kind).toBe('selected'); expect(result.rows).toHaveLength(4)
    expect(result.classifications).toContainEqual({ kind: 'excluded', reason: 'rewound' })
  } finally { await fixture.close() }
})
it('review I1 keeps a current ordinary legacy declaration on its accepted exchange when a native identity was rewound', async () => {
  const fixture = await setup()
  try {
    const rewoundCall = fixture.document.view.events.length
    await recordFixture(fixture.document, { type: 'code/call', cellId: 'rewound', callId: 'nested', name: 'fixture', parentCallId: 'obsolete', args: {} })
    await recordFixture(fixture.document, { type: 'rewind/point', version: 1, anchorSeq: rewoundCall, targetTurn: 1, mode: 'conversation', fileOps: [] })
    const stepSeq = fixture.document.view.events.length
    const current = await accepted(fixture.document, 'nested')
    const closedSeq = fixture.document.view.events.at(-1)!.seq!
    const declarationSeq = fixture.document.view.events.length, declared = legacy('nested')
    await recordFixture(fixture.document, { type: 'context/result-ref', ref: declared })
    await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture)
    expect(result.outcome.kind).toBe('selected'); expect(result.rows).toHaveLength(2)
    const row = result.rows.find(row => row.protocol === 'legacy')!
    expect(row).toMatchObject({ protocol: 'legacy', ref: declared, original: { kind: 'local', sessionId: 'source', seq: declarationSeq, event: 'context/result-ref', slot: 'ref' },
      basis: { kind: 'selected-observation', unit: { kind: 'exchange', at: { origin: 0, seq: stepSeq, part: 'step' }, closedAt: { origin: 0, seq: closedSeq, part: 'step' } } } })
    expect(row.branchEvidence).toContainEqual({ origin: 0, seq: current.call, part: 'call' })
    expect(row.branchEvidence).toContainEqual({ origin: 0, seq: current.result, part: 'result' })
    expect(result.rows.every(row => row.basis.kind === 'selected-observation' && row.branchEvidence.every(at => !at.part.startsWith('code/') && at.seq !== rewoundCall))).toBe(true)
  } finally { await fixture.close() }
})
it('review I2 refuses an extra callId-free output hidden without its own complete consumption proof', async () => {
  const fixture = await setup()
  try {
    await accepted(fixture.document); await native(fixture.document)
    const output = fixture.document.view.events.find(event => event.type === 'code/output')!
    expect(Object.hasOwn(output, 'callId')).toBe(false)
    await recordFixture(fixture.document, { type: 'turn/end' })
    await reset(fixture.document, [output.seq!])
    const result = await inspect(fixture)
    expect(result.outcome).toEqual({ kind: 'refused', reason: 'unsupported-history' }); expect(result.rows).toEqual([])
    expect(output.type === 'code/output' && output.envelope?.execution).toEqual({ outcome: 'unknown', dispatch: 'not-dispatched' })
  } finally { await fixture.close() }
})
it('review I3 refuses a retained terminal job hidden without a complete consumption proof', async () => {
  const fixture = await setup()
  try {
    const seq = fixture.document.view.events.length, action = fixture.document.beginAction()
    try { committedFactSeqs(await action.facts.delivery.record({ type: 'job/status', version: 1, job: { jobId: 'job', kind: 'process', label: 'job', status: 'completed', outputAvailable: true, result: { version: 1, revision: 'revision', kind: 'retained', envelope: envelope() } } })) } finally { action.finish() }
    await recordFixture(fixture.document, { type: 'turn/end' })
    await reset(fixture.document, [seq])
    const result = await inspect(fixture)
    expect(result.outcome).toEqual({ kind: 'refused', reason: 'unsupported-history' }); expect(result.rows).toEqual([])
  } finally { await fixture.close() }
})
it('review I1 round2 excludes a fresh legacy declaration whose sole recorded native producer was rewound', async () => {
  const fixture = await setup()
  try {
    const outer = await accepted(fixture.document), produced = await native(fixture.document)
    await recordFixture(fixture.document, { type: 'rewind/point', version: 1, anchorSeq: produced.call, targetTurn: 1, mode: 'conversation', fileOps: [] })
    await recordFixture(fixture.document, { type: 'context/result-ref', ref: legacy('nested') })
    await recordFixture(fixture.document, { type: 'turn/end' })
    const result = await inspect(fixture)
    expect(result.outcome.kind).toBe('selected')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ protocol: 'managed', original: { seq: outer.result, event: 'tool/result' }, basis: { kind: 'selected-observation' } })
    expect(result.classifications.filter(row => row.kind === 'excluded')).toEqual(Array.from({ length: 4 }, () => ({ kind: 'excluded', reason: 'rewound' })))
    expect(result.classifications.at(-1)).toEqual({ kind: 'excluded', reason: 'rewound' })
  } finally { await fixture.close() }
})

it('Task2 captures a genuine held source once and preserves its historical result-only origins through a consumed metadata descendant', async () => {
  const fixture = await setup()
  try {
    await accepted(fixture.document, 'outer', envelope(ref(), true))
    await recordFixture(fixture.document, { type: 'turn/end' })
    const witness = createForkSourceWitness(fixture.document)
    const first = await fixture.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async observation => {
      const assertCurrent = () => { observation.assertCurrent(); witness.assertUnchanged() }
      const made = createCompletedPassiveContext({ kind: 'held-public-fork', sourceSessionId: 'source', view: fixture.document.view, factOwner: fixture.document, assertCurrent }, { kind: 'completed' })
      if (made.kind !== 'ready') throw Error(made.reason)
      return exportSelectedResultsConversationSeed(made.context, { assertCurrent, async *legacy() { assertCurrent() } })
    })
    expect(first.kind).toBe('seed'); if (first.kind !== 'seed') throw Error(first.kind === 'refused' ? first.reason : first.kind)
    const wire = codecWire(first)
    // Complete codec/read fixture only. This is no new persistence route,
    // transferred recipient grant, or child memory bootstrap installation.
    const reader = createManagedSessionState(wire, { sessionId: 'A' }), factOwner = {} as FactOwner
    reader.bindOwner(factOwner)
    const consumed = wire.records.filter((event: any) => event.type === 'conversation/seed-group').map((event: any) => event.seq)
    reader.stage([{ type: 'compaction/reset', seq: wire.events.length, removedSeqs: consumed }]).install()
    await fixture.coordinator.close()
    const assertCurrent = () => {}, made = createCompletedPassiveContext({ kind: 'held-public-fork', sourceSessionId: 'A', view: reader.view, factOwner, assertCurrent }, { kind: 'completed' })
    if (made.kind !== 'ready') throw Error(made.reason)
    expect(made.context.selected.groups).toHaveLength(0)
    const second = await exportSelectedResultsConversationSeed(made.context, { assertCurrent, async *legacy() {} })
    expect(second.kind).toBe('seed'); if (second.kind !== 'seed') throw Error(second.kind === 'refused' ? second.reason : second.kind)
    expect(second.seed.groups).toHaveLength(0); expect(second.seed.results.summary.rows).toBe(2)
    expect(second.seed.origins).toEqual([{ kind: 'session', sessionId: 'A', revision: second.sourceObservationDigest }, { kind: 'session', sessionId: 'source', revision: first.sourceObservationDigest }])
    for (const row of second.seed.results.pages.flatMap(page => page.rows)) {
      expect(row.branchEvidence.every(at => at.origin === 1)).toBe(true)
      expect(row.basis).toMatchObject({ kind: 'inherited', parentSeedDigest: first.digest, parentResultsDigest: first.seed.results.summary.digest, row: row.ordinal })
    }
    const compiled = compileSelectedResultsSemanticSeed(second)
    expect(compiled.records).toEqual(codecWire(second).records)
    console.log(JSON.stringify({ control: 'Task2 genuine held source to metadata descendant', source: first.sourceObservationDigest, firstSeed: first.digest,
      firstResults: first.seed.results.summary, descendant: second.sourceObservationDigest, descendantSeed: second.digest, descendantResults: second.seed.results.summary,
      groups: second.seed.groups.length, origins: second.seed.origins }))
  } finally { await fixture.close() }
})
