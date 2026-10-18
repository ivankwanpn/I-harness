import type { ContextSnapshot, ReductionGroup, ReductionRewrite, ContextReductionPorts } from '@i-harness/context-engine'
import type { CapturedActionFact, ProducerFactOutcome } from '@i-harness/core-session'
import type { AgentDeps } from '../types.ts'

/** One optional capture owns exact immutable bytes after issue. No absent retry authority. */
export function createReductionPublication(deps: Pick<AgentDeps, 'captureContextReduction' | 'assertFactOpen' | 'registerFactSource'>, check: (source: ContextSnapshot, groups: readonly ReductionGroup[], rewrites: readonly ReductionRewrite[], proof: object) => boolean,
  softTerminal?: (proof: object) => import('@i-harness/core-session').SoftReductionTerminalDraft | undefined, absent?: () => Promise<void>): ContextReductionPorts['publish'] {
  return async (source, groups, rewrites, proof) => {
    const actionCapture = deps.captureContextReduction
    if (!actionCapture) return { kind: 'not-issued' }
    const current = () => {
      deps.assertFactOpen?.()
      return check(source, groups, rewrites, proof)
    }
    let capture: CapturedActionFact<ProducerFactOutcome>
    try { const terminal = softTerminal?.(proof); capture = actionCapture({ kind: 'context-reduction', events: rewrites, ...(terminal ? { softTerminal: terminal } : {}) }, current) }
    catch { return { kind: 'not-issued' } }
    let latest: ProducerFactOutcome | undefined
    const reconcile = async () => {
      latest = await capture.reconcile()
      if (latest.kind === 'unknown' || latest.kind === 'conflict' || latest.kind === 'recovery-required') throw Object.assign(new Error('Context reduction requires reconciliation'), { code: 'FACT_RECOVERY_REQUIRED' })
      // A local stale precondition never issued a batch; C3 may recapture in
      // the same sequence. Backend-proven absence still cancels original work.
      if (latest.kind === 'absent' || latest.kind === 'not-issued' && latest.code !== 'FACT_PRECONDITION_STALE') await absent?.()
    }
    // This drain may only reconcile the optional capture. Registering it grants no new-work authority.
    const settlement = deps.registerFactSource?.(reconcile)
    try {
      latest = await capture.admit()
      if (latest.kind === 'committed') return { kind: 'committed' }
      if (latest.kind === 'memory-committed') return { kind: 'nondurable' }
      if (latest.kind === 'not-issued') return { kind: latest.code === 'FACT_PRECONDITION_STALE' ? 'stale' : latest.code === 'FACT_RECOVERY_REQUIRED' ? 'recovery-required' : 'not-issued' }
      if (latest.kind === 'absent') return { kind: 'not-issued' }
      return { kind: 'recovery-required' }
    } catch { return { kind: 'recovery-required' } }
    finally { if (latest?.kind === 'committed' || latest?.kind === 'memory-committed' || latest?.kind === 'absent' || latest?.kind === 'not-issued') await settlement?.close() }
  }
}
