import { randomUUID } from 'node:crypto'
import type { ContextReductionPorts, ReductionAttempts, ReductionBlockedReason, ReductionGroup, ReductionPolicy, ReductionResult, ReductionRunOptions, ReductionRewrite } from './contracts.ts'
import { reductionGroups, selectReductionRuns } from './selection.ts'
import { reductionProgress, replacementProposal } from './proposal.ts'
import { pruneProposal } from './prune.ts'
import { projectionFingerprint } from '@i-harness/token-meter'

const initial = (): ReductionResult => ({ compacted: false, shadowedSeqs: [], outcome: 'unchanged', publication: 'none' })
const block = (result: ReductionResult, blockedReason: ReductionBlockedReason): ReductionResult => ({ ...result, outcome: 'blocked', blockedReason,
  ...(blockedReason === 'summary-failed' ? { reason: 'summarizer-failed' as const } : {}) })
const stale = (attempts: ReductionAttempts) => ++attempts.staleRebuilds <= 3
function captureSource(ports: ContextReductionPorts) {
  try { return { snapshot: ports.capture() } }
  catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'CONTEXT_SNAPSHOT_UNSUPPORTED' || code === 'CONTEXT_STATE_AMBIGUOUS') return { reason: code === 'CONTEXT_SNAPSHOT_UNSUPPORTED' ? 'opaque' as const : 'source-unrepresentable' as const }
    throw error
  }
}
function applied(result: ReductionResult, groups: readonly ReductionGroup[], rewrites: readonly ReductionRewrite[], kind: 'committed' | 'nondurable'): ReductionResult {
  return { ...result, compacted: true, publication: kind, outcome: 'reduced-over-target',
    shadowedSeqs: [...new Set([...result.shadowedSeqs, ...rewrites.some(rewrite => rewrite.type !== 'compaction/prune') ? groups.flatMap(group => group.coverage.flatMap(covered => covered.sources.map(ref => ref.seq))) : []])],
    ...(rewrites.some(rewrite => rewrite.type === 'compaction/prune') ? { pruned: true } : {}),
    ...(rewrites.some(rewrite => rewrite.type === 'compaction/reset') ? { reset: true } : {}),
    ...(() => { const replacement = rewrites.find(rewrite => rewrite.type === 'compaction/replacement'); return replacement ? { summary: replacement.text } : {} })() }
}
/** One finite transaction driver for manual, auto and confirmed recovery. */
export async function reduceContext(ports: ContextReductionPorts, policy: ReductionPolicy, options: ReductionRunOptions = {}, instructions?: string): Promise<ReductionResult> {
  const attempts = options.attempts ?? { count: 0, staleRebuilds: 0 }, tried = new Set<string>()
  let result = initial(), accepted: { source: ReturnType<typeof ports.capture>; groups: readonly ReductionGroup[]; text: string } | undefined
  while (true) {
    options.signal?.throwIfAborted()
    const captured = captureSource(ports)
    if ('reason' in captured) return block(result, captured.reason!)
    const source = captured.snapshot
    let baseline = await ports.prepare(source, [], [])
    if (baseline.kind === 'stale') { if (stale(attempts)) continue; return block(result, 'unstable-input') }
    if (baseline.kind === 'blocked') return block(result, baseline.reason)
    if (options.reason === 'auto' && baseline.target === 'ready' || result.compacted && baseline.target === 'ready') return { ...result, outcome: 'ready' }
    if (baseline.capacityFit === 'unavailable' || baseline.target === 'unavailable') return block(result, 'capacity-unavailable')
    if (baseline.fixedInput) return block(result, 'fixed-input')
    if (accepted && !ports.current(accepted.source, accepted.groups)) accepted = undefined
    const run = accepted ? { id: projectionFingerprint(accepted.groups.map(group => group.id)), groups: accepted.groups }
      : selectReductionRuns(source, policy, options.protectedSeqs).find(run => !tried.has(run.id))
    if (!run) return result.compacted ? result : block(result, tried.size ? 'no-progress' : 'no-eligible-source')
    let rewrites = pruneProposal(source, run, policy), candidate = rewrites.length ? await ports.prepare(source, run.groups, rewrites) : undefined
    if (candidate?.kind === 'stale') { if (stale(attempts)) continue; return block(result, 'unstable-input') }
    if (candidate?.kind === 'blocked') return block(result, candidate.reason)
    if (candidate?.kind === 'assessed' && candidate.currentView !== baseline.currentView) {
      const before = await ports.prepare(source, [], [])
      if (before.kind === 'stale') { if (stale(attempts)) continue; return block(result, 'unstable-input') }
      if (before.kind === 'blocked') return block(result, before.reason)
      baseline = before
    }
    if (!candidate || candidate.kind !== 'assessed' || candidate.target !== 'ready' || !reductionProgress(baseline, candidate, options.reason === 'recovery')) {
      if (!ports.summary) return block(result, 'summary-unavailable')
      if (attempts.count >= Math.min(8, options.maxSummaryCalls ?? 8)) return block(result, 'call-limit')
      if (!accepted || !ports.current(accepted.source, accepted.groups) || accepted.groups.map(group => group.id).join() !== run.groups.map(group => group.id).join()) {
        let summary
        try { summary = await ports.summary({ snapshot: source, groups: run.groups, coverage: Object.freeze(run.groups.flatMap(group => group.coverage)), attempts,
          instructions, signal: options.signal, maxCalls: Math.min(8, options.maxSummaryCalls ?? 8), current: () => ports.current(source, run.groups) }) }
        catch (error) { if ((error as { code?: string }).code !== 'CONTEXT_INPUT_STALE') throw error; if (stale(attempts)) continue; return block(result, 'unstable-input') }
        if (!ports.current(source, run.groups)) { if (stale(attempts)) continue; return block(result, 'unstable-input') }
        if (summary.kind === 'blocked') return { ...block(result, summary.reason), reason: 'summarizer-failed' }
        if (summary.groupIds.join() !== run.groups.map(group => group.id).join()) return block(result, 'source-unrepresentable')
        accepted = { source, groups: run.groups, text: summary.text }
      }
      rewrites = [...rewrites, replacementProposal(run, accepted.text, randomUUID())]
      candidate = await ports.prepare(source, run.groups, rewrites)
    }
    if (candidate.kind === 'stale') { if (stale(attempts)) continue; return block(result, 'unstable-input') }
    if (candidate.kind === 'blocked') return block(result, candidate.reason)
    if (candidate.currentView !== baseline.currentView) {
      const before = await ports.prepare(source, [], [])
      if (before.kind === 'stale') { if (stale(attempts)) continue; return block(result, 'unstable-input') }
      if (before.kind === 'blocked') return block(result, before.reason)
      baseline = before
    }
    if (!reductionProgress(baseline, candidate, options.reason === 'recovery')) { tried.add(run.id); accepted = undefined; continue }
    const published = await ports.publish(source, run.groups, rewrites, candidate.proof)
    if (published.kind === 'stale') { if (stale(attempts)) continue; return block(result, 'unstable-input') }
    if (published.kind === 'recovery-required') return { ...block(result, 'publication-recovery-required'), publication: 'recovery-required' }
    if (published.kind === 'not-issued') return block(result, 'publication-not-issued')
    result = applied(result, run.groups, rewrites, published.kind); tried.add(run.id); accepted = undefined
    if (candidate.target === 'ready') return { ...result, outcome: 'ready' }
  }
}

