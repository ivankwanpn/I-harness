import { resolve } from 'node:path'
import type { AuthorityState } from '@i-harness/sandbox'
import { resolveInstructionCanonical, type InstructionTarget, type InstructionSnapshot, type OwnedInstructionWrite } from '@i-harness/instructions'
import type { SessionRequestContext, InstructionRequestEvidence, SuccessfulInstructionHandoff } from '@i-harness/core-agent'
import { captureLegacyFact, type SessionView } from '@i-harness/core-session'
import { capturedToolRegistry, instructionReplan, isInstructionReplan, isOriginalInstructionCellRequest, type AcceptedInstructionBatch, type AcceptedInstructionCall, type CapturedToolCall, type InstructionBatchEntry, type InstructionCellLease, type NativeMutation, type NativeBoundary } from '@i-harness/core-tools'
import type { InstructionEnvironment } from './contracts.ts'
import { instructionView, type InstructionView } from './views.ts'
import { classifyInstructionTarget, contained, instructionTargetKey, orderedInstructionTargets } from './targets.ts'
import type { InstructionPublication, InstructionReport } from './diagnostics.ts'

type Evidence = { view: InstructionView; authority: string; policy: string; snapshot: InstructionSnapshot; selection: number }
const acceptedOrigins = new WeakMap<AcceptedInstructionCall, { capture: CapturedToolCall; current(): boolean; retainCell?(cellId: string): InstructionCellLease }> ()
/** Read-only validation of a handle minted by its original accepted batch. */
export function isOriginalAcceptedInstructionOrigin(origin: AcceptedInstructionCall, capture: CapturedToolCall): boolean {
  const entry = origin && acceptedOrigins.get(origin)
  return !!entry && entry.capture === capture && entry.current()
}
export function retainOriginalInstructionCell(origin: AcceptedInstructionCall, capture: CapturedToolCall, cellId: string, request: object): InstructionCellLease | undefined {
  const entry = origin && acceptedOrigins.get(origin)
  if (!entry || entry.capture !== capture || !entry.current() || !entry.retainCell || !isOriginalInstructionCellRequest(request, origin, capture, cellId)) return undefined
  return entry.retainCell(cellId)
}
const unavailable = () => Object.assign(new Error('Observed instructions unavailable'), { code: 'CONTEXT_INPUT_STALE' })
function captureMethod<T extends (...args: any[]) => any>(owner: object, name: string): T {
  for (let object: object | null = owner; object; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name)
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') break
      return descriptor.value.bind(owner) as T
    }
  }
  throw new TypeError(`Invalid ${name} capability`)
}

