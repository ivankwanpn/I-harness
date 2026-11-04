import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { managedResultRefs, createLegacyReadVisibility, createLegacyRetentionSelection, rewindCuts, type SessionEventView } from '@i-harness/core-session'
import { buildSelectionSource, resolveSeedBoundary, selectSeedHistory } from '../../../core-session/src/conversation/seed-selection.ts'
import { createSemanticSourceConversationIndex } from '../../../core-session/src/conversation/validation.ts'
import { exchangeCompletion, physicalUnitState } from '../../../core-session/src/conversation/unit-state.ts'
import type { ResultSourceObservation } from '../../../session-executor/src/lifecycle/result-observation.ts'
import { createCompletedPassiveContext } from '../../../core-session/src/conversation/passive-seed-context.ts'
import { projectSelectedResults } from '../../../core-session/src/conversation/selected-results.ts'
import type { FactOwner, SelectedResultRow } from '@i-harness/core-session'

// Diagnostic only. Every serialized object below is constructed from named
// metadata slots. No event/history-item spread or body discovery is permitted.
function data(object: unknown, key: string): unknown {
  if (!object || typeof object !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (!descriptor) return undefined
  if (!Object.hasOwn(descriptor, 'value')) throw new Error('Metadata accessor: ' + key)
  return descriptor.value
}
function scalars(object: unknown, keys: readonly string[]) {
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const value = data(object, key)
    if (value === undefined) continue
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Nonscalar metadata: ' + key)
    result[key] = value
  }
  return result
}
const managed = (ref: unknown) => scalars(ref, ['version', 'id', 'revision', 'codec', 'encodedBytes', 'contentDigest', 'completeness'])
const legacy = (ref: unknown) => ({ ...scalars(ref, ['id', 'workspaceId', 'sessionId', 'callId', 'label', 'revision', 'bytes', 'originalBytes', 'complete', 'expiresAt']),
  source: scalars(data(ref, 'source'), ['sourceId', 'path', 'revision', 'readonly']) })
const address = (value: unknown) => scalars(value, ['id', 'eventIndex', 'seq', 'part', 'addressable'])
const extent = (value: unknown) => scalars(value, ['kind', 'first', 'last'])
const at = (value: unknown) => scalars(value, ['seq', 'part'])

function slots(event: SessionEventView) {
  const adapterRefs = managedResultRefs(event)
  const job = event.type === 'job/status' ? data(event, 'job') : undefined
  const jobResult = data(job, 'result')
  const envelope = event.type === 'job/status' ? data(jobResult, 'kind') === 'retained' ? data(jobResult, 'envelope') : undefined
    : ['tool/result', 'code/result', 'code/output', 'subagent/end'].includes(event.type) ? data(event, 'envelope') : undefined
  const retention = data(envelope, 'retention'), dependencies = data(envelope, 'dependencies')
  const prefix = event.type === 'job/status' ? 'job.result.envelope.' : 'envelope.'
  const rows: { slot: string; use: { kind: string; count?: unknown }; ref: Record<string, unknown> }[] = []
  if (data(retention, 'kind') === 'artifact') rows.push({ slot: prefix + 'retention.ref', use: { kind: 'result' }, ref: managed(data(retention, 'ref')) })
  if (data(dependencies, 'kind') === 'artifact-set') rows.push({ slot: prefix + 'dependencies.ref', use: { kind: 'dependency-catalog', count: data(dependencies, 'count') }, ref: managed(data(dependencies, 'ref')) })
  if (JSON.stringify(rows.map(row => row.ref)) !== JSON.stringify(adapterRefs.map(managed))) throw new Error('Explicit slots differ from existing managedResultRefs adapter')
  return { rows, envelope: envelope ? { execution: scalars(data(envelope, 'execution'), ['outcome', 'dispatch']), retention: scalars(retention, ['kind', 'encodedBytes', 'reason', 'observedEncodedBytes']), dependencies: scalars(dependencies, ['kind', 'count', 'reason']) } : undefined }
}
function eventMetadata(event: SessionEventView) {
  const base = scalars(event, ['type', 'seq'])
  const structural = ['tool/call', 'tool/dispatch', 'tool/result', 'code/cell', 'code/call', 'code/dispatch', 'code/result', 'code/output', 'step/start', 'step/end', 'step/failed', 'model/exchange-accepted', 'subagent/start', 'subagent/end', 'turn/start', 'turn/end']
  const links = structural.includes(event.type) ? scalars(event, ['callId', 'name', 'cellId', 'sessionId', 'parentCallId', 'eventSeq', 'state', 'actionId', 'attemptId', 'exchangeId', 'stepStartSeq', 'assistantSeq', 'taskId', 'resultRevision', 'outcome']) : {}
  const result = slots(event)
  return { ...base, ...links,
    ...(event.type === 'model/exchange-accepted' ? { callSeqs: [...event.callSeqs] } : {}),
    ...(event.type === 'context/result-ref' ? { legacy: { slot: 'ref', ref: legacy(event.ref) } } : {}),
    ...(result.envelope ? { envelope: result.envelope } : {}), ...(result.rows.length ? { declarations: result.rows } : {}),
    ...(event.type === 'compaction/replacement' ? { replacementId: event.replacementId, coverage: event.coverage.map(entry => ({ item: { kind: entry.item.kind, at: at(entry.item.at) }, sources: entry.sources.map(at) })), insertBefore: { kind: event.insertBefore.kind, at: at(event.insertBefore.at) } } : {}),
    ...(event.type === 'compaction/summary' ? { shadowedSeqs: [...event.shadowedSeqs] } : {}),
    ...(event.type === 'compaction/reset' ? { removedSeqs: [...event.removedSeqs] } : {}),
    ...(event.type === 'rewind/point' ? scalars(event, ['version', 'targetTurn', 'anchorSeq', 'mode']) : {}) }
}

