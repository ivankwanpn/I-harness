import type { CompletedPassiveContext } from '../passive-seed-context.ts'
import type { SeedOriginAddress, TurnExtent } from '../seed-types.ts'
import type { ResultAddress, ResultBasis, ResultClassification, SelectedResultRow } from '../selected-results-types.ts'
import type { HistoryFact } from './facts.ts'
import { historyVisibility } from './visibility.ts'
import { createNativeResultIndex } from './result-native.ts'
import { resultAt, resultUnits, unitBasis, type ResultUnit } from './result-units.ts'

type Row = Omit<Extract<SelectedResultRow, { protocol: 'managed' }>, 'ordinal'> | Omit<Extract<SelectedResultRow, { protocol: 'legacy' }>, 'ordinal'>
type Denied = Exclude<ResultClassification, { kind: 'included' }>
export type ResultDeclaration = { fact: HistoryFact; original: ResultAddress; extent: TurnExtent } &
  ({ protocol: 'managed'; ref: Extract<SelectedResultRow, { protocol: 'managed' }>['ref']; use: Extract<SelectedResultRow, { protocol: 'managed' }>['use']; represented?: ResultUnit }
  | { protocol: 'legacy'; ref: Extract<SelectedResultRow, { protocol: 'legacy' }>['ref'] })
const refused = (reason: 'ambiguous' | 'unsupported-history' | 'metadata-limit'): Denied => ({ kind: 'refused', reason })

