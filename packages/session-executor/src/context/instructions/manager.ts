import { resolve } from 'node:path'
import type { AuthorityState } from '@i-harness/sandbox'
import type { InstructionTarget, InstructionSnapshot } from '@i-harness/instructions'
import type { SessionRequestContext, InstructionRequestEvidence, SuccessfulInstructionHandoff } from '@i-harness/core-agent'
import type { InstructionEnvironment } from './contracts.ts'
import { instructionView, type InstructionView } from './views.ts'
import { classifyInstructionTarget, contained, instructionTargetKey, orderedInstructionTargets } from './targets.ts'

type Evidence = { view: InstructionView; authority: string; policy: string; snapshot: InstructionSnapshot; selection: number }
const unavailable = () => Object.assign(new Error('Observed instructions unavailable'), { code: 'CONTEXT_INPUT_STALE' })

export function createMainInstructionManager(options: { environment: InstructionEnvironment; cwd: string; authority: () => AuthorityState; available: () => boolean; publish: (signal: AbortSignal | undefined, retain: () => import('@i-harness/core-agent').RequestContextPin) => Promise<void> }) {
  const tokens = new WeakMap<InstructionRequestEvidence, Evidence>(), views = new Set<InstructionView>()
  const cleanupDebt = new Set<InstructionView>()
  let closed = false, text = '', key: string | undefined, active: InstructionView | undefined, token: InstructionRequestEvidence | undefined
  let selection = 0, pending: Map<string, InstructionTarget> | undefined, consumed = new Map<string, InstructionTarget>(), mappingUnavailable = false
  const retire = async (view: InstructionView) => {
    try { await view.retire(); cleanupDebt.delete(view); if (view.finished) views.delete(view) }
    catch (error) { cleanupDebt.add(view); throw error }
  }
  const authority = () => {
    if (closed || !options.available()) throw unavailable()
    const state = options.authority()
    if (state.kind === 'revoked' || state.kind === 'unavailable') throw unavailable()
    const roots = state.kind === 'bound' ? state.roots : [state.workspaceRoot]
    if (!roots.some(root => contained(root, options.cwd))) throw unavailable()
    return { roots, identity: JSON.stringify([state.revision, roots]) }
  }
  const current = (candidate: InstructionRequestEvidence | undefined) => {
    if (!candidate || closed || cleanupDebt.size) return false
    const evidence = tokens.get(candidate), policy = options.environment.policy.current()
    if (!evidence || policy.kind !== 'ready' || policy.generation !== evidence.policy) return false
    try {
      if (authority().identity !== evidence.authority) return false
      const now = evidence.view.service.snapshot()
      return now.complete && now.reliability === 'ready' && now.fingerprint === evidence.snapshot.fingerprint
        && JSON.stringify(now.candidates) === JSON.stringify(evidence.snapshot.candidates) && JSON.stringify(now.applicable) === JSON.stringify(evidence.snapshot.applicable)
    } catch { return false }
  }
  const context: SessionRequestContext = {
    async reconcile(signal) {
      signal?.throwIfAborted()
      for (const view of cleanupDebt) await retire(view)
      await options.environment.policy.ready()
      const policy = options.environment.policy.current(), scope = authority()
      if (policy.kind !== 'ready' || mappingUnavailable) throw unavailable()
      const targets = orderedInstructionTargets(pending ?? consumed)
      const capturedSelection = selection
      const nextKey = JSON.stringify([scope.identity, policy.generation, targets])
      let view = active
      if (!view || key !== nextKey) {
        view = instructionView(options.environment.host.create({ cwd: options.cwd, roots: scope.roots, ...policy.policy }))
        views.add(view)
      }
      try {
        const snapshot = await view.service.prepare([{ path: options.cwd, kind: 'directory' }, ...targets])
        signal?.throwIfAborted()
        if (options.environment.policy.current().generation !== policy.generation || authority().identity !== scope.identity || !snapshot.complete || snapshot.reliability !== 'ready') throw unavailable()
        const previousText = text
        text = snapshot.text
        const preparedView = view
        try { await options.publish(signal, () => preparedView.retain()) }
        catch (error) { text = previousText; throw error }
        if (options.environment.policy.current().generation !== policy.generation || authority().identity !== scope.identity || view.service.snapshot().fingerprint !== snapshot.fingerprint || view.service.snapshot().reliability !== 'ready') throw unavailable()
        const previous = active
        active = view; key = nextKey
        token = Object.freeze({ kind: 'instruction-request', version: 1 })
        tokens.set(token, { view, authority: scope.identity, policy: policy.generation, snapshot, selection: capturedSelection })
        if (previous && previous !== view) await retire(previous)
        for (const retained of views) if (retained.finished) views.delete(retained)
      } catch (error) {
        if (view !== active) try { await retire(view) }
        catch (saving) { throw new AggregateError([error, saving], 'Instruction preparation and original cleanup failed', { cause: error }) }
        throw error
      }
    },
    capture: () => token && tokens.get(token)?.selection === selection && !cleanupDebt.size ? token : undefined,
    current,
    retain(candidate) {
      const evidence = tokens.get(candidate)
      if (!evidence || closed) throw unavailable()
      return evidence.view.retain()
    },
    succeeded(handoff: SuccessfulInstructionHandoff) {
      const evidence = tokens.get(handoff.evidence)
      if (!evidence || handoff.candidate.instructions !== handoff.evidence) throw new TypeError('Unknown instruction evidence')
      if (pending && evidence.selection === selection) { consumed = pending; pending = undefined }
    },
    promotedHumanRequest() { if (pending || consumed.size || mappingUnavailable) { pending = undefined; consumed = new Map(); mappingUnavailable = false; selection++ } },
    async close() {
      closed = true
      const results = await Promise.allSettled([...views].map(async view => { await view.close(); views.delete(view); cleanupDebt.delete(view) }))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Instruction manager cleanup incomplete')
    },
  }
  return Object.assign(context, { text: () => text, async observe(target: InstructionTarget) {
    let scope: ReturnType<typeof authority>
    try { scope = authority() } catch { mappingUnavailable = true; return { status: 'unavailable' as const, reason: 'mapping-unavailable' as const } }
    const captured = scope.identity, classified = await classifyInstructionTarget(target, scope.roots)
    if (classified.status === 'reference-only') return classified
    let stillAuthorized = false
    try { stillAuthorized = authority().identity === captured } catch { /* Preserve mapping uncertainty after revocation. */ }
    if (classified.status === 'unavailable' || !stillAuthorized) { mappingUnavailable = true; selection++; return { status: 'unavailable' as const, reason: 'mapping-unavailable' as const } }
    const path = resolve(target.path)
    const id = instructionTargetKey(target)
    if (!pending && consumed.has(id)) return classified
    if (!pending) { pending = new Map(); selection++ }
    if (!pending.has(id)) { pending.set(id, consumed.get(id) ?? Object.freeze({ path, kind: target.kind })); selection++ }
    return classified
  } })
}