/** Explicit-only event-count hint expands to complete groups and protection. */
export async function resetContext(ports: ContextReductionPorts, retainLast: number, options: ReductionRunOptions = {}): Promise<ReductionResult> {
  if (!Number.isSafeInteger(retainLast) || retainLast < 0) throw new Error('Invalid retainLast')
  const captured = captureSource(ports)
  if ('reason' in captured) return block(initial(), captured.reason!)
  const source = captured.snapshot, boundary = source.coordinates.archive.eventCount - retainLast
  const whole = reductionGroups(source, options.protectedSeqs)
  const first = (group: ReductionGroup) => Math.min(...group.items.flatMap(item => [...item.sources, ...item.unit ? [item.unit.source] : []].map(ref => ref.eventIndex)))
  const groups = whole.filter((group,index) => (whole[index+1] ? first(whole[index+1]!) : source.coordinates.archive.eventCount) <= boundary && group.complete && !group.protected
    && group.items.every(item => [...item.sources, ...item.provenance.evidence, ...item.unit ? [item.unit.source] : []].every(ref => ref.eventIndex < boundary)))
  if (!groups.length) return initial()
  const rewrites: ReductionRewrite[] = [{ type: 'compaction/reset', removedSeqs: [...new Set(groups.flatMap(group => group.coverage.flatMap(covered => covered.sources.map(ref => ref.seq))))] }]
  const before = await ports.prepare(source, [], []), after = await ports.prepare(source, groups, rewrites)
  if (before.kind !== 'assessed' || after.kind !== 'assessed') return block(initial(), 'unstable-input')
  if (!reductionProgress(before, after, false)) return block(initial(), 'no-progress')
  const publication = await ports.publish(source, groups, rewrites, after.proof)
  return publication.kind === 'committed' || publication.kind === 'nondurable' ? { ...applied(initial(), groups, rewrites, publication.kind), outcome: after.target === 'ready' ? 'ready' : 'reduced-over-target' }
    : publication.kind === 'recovery-required' ? { ...block(initial(), 'publication-recovery-required'), publication: 'recovery-required' } : block(initial(), 'publication-not-issued')
}