export async function createMetadataRecorder(mode: 'off' | 'only') {
  const root = process.env.IH_STRUCTURE_EVIDENCE_ROOT
  if (!root) throw new Error('Task-specific structure evidence root required')
  const path = join(root, 'selected-results-' + mode + '.jsonl')
  await writeFile(path, '', { flag: 'wx' })
  let bytes = 0, snapshots = 0
  return {
    path,
    async record(source: ResultSourceObservation | undefined, phase: string, document: FactOwner) {
      if (!source) throw new Error('Actual held Gateway source observation missing')
      // Only a public observation carries the session view this helper projects.
      if (source.kind !== 'public') throw new Error('Public held Gateway source observation required')
      source.assertCurrent()
      if (document.view !== source.view) throw new Error('Projection must use the actual observed document owner')
      const held = createCompletedPassiveContext({ kind: 'held-public-fork', sourceSessionId: source.sessionId, view: source.view, factOwner: document, assertCurrent: source.assertCurrent }, { kind: 'completed' })
      if (held.kind !== 'ready') throw new Error('Actual held projection context refused: ' + held.reason)
      const projected = await projectSelectedResults(held.context, { assertCurrent: source.assertCurrent, async *legacy() {
        source.assertCurrent()
        if (source.metadata.semanticSeed || (source.metadata.seedLength ?? 0) !== 0) throw new Error('Nonempty inherited L1 proof requires its original reader')
      } })
      source.assertCurrent()
      if (projected.kind !== 'selected') throw new Error('Actual selected-results projection refused: ' + projected.reason)
      const projectedRows: SelectedResultRow[] = []
      for await (const page of projected.results.pages()) projectedRows.push(...page.rows)
      const classifications = []
      for await (const classification of projected.results.classifications()) classifications.push(classification)
      const view = source.view, built = buildSelectionSource(view), selected = selectSeedHistory(view, { kind: 'completed' }, built)
      const boundary = resolveSeedBoundary(view, { kind: 'completed' }, built.turns)
      const index = createSemanticSourceConversationIndex(view.events, view.formatVersion, view.header)
      const visibility = createLegacyReadVisibility(view), transfer = createLegacyRetentionSelection(view, { kind: 'completed' })
      const metadata = view.events.map(eventMetadata), cuts = rewindCuts(view)
      const declaredManaged = view.events.flatMap(event => !cuts.some(cut => event.seq! >= cut.cutFrom && event.seq! < cut.markerSeq)
        ? slots(event).rows.map(row => ({ seq: event.seq, event: event.type, ...row })) : [])
      const itemMetadata = (item: (typeof built.history.items)[number]) => ({
        id: item.id, kind: item.kind, establishmentIndex: item.establishmentIndex, establishment: address(item.establishment), extent: extent(item.extent),
        unitInfo: item.unitInfo ? { source: address(item.unitInfo.source), state: item.unitInfo.state } : undefined,
        step: item.step ? { start: item.step.start, members: [...item.step.members], ended: item.step.ended, failed: item.step.failed, suppressed: item.step.suppressed,
          acceptanceIndex: item.step.acceptanceIndex, acceptance: scalars(item.step.acceptance, ['seq', 'exchangeId', 'stepStartSeq', 'assistantSeq']) } : undefined,
        physicalUnitState: physicalUnitState(item.step ?? { ended: true, failed: false, suppressed: false }, item.calls), exchangeCompletion: exchangeCompletion(item),
        calls: item.calls.map(call => ({ callId: call.callId, name: call.name, outcome: call.outcome, call: address(call.call), dispatch: address(call.dispatch), result: address(call.result) })),
        receivedResults: [...item.receivedResults], sources: item.sources.map(address), evidence: item.provenance.evidence.map(address),
        recipes: item.recipes.map(recipe => ({ ...scalars(recipe, ['kind', 'item', 'index']), calls: recipe.calls ? [...recipe.calls] : undefined })) })
      const selection = selected.kind === 'selected' ? { kind: selected.kind, turns: { total: selected.turns.total, completed: selected.turns.completed.map(interval => [...interval]), unframedPrefix: selected.turns.unframedPrefix },
        groups: selected.groups.map((group, ordinal) => ({ ordinal, extent: extent(group.extent), items: group.items.map(itemMetadata) })),
        omissions: selected.omissions.map(omission => ({ extent: extent(omission.extent), state: omission.state, calls: omission.calls, digest: omission.digest, source: omission.source.map(value => scalars(value, ['origin', 'seq', 'part'])), relatedInputs: [...omission.relatedInputs] })),
        inheritedOmissions: selected.inheritedOmissions.map(value => ({ ordinal: value.ordinal, extent: extent(value.omission.extent), state: value.omission.state, digest: value.omission.digest })),
        diagnostics: selected.diagnostics.map(diagnostic => ({ code: diagnostic.code, sourceIds: [...diagnostic.sourceIds] })) } : { kind: selected.kind, reason: selected.reason }
      const end = built.turns.ends.findLast(value => boundary.kind === 'resolved' && value.turn === boundary.boundary.last)
      const upper = end ? built.turns.starts.find(start => start.seq > end.seq) : undefined
      const snapshot = { diagnostic: 'selected-results-metadata-v1', mode, phase, observed: true,
        selectedResults: { summary: projected.results.summary, rows: projectedRows, classifications, context: { boundary: held.context.boundary, first: held.context.first, last: held.context.last }, inheritedLegacyProof: 'actual non-bootstrap zero-inherited source; nonempty original L1 reader remains Task5' },
        held: { sessionId: source.sessionId, metadata: scalars(source.metadata, ['sessionId', 'parentSession', 'origin', 'createdAt', 'seedLength', 'archived']), source: scalars(source.source, ['sourceId', 'path', 'revision', 'readonly']), formatVersion: view.formatVersion, eventCount: view.events.length },
        boundary: boundary.kind === 'resolved' ? { kind: boundary.kind, last: boundary.boundary.last, localCutSeq: boundary.boundary.localCutSeq,
          upper: upper ? { kind: 'before-event', at: { index: upper.seq, seq: upper.seq } } : { kind: 'archive-end', eventCount: view.events.length }, upperBasis: 'derived-from-actual-B1-turn-boundary-no-new-held-owner' } : boundary,
        turns: { total: built.turns.total, completed: built.turns.completed.map(interval => [...interval]), starts: built.turns.starts.map(value => ({ seq: value.seq, turn: value.turn })), ends: built.turns.ends.map(value => ({ seq: value.seq, turn: value.turn })), ambiguous: built.turns.ambiguous,
          extents: [...built.turns.extents].map(([index, value]) => ({ index, extent: extent(value) })) },
        cuts: cuts.map(cut => scalars(cut, ['cutFrom', 'markerSeq'])), originalWindows: built.originalWindows.map(window => scalars(window, ['cutFrom', 'markerSeq', 'markerIndex', 'startRank', 'endRank'])),
        events: metadata, historyItems: built.history.items.map(itemMetadata), selection,
        validatedReplacementDependencies: [...index.replacementDependencies()].map(([seq, dependencies]) => ({ seq, dependencies: [...dependencies] })),
        currentDeclarations: { managed: declaredManaged, legacy: visibility.kind === 'visible' ? [...visibility.local()].map(value => ({ original: at(value.original), ref: legacy(value.ref) })) : visibility },
        existingLegacyTransferSelection: transfer.kind === 'selected' ? { kind: transfer.kind, local: [...transfer.local()].map(value => ({ original: at(value.original), extent: extent(value.extent), anchor: scalars(value.anchor, ['kind', 'seq', 'manifestSeq', 'ordinal']), ref: legacy(value.ref) })) } : transfer,
        bodyReadAvailability: 'separate original fixture read assertions; not used as discovery or eligibility',
        unsupported: ['No new route/wire/protocol transfer grant', 'Nonempty inherited L1 metadata reader remains Task5', 'Original native target READY/read/search/source-clear/cold positives remain required'] }
      source.assertCurrent()
      const line = JSON.stringify(snapshot) + '\n'
      bytes += Buffer.byteLength(line); snapshots++
      if (bytes > 8 * 1024 * 1024 || snapshots > 16) throw new Error('Metadata evidence overflow: bytes=' + bytes + ' snapshots=' + snapshots)
      await appendFile(path, line)
      source.assertCurrent()
      console.info(JSON.stringify({ diagnostic: 'selected-results-snapshot', mode, phase, path, bytes: Buffer.byteLength(line), eventCount: view.events.length }))
      return projectedRows
    },
  }
}
