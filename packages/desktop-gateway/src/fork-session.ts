import { canonicalJsonData, captureBootstrapPreparationFacts } from '@i-harness/core-session'
import { contextSourceIdentity, contextWorkspaceIdentity, type LegacyForkTransferScope } from '@i-harness/context-output'
import { ForkAdmissionError, ForkTargetPolicyDeniedError, type ForkHost, type ForkSourceWitness, type SessionCoordinator } from '@i-harness/session-persistence'
import { createForkSourceWitness } from '../../session-persistence/src/fork-inline-host.ts'
import { associateForkHostCleanupOwner } from '../../session-persistence/src/fork-controller.ts'
import { observationCleanupFor, type ObservationCleanupHandle } from '../../session-persistence/src/coordinator/binding-observation.ts'
import { assertResultLineage, discoverResultLineage, legacyObservationFor } from '../../session-executor/src/lifecycle/result-observation.ts'
import type { createProjectScopeBroker } from './project-scope.ts'
import type { createNativeContextRuntime } from './context-runtime.ts'

/** Source-only held Gateway data; project/B2/L1 owners retain all authority. */
export function createGatewayForkHost(options: {
  workspace: string; coordinator: SessionCoordinator
  projects: ReturnType<typeof createProjectScopeBroker>
  nativeContext: Awaited<ReturnType<typeof createNativeContextRuntime>>
  assertAvailable?(): void
  /** Close the fork target's bootstrap document once the ready target has been
   *  observed. The legacy coordinator refuses an execution attachment while a
   *  document exists, so a forked child could never run its first turn. */
  releaseReadyTarget?: boolean
}): ForkHost {
  const { coordinator, projects, nativeContext } = options
  const cleanupErrors = new WeakMap<object, ObservationCleanupHandle>(), debt = new Map<string, () => Promise<void>>()
  const assertAvailable = () => { options.assertAvailable?.() }
  const same = (a: unknown, b: unknown) => canonicalJsonData(a) === canonicalJsonData(b)
  const host: ForkHost = {
    assertAvailable,
    async resolvePreparation(request, signal) {
      const current = () => { assertAvailable(); if (signal?.aborted) throw new ForkAdmissionError('cancelled') }
      current()
      const ids = await discoverResultLineage(coordinator, request.sourceSessionId, current)
      return coordinator.withExistingSessionBindingObservation!({ sessionIds: ids, ...(signal ? { signal } : {}) }, observation => projects.withBindingObservation(ids, observation, async () => {
        current(); assertResultLineage(observation, ids, request.sourceSessionId)
        const getter = await projects.resultReadScopeFor(request.sourceSessionId)
        if (!getter) throw new ForkAdmissionError('policy')
        const selected = getter(), meta = observation.metadata(request.sourceSessionId)
        current(); observation.assertCurrent()
        return { metadata: { ...(meta.title === undefined ? {} : { title: meta.title }), ...(meta.workspaceId === undefined ? {} : { workspaceId: meta.workspaceId }),
          ...(meta.modelSelection === undefined ? {} : { modelSelection: { ...meta.modelSelection } }), ...request.metadata },
          project: selected.projectId ? { kind: 'project', projectId: selected.projectId } : { kind: 'unassigned' } }
      }))
    },
    async withHandoff(operation, mode, control, use) {
      assertAvailable()
      if (operation.prepared.requestIntent.project.kind === 'unmanaged') throw new ForkAdmissionError('policy')
      const key = canonicalJsonData(operation), previous = debt.get(key)
      if (previous) { await previous(); debt.delete(key) }
      const passive = mode.kind === 'passive', sourceId = operation.prepared.core.sourceSessionId
      const admission = () => { assertAvailable(); if (!passive && control.signal?.aborted) throw new ForkAdmissionError('cancelled') }
      let source: ForkSourceWitness | undefined, ids: string[] = [], coldReader: { close(): Promise<void> } | undefined
      if (!passive) {
        admission()
        if (mode.kind === 'warm') { source = mode.source; source.assertUnchanged() }
        else {
          await coordinator.flush(sourceId); admission()
          const document = await coordinator.openManagedDocument(sourceId)
          if ((document as { view?: unknown }).view !== undefined) source = createForkSourceWitness(document)
          else {
            // A finished turn leaves an execution attachment cached without a
            // session view; read a detached document instead of closing it.
            const reader = await (coordinator as { openReadOnlyManagedDocument?: (id: string) => Promise<{ document: ForkSourceWitness['document']; close(): Promise<void> }> }).openReadOnlyManagedDocument?.(sourceId)
            if (!reader) throw new ForkAdmissionError('unsupported')
            coldReader = reader
            source = createForkSourceWitness(reader.document)
          }
        }
        ids = await discoverResultLineage(coordinator, sourceId, admission)
      }
      admission()
      const location = await contextWorkspaceIdentity(options.workspace)
      if (location.workspaceKey !== nativeContext.workspaceKey) throw new ForkAdmissionError('policy')
      admission()
      let active = true, finished = false, legacy: LegacyForkTransferScope | undefined, legacyClosed = false, legacyCleanupFailed = false
      let observationCleanup: ObservationCleanupHandle | undefined
      const cleanupLegacy = async () => {
        if (legacy && !legacyClosed) {
          try { await nativeContext.contextOutput.closeLegacyForkTransfer(legacy); legacyClosed = true; legacyCleanupFailed = false }
          catch (cause) { legacyCleanupFailed = true; throw cause }
        }
      }
      const cleanup = async () => {
        if (!finished) throw new Error('Gateway fork cleanup cannot join its own callback')
        const original = observationCleanup
        const results = await Promise.allSettled([cleanupLegacy(), ...(original ? [original.retry().then(() => { if (observationCleanup === original) observationCleanup = undefined })] : [])])
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Gateway original fork cleanup unresolved')
        debt.delete(key)
      }
      let failed = false, failure: unknown, result: Awaited<ReturnType<typeof use>> | undefined
      const run = async (observation?: import('@i-harness/session-persistence').ExistingSessionBindingObservation) => {
        let getter: Awaited<ReturnType<typeof projects.resultReadScopeFor>>
        let confirmed = false, manifestDigest: string | undefined
        const assertTargetCurrent = () => { admission(); if (!active) throw new Error('Gateway fork scope retired'); if (confirmed) transfer.targetPreparation.assertTargetCurrent() }
        const assertSourceCurrent = () => {
          admission()
          if (passive || !source || !observation || !active) throw new ForkAdmissionError('cancelled')
          observation.assertCurrent(); assertResultLineage(observation, ids, sourceId); source.assertUnchanged()
          if (getter) {
            const selected = getter(), project = operation.prepared.requestIntent.project
            if (project.kind === 'project' ? selected.projectId !== project.projectId : selected.projectId !== undefined) throw new ForkAdmissionError('policy')
          }
        }
        const transfer = nativeContext.prepareBootstrapTransfer({ invocation: operation.invocation, requestIntent: operation.prepared.requestIntent,
          ...(!passive ? { sourceSessionId: sourceId } : {}), sourceAvailable: () => !passive && active,
          assertNewWorkCurrent: assertSourceCurrent, targetAvailable: () => active }, passive ? undefined : { sessionId: sourceId, ...(control.signal ? { signal: control.signal } : {}) })
        const prepare = async (request: import('@i-harness/session-persistence').BootstrapTargetPreparationRequest, factsInput: import('@i-harness/core-session').BootstrapPreparationFacts | undefined, current?: () => boolean): Promise<import('@i-harness/session-persistence').BootstrapTargetPreparationOutcome> => {
          assertTargetCurrent()
          if (!factsInput) return { kind: 'blocked', reason: 'unavailable' }
          const facts = captureBootstrapPreparationFacts(factsInput)
          if (!same(facts.invocation, operation.invocation) || !same(request.invocation, operation.invocation) || request.manifestDigest !== facts.manifestDigest
            || facts.sourceObservation.kind !== 'semantic' || manifestDigest !== undefined && manifestDigest !== facts.manifestDigest) return { kind: 'blocked', reason: 'conflict' }
          const project = current ? await transfer.targetPreparation.confirm(request, current, facts) : await transfer.targetPreparation.reconcile(request, facts)
          if (project.kind !== 'confirmed') return project
          confirmed = true; manifestDigest = facts.manifestDigest; assertTargetCurrent()
          if (!legacy) {
            const read = source && !passive ? legacyObservationFor(nativeContext.observations.current(sourceId)!) : undefined
            legacy = nativeContext.contextOutput.registerLegacyForkTransfer({ invocation: operation.invocation, sourceSessionId: sourceId,
              semanticSeedDigest: facts.seedDigest, sourceObservationDigest: facts.sourceObservation.digest, selection: operation.prepared.core.selection,
              target: { available: () => active, assertCurrent: assertTargetCurrent, sourceId() { assertTargetCurrent(); return contextSourceIdentity(location.workspaceKey, location.canonical, transfer.targetScope().scope) } },
              ...(source && read ? { source: { view: source.view, read, assertCurrent: assertSourceCurrent } } : {}),
              ...(!passive && control.signal ? { signal: control.signal } : {}) })
          }
          const outcome = current ? await nativeContext.contextOutput.confirmLegacyForkTransfer(legacy, request, current, facts) : await nativeContext.contextOutput.reconcileLegacyForkTransfer(legacy, request, facts)
          assertTargetCurrent(); return outcome
        }
        const body = async () => {
          if (!passive) { getter = await projects.resultReadScopeFor(sourceId); if (!getter) throw new ForkAdmissionError('policy'); assertSourceCurrent() }
          let bodyFailed = false, bodyFailure: unknown, value: Awaited<ReturnType<typeof use>> | undefined
          try { value = await use({ ...(source ? { source } : {}), guards: { assertCurrent: passive ? assertTargetCurrent : assertSourceCurrent,
            ...(!passive && control.signal ? { signal: control.signal } : {}), dependencies: transfer.dependencies,
            targetPreparation: { assertTargetCurrent, confirm: (request, current, facts) => prepare(request, facts, current), reconcile: (request, facts) => prepare(request, facts) } } }) }
          catch (cause) { bodyFailed = true; bodyFailure = cause }
          try { await cleanupLegacy() }
          catch (cause) { throw new AggregateError([...(bodyFailed ? [bodyFailure] : []), cause], 'Gateway original L1 cleanup unresolved') }
          if (bodyFailed) throw bodyFailure
          return value as Awaited<ReturnType<typeof use>>
        }
        try { return await (source && observation ? nativeContext.withResultObservation({ sessionId: sourceId, sessionIds: ids, observation, document: source.document, assertHostCurrent: assertSourceCurrent }, body) : body()) }
        finally { active = false; transfer.close() }
      }
      try { result = await (passive ? run() : coordinator.withExistingSessionBindingObservation!({ sessionIds: ids, ...(control.signal ? { signal: control.signal } : {}) }, run)) }
      catch (cause) { failed = true; failure = cause; observationCleanup = observationCleanupFor(coordinator, cause) }
      active = false; finished = true
      if (coldReader) { const reader = coldReader; coldReader = undefined; await reader.close().catch(() => {}) }
      if (legacyCleanupFailed || observationCleanup) {
        const error = new AggregateError(failed ? [failure] : [], 'Gateway original fork cleanup unresolved')
        debt.set(key, cleanup); cleanupErrors.set(error, Object.freeze({ retry: cleanup })); throw error
      }
      if (failed) throw failure
      return result as Awaited<ReturnType<typeof use>>
    },
    async withReadyTarget(operation, document, use) {
      assertAvailable()
      const id = operation.invocation.targetSessionId
      // The original observer refuses archived acquisition before callback.
      // Classify only this actual target metadata denial; never an I/O error.
      if ((await coordinator.profile(id)).meta.archived) throw new ForkTargetPolicyDeniedError()
      const authority = await projects.authorityFor(id)
      const policy = () => { assertAvailable(); const state = authority(); if (state.kind === 'revoked' || state.kind === 'unavailable') throw new ForkTargetPolicyDeniedError() }
      policy()
      const observe = coordinator.withExistingSessionBindingObservation!({ sessionIds: [id] }, observation => {
        const meta = observation.metadata(id), binding = observation.binding(id), project = operation.prepared.requestIntent.project, seed = meta.semanticSeed
        if (meta.archived || binding.kind !== 'present' || !binding.value || typeof binding.value !== 'object'
          || (binding.value as { projectId?: unknown }).projectId !== (project.kind === 'project' ? project.projectId : undefined)) throw new ForkTargetPolicyDeniedError()
        if (meta.parentSession !== operation.prepared.core.sourceSessionId || meta.origin !== 'fork' || meta.createdAt !== operation.invocation.createdAt
          || seed?.operationId !== operation.invocation.operationId || seed.requestDigest !== operation.invocation.requestDigest || !same(seed, document.view.header?.semanticSeed)) throw new Error('Gateway fork target identity unavailable')
        return nativeContext.withResultObservation({ sessionId: id, sessionIds: [id], observation, document, assertHostCurrent: policy }, async () => { policy(); const result = await use(); policy(); return result })
      })
      try { return await observe }
      finally {
        if (options.releaseReadyTarget) {
          // The fork target is durable; releasing the bootstrap document lets the
          // legacy coordinator attach an execution attachment for its first turn.
          await coordinator.closeManagedDocument?.(id).catch(() => undefined)
        }
      }
    },
  }
  associateForkHostCleanupOwner(coordinator, host, cause => cause !== null && typeof cause === 'object' ? cleanupErrors.get(cause) : undefined)
  return host
}