export function createMainInstructionManager(options: { session?: SessionView; environment: InstructionEnvironment; cwd: string; authority: () => AuthorityState; available: () => boolean; publish: (signal: AbortSignal | undefined, retain: () => import('@i-harness/core-agent').RequestContextPin) => Promise<void> }) {
  const tokens = new WeakMap<InstructionRequestEvidence, Evidence>(), views = new Set<InstructionView>()
  const cleanupDebt = new Set<InstructionView>()
  const outstanding = new Set<{ requested: boolean; release(): Promise<void> }>()
  let closed = false, text = '', key: string | undefined, active: InstructionView | undefined, token: InstructionRequestEvidence | undefined
  let published: InstructionPublication | undefined, publishedAuthority: string | undefined, diagnosticStale = false, reconciling = 0, unsubscribeView: (() => void) | undefined
  let publishedSelection: number | undefined
  const diagnosticListeners = new Set<() => void>()
  let notificationPending = false
  const changed = () => { if (notificationPending) return; notificationPending = true; queueMicrotask(() => { notificationPending = false; for (const listener of [...diagnosticListeners]) try { listener() } catch { /* Diagnostics do not change source authority. */ } }) }
  const invalidateDiagnostics = () => { diagnosticStale = true; changed() }
  const unsubscribePolicy = options.environment.policy.subscribe(invalidateDiagnostics)
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
    return { roots, revision: state.revision, identity: JSON.stringify([state.revision, roots]) }
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
  const readDiagnostic = (): InstructionReport => {
    if (closed) return Object.freeze({ state: 'revoked' as const })
    try { if (publishedAuthority && authority().identity !== publishedAuthority) return Object.freeze({ state: 'revoked' as const }); if (!publishedAuthority) authority() } catch { return Object.freeze({ state: 'revoked' as const }) }
    let policy: ReturnType<InstructionEnvironment['policy']['current']>
    try { policy = options.environment.policy.current() } catch { return Object.freeze({ state: 'unavailable' as const, ...(published ? { publication: published } : {}) }) }
    const effectivePolicy = policy.kind === 'ready' ? Object.freeze({ generation: policy.generation, enabled: policy.policy.enabled, maxBytes: policy.policy.maxBytes }) : undefined
    if (!published) return Object.freeze({ state: policy.kind !== 'ready' ? 'unavailable' as const : reconciling ? 'pending' as const : 'not-published' as const, ...(effectivePolicy ? { effectivePolicy } : {}) })
    let state: InstructionReport['state'] = reconciling ? 'pending' : diagnosticStale || publishedSelection !== selection || !current(token) ? 'stale' : 'ready'
    try { if (policy.kind !== 'ready' || active && active.service.snapshot().reliability === 'unavailable') state = 'unavailable' } catch { state = 'unavailable' }
    return Object.freeze({ state, publication: published, ...(effectivePolicy ? { effectivePolicy } : {}) })
  }
  const context: SessionRequestContext = {
    async reconcile(signal) {
      reconciling++; changed()
      try {
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
        published = Object.freeze({ fingerprint: snapshot.fingerprint, sourceRevision: snapshot.revision, policyGeneration: policy.generation, authorityRevision: scope.revision,
          enabled: policy.policy.enabled, maxBytes: policy.policy.maxBytes, bytes: snapshot.bytes,
          scope: Object.freeze({ cwd: options.cwd, roots: Object.freeze([...scope.roots]) }),
          sources: Object.freeze(snapshot.sources.map(source => Object.freeze({ ...source }))) })
        publishedAuthority = scope.identity
        publishedSelection = capturedSelection
        if (previous !== view) { unsubscribeView?.(); unsubscribeView = view.service.subscribe(invalidateDiagnostics) }
        diagnosticStale = capturedSelection !== selection; changed()
        if (previous && previous !== view) await retire(previous)
        for (const retained of views) if (retained.finished) views.delete(retained)
      } catch (error) {
        if (view !== active) try { await retire(view) }
        catch (saving) { throw new AggregateError([error, saving], 'Instruction preparation and original cleanup failed', { cause: error }) }
        throw error
      }
      } finally { reconciling--; changed() }
    },
    capture: () => token && tokens.get(token)?.selection === selection && !cleanupDebt.size ? token : undefined,
    current,
    retain(candidate) {
      const evidence = tokens.get(candidate)
      if (!evidence || closed) throw unavailable()
      return evidence.view.retain()
    },
    succeeded(handoff: SuccessfulInstructionHandoff) {
      const candidateEvidence = tokens.get(handoff.evidence)
      if (!candidateEvidence || handoff.candidate.instructions !== handoff.evidence) throw new TypeError('Unknown instruction evidence')
      const evidence: Evidence = candidateEvidence
      if (!options.session) { if (pending && evidence.selection === selection) { consumed = pending; pending = undefined }; return undefined } // Explicitly unmounted controlled contexts have no accepted-call owner.
      const session = options.session, accepted = session.events[handoff.acceptedSeq], receipt = handoff.physicalExecutionReceipt
      if (closed || !accepted || accepted.type !== 'model/exchange-accepted' || accepted.seq !== handoff.acceptedSeq || accepted.actionId !== receipt.actionId || accepted.attemptId !== receipt.attemptId || !['committed', 'memory-committed'].includes(handoff.outcome?.kind) || !Array.isArray(handoff.outcome.seqs) || !handoff.outcome.seqs.includes(handoff.acceptedSeq) || !Array.isArray(handoff.calls) || accepted.callSeqs.length !== handoff.calls.length) throw new TypeError('Invalid accepted instruction exchange')
      const copied = captureLegacyFact(handoff.calls)
      if (copied.kind !== 'captured') throw new TypeError('Invalid accepted call data')
      const calls = copied.value
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index]!, event = call.eventSeq === undefined ? undefined : session.events[call.eventSeq]
        if (!event || event.type !== 'tool/call' || accepted.callSeqs[index] !== call.eventSeq || event.seq !== call.eventSeq || event.callId !== call.callId || event.name !== call.call.name || JSON.stringify(event.args) !== JSON.stringify(call.call.args)) throw new TypeError('Accepted call identity mismatch')
      }
      const pin = evidence.view.retain(), bindings = new Map<number, { capture: CapturedToolCall; origin: AcceptedInstructionCall }>()
      let released = false, preflightStarted = false, flight: Promise<void> | undefined
      const owner = { requested: false, release() {
        owner.requested = true
        if (released) return Promise.resolve()
        if (flight) return flight
        flight = pin.release().then(() => { released = true; outstanding.delete(owner) }, error => { flight = undefined; throw error })
        return flight
      } }
      outstanding.add(owner)
      if (pending && evidence.selection === selection) { consumed = pending; pending = undefined }
      async function preflightCore(entries: readonly InstructionBatchEntry[], currentOwner: () => boolean, owns: (entry: InstructionBatchEntry) => boolean, signal?: AbortSignal) {
          const selected = entries.map(entry => {
            if (capturedToolRegistry(entry.capture) !== entry.registry || !owns(entry)) throw new Error('Foreign accepted call')
            const inspect = captureMethod<typeof entry.registry.inspectCapture>(entry.registry, 'inspectCapture')
            const install = captureMethod<typeof entry.registry.bindNativeInstructions>(entry.registry, 'bindNativeInstructions')
            return { ...entry, inspection: inspect(entry.capture), install }
          })
          const mutations = selected.flatMap((entry, ownerIndex) => (entry.inspection.native?.targets ?? []).filter(target => target.mode === 'mutate').map(target => ({ ownerIndex, target })))
          const fail = (reason: 'unseen-rules' | 'changed-dependency' | 'unavailable' | 'mixed-mutation' | 'revoked', splitRequired = false) => instructionReplan({ code: 'INSTRUCTIONS_REPLAN_REQUIRED', reason, currentFingerprint: evidence.view.service.snapshot().fingerprint, ...(splitRequired ? { splitRequired: true as const } : {}) })
          const check = () => {
            try {
              const before = options.environment.policy.current()
              if (!currentOwner() || before.kind !== 'ready' || before.generation !== evidence.policy || authority().identity !== evidence.authority) throw fail('revoked')
              const after = options.environment.policy.current()
              if (!currentOwner() || after.kind !== 'ready' || after.generation !== evidence.policy) throw fail('revoked')
            } catch (error) { if (isInstructionReplan(error)) throw error; throw fail('revoked') }
          }
          signal?.throwIfAborted(); check()
          if (!mutations.length) return
          // Retain target selection before any asynchronous resolver work so a
          // rejected batch still informs the next normal request.
          for (const { target } of mutations) {
            const value: InstructionTarget = { path: target.path, kind: target.kind }, id = instructionTargetKey(value)
            if (!pending && consumed.has(id)) continue
            if (!pending) { pending = new Map(); selection++ }
            if (!pending.has(id)) { pending.set(id, Object.freeze(value)); selection++; invalidateDiagnostics() }
          }
          try {
            signal?.throwIfAborted(); check()
            const targets = mutations.map(({ target }) => ({ path: target.path, kind: target.kind }))
            await evidence.view.service.prepare(targets)
            signal?.throwIfAborted(); check()
            const canonical = await Promise.all(mutations.map(({ target }) => resolveInstructionCanonical(target.path)))
            signal?.throwIfAborted(); check()
            const normalized = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
            const snapshot = evidence.view.service.snapshot()
            const candidates = snapshot.candidates.flatMap(candidate => candidate.canonicalPath ? [normalized(candidate.canonicalPath)] : [])
            for (let i = 0; i < mutations.length; i++) for (let j = i + 1; j < mutations.length; j++) {
              if (normalized(canonical[i]!) === normalized(canonical[j]!)) throw fail('mixed-mutation', true)
              for (const [candidateIndex, otherIndex] of [[i, j], [j, i]] as const) {
                if (!candidates.includes(normalized(canonical[candidateIndex]!))) continue
                const relation = evidence.view.service.relation(canonical[candidateIndex]!, mutations[otherIndex]!.target)
                if (relation !== 'independent') throw fail('mixed-mutation', true)
              }
            }
            let admitted = false
            const installations: { entry: typeof selected[number]; authority: NativeMutation }[] = []
            for (let index = 0; index < selected.length; index++) {
              const entry = selected[index]!, local = mutations.map((item, ordinal) => ({ ...item, canonical: canonical[ordinal]! })).filter(item => item.ownerIndex === index)
              if (!local.length) continue
              const proof = evidence.view.service.proveApplicable(evidence.snapshot, local.map(item => ({ path: item.target.path, kind: item.target.kind })))
              const candidatePaths = local.filter(item => candidates.includes(normalized(item.canonical))).map(item => item.canonical)
              let own: OwnedInstructionWrite | undefined
              const assertCurrent = () => { if (!admitted) throw fail('unavailable'); check(); try { evidence.view.service.assertApplicable(proof, own) } catch { throw fail('changed-dependency') } }
              const authority: NativeMutation = Object.freeze({
                assertCurrent,
                before(boundary: NativeBoundary) {
                  assertCurrent()
                  const candidate = local.find(item => item.target.path === boundary.target && candidates.includes(normalized(item.canonical)))
                  if (candidate && !own) {
                    try { own = evidence.view.service.beginOwnedWrite(proof, candidatePaths); assertCurrent() }
                    catch (error) { if (isInstructionReplan(error)) throw error; throw fail('changed-dependency') }
                  }
                },
                settle() { if (own) { evidence.view.service.settleOwnedWrite(own); own = undefined } },
              })
              installations.push({ entry, authority })
            }
            check()
            for (const { entry, authority } of installations) entry.install(entry.capture, entry.origin, authority)
            admitted = true
          } catch (error) {
            if (signal?.aborted || isInstructionReplan(error)) throw error
            throw fail('unseen-rules')
          }
      }
      function retainCell(cellId: string): InstructionCellLease {
        if (closed || released || owner.requested || typeof cellId !== 'string' || !cellId) throw new Error('Original accepted cell unavailable')
        const cellPin = evidence.view.retain(), cellBindings = new Map<string, { capture: CapturedToolCall; origin: AcceptedInstructionCall }>()
        let cellReleased = false, cellFlight: Promise<void> | undefined
        const cellOwner = { requested: false, release() {
          cellOwner.requested = true
          if (cellReleased) return Promise.resolve()
          if (cellFlight) return cellFlight
          cellFlight = cellPin.release().then(() => { cellReleased = true; outstanding.delete(cellOwner) }, error => { cellFlight = undefined; throw error })
          return cellFlight
        } }
        outstanding.add(cellOwner)
        const currentCell = () => !closed && !cellReleased && !cellOwner.requested
        return Object.freeze({
          bind(invocationId: string, capture: CapturedToolCall) {
            if (!currentCell() || typeof invocationId !== 'string' || !invocationId || cellBindings.has(invocationId)) throw new Error('Instruction invocation unavailable')
            const registry = capturedToolRegistry(capture), inspect = captureMethod<typeof registry.inspectCapture>(registry, 'inspectCapture'), inspected = inspect(capture)
            const seq = inspected.identity.callEventSeq, event = seq === undefined ? undefined : session.events[seq]
            if (inspected.identity.session !== session || inspected.identity.callId !== invocationId || !event || event.type !== 'code/call' || event.seq !== seq || event.cellId !== cellId || event.callId !== invocationId || event.name !== inspected.call.name || JSON.stringify(event.args) !== JSON.stringify(inspected.call.args)) throw new Error('Instruction invocation identity mismatch')
            const origin: AcceptedInstructionCall = Object.freeze({ kind: 'accepted-instruction-call' })
            cellBindings.set(invocationId, { capture, origin })
            acceptedOrigins.set(origin, { capture, current: () => currentCell() && cellBindings.get(invocationId)?.origin === origin })
            return origin
          },
          async preflight(entries: readonly InstructionBatchEntry[], signal?: AbortSignal) {
            if (!currentCell() || new Set(entries.map(entry => entry.origin)).size !== entries.length || new Set(entries.map(entry => entry.capture)).size !== entries.length) throw new Error('Instruction cell unavailable')
            await preflightCore(entries, currentCell, entry => [...cellBindings.values()].some(binding => binding.capture === entry.capture && binding.origin === entry.origin), signal)
          },
          release: cellOwner.release,
        })
      }
      const batch: AcceptedInstructionBatch = Object.freeze({
        bind(index: number, capture: CapturedToolCall) {
          if (closed || released || owner.requested || !Number.isSafeInteger(index) || index < 0 || index >= calls.length) throw new Error('Accepted instruction batch unavailable')
          const prior = bindings.get(index)
          if (prior) { if (prior.capture !== capture) throw new Error('Accepted call already bound'); return prior.origin }
          if (preflightStarted) throw new Error('Accepted instruction batch admission closed')
          const descriptor = calls[index]!, registry = capturedToolRegistry(capture)
          const inspect = captureMethod<typeof registry.inspectCapture>(registry, 'inspectCapture'), inspected = inspect(capture)
          if (inspected.identity.session !== session || inspected.identity.callId !== descriptor.callId || inspected.identity.callEventSeq !== descriptor.eventSeq || JSON.stringify(inspected.call) !== JSON.stringify(descriptor.call)) throw new Error('Captured call does not match accepted call')
          const origin: AcceptedInstructionCall = Object.freeze({ kind: 'accepted-instruction-call' })
          bindings.set(index, { capture, origin })
          acceptedOrigins.set(origin, { capture, current: () => !closed && !released && !owner.requested && bindings.get(index)?.origin === origin, ...(descriptor.call.name === 'code_exec' ? { retainCell } : {}) })
          return origin
        },
        async preflight(entries: readonly InstructionBatchEntry[], signal?: AbortSignal) {
          if (closed || released || owner.requested || preflightStarted) throw new Error('Accepted instruction batch unavailable')
          preflightStarted = true
          if (entries.length !== bindings.size || new Set(entries.map(entry => entry.origin)).size !== entries.length || new Set(entries.map(entry => entry.capture)).size !== entries.length) throw new Error('Incomplete accepted call set')
          await preflightCore(entries, () => !closed && !released && !owner.requested, entry => [...bindings.values()].some(binding => binding.capture === entry.capture && binding.origin === entry.origin), signal)
        },
        release: owner.release,
      })
      return batch
    },
    promotedHumanRequest() { if (pending || consumed.size || mappingUnavailable) { pending = undefined; consumed = new Map(); mappingUnavailable = false; selection++; invalidateDiagnostics() } },
    async close() {
      closed = true
      unsubscribePolicy(); unsubscribeView?.(); unsubscribeView = undefined; changed()
      const releases = await Promise.allSettled([...outstanding].filter(owner => owner.requested).map(owner => owner.release()))
      const results = await Promise.allSettled([...views].map(async view => { await view.close(); views.delete(view); cleanupDebt.delete(view) }))
      const failures = [...releases, ...results].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Instruction manager cleanup incomplete')
    },
  }
  return Object.assign(context, { text: () => text, diagnostics: Object.freeze({
    read: readDiagnostic,
    subscribe(listener: () => void) { if (closed) return () => {}; diagnosticListeners.add(listener); return () => { diagnosticListeners.delete(listener) } },
    invalidate: invalidateDiagnostics,
    async refresh(signal?: AbortSignal): Promise<InstructionReport> { if (closed || reconciling || !active) return readDiagnostic(); active.service.invalidate(); await context.reconcile(signal); return readDiagnostic() },
  }), async observe(target: InstructionTarget) {
    let scope: ReturnType<typeof authority>
    try { scope = authority() } catch { mappingUnavailable = true; invalidateDiagnostics(); return { status: 'unavailable' as const, reason: 'mapping-unavailable' as const } }
    const captured = scope.identity, classified = await classifyInstructionTarget(target, scope.roots)
    if (classified.status === 'reference-only') return classified
    let stillAuthorized = false
    try { stillAuthorized = authority().identity === captured } catch { /* Preserve mapping uncertainty after revocation. */ }
    if (classified.status === 'unavailable' || !stillAuthorized) { mappingUnavailable = true; selection++; invalidateDiagnostics(); return { status: 'unavailable' as const, reason: 'mapping-unavailable' as const } }
    const path = resolve(target.path)
    const id = instructionTargetKey(target)
    if (!pending && consumed.has(id)) return classified
    if (!pending) { pending = new Map(); selection++ }
    if (!pending.has(id)) { pending.set(id, consumed.get(id) ?? Object.freeze({ path, kind: target.kind })); selection++; invalidateDiagnostics() }
    return classified
  } })
}
export type InstructionDiagnostics = ReturnType<typeof createMainInstructionManager>['diagnostics']