/** Metadata ledger is separate from the finite conversation reducer. */
export function createResultResourceLedger(context: CompletedPassiveContext) {
  const facts = context.source.facts, visibility = historyVisibility(facts), ledger = resultUnits(context)
  const upper = context.boundary.upper.kind === 'archive-end' ? context.boundary.upper.eventCount : context.boundary.upper.at.index
  const callIds = new Set<string>()
  for (const fact of facts) if (fact.index < upper && visibility.branch(fact) && (fact.type === 'tool/call' || fact.type === 'code/call')) {
    const id = fact.type === 'tool/call' ? fact.callId! : fact.nativeCallId!
    if (callIds.has(id)) throw new TypeError('ambiguous')
    callIds.add(id)
  }
  const nativeIndex = createNativeResultIndex(facts, ledger.units, context.owner.sourceSessionId, upper, visibility.branch)
  const unitsByCall = new Map<string, ResultUnit[]>(), callsById = new Map<string, HistoryFact[]>()
  for (const unit of ledger.units) for (const call of unit.item.calls) {
    const entries = unitsByCall.get(call.callId) ?? []; if (!entries.includes(unit)) entries.push(unit); unitsByCall.set(call.callId, entries)
  }
  for (const fact of facts) if (fact.index < upper && fact.type === 'tool/call') { const entries = callsById.get(fact.callId!) ?? []; entries.push(fact); callsById.set(fact.callId!, entries) }
  const extentGuard = (extent: TurnExtent): Denied | undefined => {
    if (extent.kind === 'unframed') return context.selected.turns.unframedPrefix ? undefined : refused('unsupported-history')
    if (extent.last < context.first || extent.first > context.last) return { kind: 'excluded', reason: 'outside' }
    if (extent.first < context.first || extent.last > context.last) return refused('ambiguous')
  }
  const inheritedCutGuard = (extent: TurnExtent): Denied | undefined => {
    for (const window of context.source.originalWindows) for (const fact of facts) {
      if (!fact.seedExtent || fact.index < window.cutFrom || fact.index >= window.markerIndex) continue
      const affected = fact.seedExtent
      if (affected.kind === 'unframed' && extent.kind === 'unframed') return { kind: 'excluded', reason: 'rewound' }
      if (affected.kind !== 'framed' || extent.kind !== 'framed' || affected.last < extent.first || affected.first > extent.last) continue
      return affected.first <= extent.first && affected.last >= extent.last ? { kind: 'excluded', reason: 'rewound' } : refused('ambiguous')
    }
  }
  const omitted = (indices: readonly number[]) => context.selected.omissions.some(omission => omission.source.some(at => at.origin === 0 && indices.some(index => facts[index]!.seq === at.seq)))
  const evidenceGuard = (indices: readonly number[], consumed?: ResultUnit, checkOmissions = true): Denied | undefined => {
    if (indices.some(index => index >= upper)) return { kind: 'excluded', reason: 'future' }
    if (indices.some(index => !visibility.branch(facts[index]!))) return { kind: 'excluded', reason: 'rewound' }
    if (indices.some(index => visibility.shadowed(facts[index]!) && !(consumed?.consumption && consumed.indices.includes(index)))) return refused('unsupported-history')
    if (consumed?.consumption && [consumed.consumption.first, consumed.consumption.latest].some(at => at.seq >= upper)) return { kind: 'excluded', reason: 'future' }
    if (checkOmissions && omitted(indices)) return { kind: 'excluded', reason: 'omitted' }
    for (const index of indices) {
      const extent = context.source.turns.extents.get(index)!
      // Trailing unframed metadata is attached to its proven unit; never create
      // a new turn or give an orphan unframed resource a selected extent.
      if (extent.kind === 'framed') { const denied = extentGuard(extent); if (denied) return denied }
    }
  }
  const unitEvidence = (unit: ResultUnit, fact: HistoryFact): SeedOriginAddress[] => {
    const callId = fact.callId ?? fact.legacyResult?.callId
    const call = unit.item.calls.find(call => call.callId === callId || call.result?.eventIndex === fact.index)
    return [unit.unit.at, unit.unit.closedAt,
      ...(unit.item.step?.acceptance ? [resultAt(unit.item.step.acceptance, 'acceptance')] : []),
      ...(call ? [call.call, call.dispatch, call.result].flatMap(at => at ? [{ origin: 0, seq: at.seq!, part: at.part }] : []) : []),
      ...(unit.consumption ? [unit.consumption.first, unit.consumption.latest] : [])]
  }
  const finish = (declaration: ResultDeclaration, basis: ResultBasis, evidence: readonly SeedOriginAddress[], extent = declaration.extent): ResultClassification => {
    const branchEvidence = [...new Map(evidence.map(at => [`${at.origin}:${at.seq}:${at.part}`, at])).values()]
    if (branchEvidence.length > 16) return refused('metadata-limit')
    const base = { original: declaration.original, extent: context.selected.rebase(extent), basis, branchEvidence }
    const row: Row = declaration.protocol === 'managed' ? { ...base, protocol: 'managed', ref: declaration.ref, use: declaration.use } : { ...base, protocol: 'legacy', ref: declaration.ref }
    return { kind: 'included', row }
  }
  const classify = (declaration: ResultDeclaration): ResultClassification => {
    const { fact } = declaration
    if (fact.index >= upper) return { kind: 'excluded', reason: 'future' }
    // A local declaration must be in a uniquely recorded source branch first.
    const extentDenied = declaration.extent.kind === 'framed' ? extentGuard(declaration.extent) : undefined
    if (extentDenied) return extentDenied
    if (!visibility.branch(fact)) return { kind: 'excluded', reason: 'rewound' }
    if (declaration.protocol === 'legacy' && visibility.shadowed(fact)) return { kind: 'excluded', reason: 'hidden' }
    if (declaration.protocol === 'legacy' && declaration.ref.sessionId !== context.owner.sourceSessionId) return refused('ambiguous')
    // Exact address + ref + use membership: an extra address for the same bytes
    // does not enter this branch, and receives its independent native proof.
    const represented = declaration.protocol === 'managed' ? declaration.represented : undefined
    if (represented) {
      const denied = evidenceGuard(represented.indices, represented) ?? extentGuard(represented.extent)
      if (denied) return denied
      return finish(declaration, unitBasis(represented), unitEvidence(represented, fact), represented.extent)
    }
    const nativeCallId = fact.nativeCallId ?? fact.legacyResult?.callId
    const native = fact.type === 'code/result' || fact.type === 'code/output' || declaration.protocol === 'legacy' && nativeIndex.hasCall(nativeCallId)
    if (native) {
      const proof = nativeIndex.prove(fact)
      if (proof.kind !== 'proof') return proof
      const denied = evidenceGuard(proof.indices, proof.parent)
      if (denied) return denied
      const extents = proof.indices.map(index => context.source.turns.extents.get(index)!).filter((extent): extent is Extract<TurnExtent, { kind: 'framed' }> => extent.kind === 'framed')
      const extent: TurnExtent = extents.length ? { kind: 'framed', first: Math.min(...extents.map(value => value.first)), last: Math.max(...extents.map(value => value.last)) } : { kind: 'unframed' }
      const bound = extentGuard(extent); if (bound) return bound
      return finish(declaration, proof.basis, proof.evidence, extent)
    }
    if (fact.type === 'tool/result' || declaration.protocol === 'legacy') {
      const id = fact.callId ?? fact.legacyResult?.callId
      const calls = callsById.get(id!) ?? []
      if (calls.length > 1) return refused('ambiguous')
      const matches = unitsByCall.get(id!) ?? []
      if (matches.length > 1) return refused('ambiguous')
      const unit = matches[0]
      if (!unit) return refused('unsupported-history')
      if (unit.partial) return refused('unsupported-history')
      const denied = evidenceGuard(unit.indices, unit, false) ?? extentGuard(unit.extent)
      if (denied) return denied
      if (unit.state !== 'closed') return { kind: 'excluded', reason: unit.state }
      if (omitted(unit.indices)) return { kind: 'excluded', reason: 'omitted' }
      // A closed historical unit is preserved only by a proved consumption or
      // its independently selected observation, never absence from history.
      if (!unit.consumption && !context.selected.groups.some(group => group.items.includes(unit.item))) return { kind: 'excluded', reason: 'omitted' }
      return finish(declaration, unitBasis(unit), unitEvidence(unit, fact), unit.extent)
    }
    if (fact.type === 'job/status') {
      if (fact.jobStatus === 'running') return { kind: 'excluded', reason: 'open' }
      if (!fact.jobId || !fact.resultRevision || !['completed', 'killed', 'error'].includes(fact.jobStatus!)) return refused('unsupported-history')
      const bound = evidenceGuard([fact.index]) ?? extentGuard(declaration.extent); if (bound) return bound
      const at = resultAt(fact)
      return finish(declaration, { kind: 'selected-observation', unit: { kind: 'job', at, closedAt: at } }, [at])
    }
    if (fact.type === 'subagent/end') {
      if (fact.taskOutcome === 'recovery-required') return { kind: 'excluded', reason: 'unresolved' }
      const starts = facts.filter(value => value.type === 'subagent/start' && value.taskId === fact.taskId && value.index < fact.index)
      if (starts.length > 1) return refused('ambiguous')
      if (starts.length !== 1 || !fact.resultRevision || !['completed', 'error', 'cancelled'].includes(fact.taskOutcome!)) return refused('unsupported-history')
      const denied = evidenceGuard([starts[0]!.index, fact.index]) ?? extentGuard(declaration.extent)
      if (denied) return denied
      const at = resultAt(starts[0]!), closedAt = resultAt(fact)
      return finish(declaration, { kind: 'selected-observation', unit: { kind: 'subagent', at, closedAt } }, [at, closedAt])
    }
    return refused('unsupported-history')
  }
  function* declarations(): Generator<ResultDeclaration> {
    const manifest = facts.find(fact => fact.type === 'conversation/seed-manifest')
    // Path A first, in original observation order; extra typed declarations
    // follow and cannot revoke a covered address because the ref is identical.
    const all: ResultDeclaration[] = []
    for (const fact of facts) {
      const extent = context.source.turns.extents.get(fact.index)!
      for (const observation of fact.resultDeclarations ?? []) all.push({ fact, original: { kind: 'local', sessionId: context.owner.sourceSessionId, seq: fact.seq!, ...observation.address }, extent, protocol: 'managed', ref: observation.ref, use: observation.use, represented: ledger.represented.get(fact.index) })
      if (fact.legacyResult) all.push({ fact, original: { kind: 'local', sessionId: context.owner.sourceSessionId, seq: fact.seq!, event: 'context/result-ref', slot: 'ref' }, extent, protocol: 'legacy', ref: fact.legacyResult })
      for (const [item, descriptor] of (fact.seedItems ?? []).entries()) for (const use of descriptor.resultUses) {
        const ref = manifest?.seedArtifacts?.[use.artifact]
        if (!ref) throw new TypeError('unsupported-history')
        all.push({ fact, original: { kind: 'seed-use', sessionId: context.owner.sourceSessionId, seq: fact.seq!, event: 'conversation/seed-group', item, result: use.result, slot: use.slot },
          extent: descriptor.extent, protocol: 'managed', ref, use: use.use, represented: ledger.seedUses.get(`${fact.index}:${item}`) })
      }
    }
    yield* all.filter(value => value.protocol === 'managed' && value.represented)
    yield* all.filter(value => !(value.protocol === 'managed' && value.represented))
  }
  return { classify, declarations, extentGuard, inheritedCutGuard, visibility, upper }
}
