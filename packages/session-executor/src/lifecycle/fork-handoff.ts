import { contextSourceIdentity, contextWorkspaceLocation, type LegacyForkTransferScope, type SeedDependencyTransferScope } from '@i-harness/context-output'
import { captureBootstrapPreparationFacts, canonicalJsonData } from '@i-harness/core-session'
import { ForkAdmissionError, ForkTargetPolicyDeniedError, type ForkHost, type ForkSourceWitness, type SessionCoordinator } from '@i-harness/session-persistence'
import { createForkSourceWitness, createInlineForkHost } from '../../../session-persistence/src/fork-inline-host.ts'
import { associateForkHostCleanupOwner } from '../../../session-persistence/src/fork-controller.ts'
import { observationCleanupFor, type ObservationCleanupHandle } from '../../../session-persistence/src/coordinator/binding-observation.ts'
import { acquireResultReadStore } from './result-store.ts'
import { createArtifactCurrentGuard, withImmediateArtifactCurrentChecks } from '../../../session-persistence/src/coordinator/artifact-path-association.ts'
import { assertResultLineage, discoverResultLineage, legacyObservationFor } from './result-observation.ts'

/** CLI composition over the existing reader lease, F0, L1 and managed owners. */
export function createCliForkHost(options: { workspace: string; coordinator: SessionCoordinator; contextOutputSettingsPath?: string; assertAvailable?(): void }): ForkHost {
  const coordinator = options.coordinator, inline = createInlineForkHost(coordinator)
  const debt = new Map<string, () => Promise<void>>()
  const cleanupErrors = new WeakMap<object, ObservationCleanupHandle>()
  const suppliedAvailability = options.assertAvailable
  function assertAvailable() {
    if (suppliedAvailability) withImmediateArtifactCurrentChecks(() => Reflect.apply(suppliedAvailability, options, []))
    inline.assertAvailable()
  }
  const same = (a: unknown, b: unknown) => canonicalJsonData(a) === canonicalJsonData(b)
  const host: ForkHost = {
    assertAvailable,
    async resolvePreparation(request, signal) {
      const assertPreparation = () => { assertAvailable(); if (signal?.aborted) throw new ForkAdmissionError('cancelled') }
      assertPreparation()
      const ids = await discoverResultLineage(coordinator, request.sourceSessionId, assertPreparation)
      return coordinator.withExistingSessionBindingObservation!({ sessionIds: ids, ...(signal ? { signal } : {}) }, async observation => {
        assertAvailable(); assertResultLineage(observation, ids, request.sourceSessionId)
        for (const id of ids) if (observation.binding(id).kind !== 'absent') throw new ForkAdmissionError('policy')
        const meta = observation.metadata(request.sourceSessionId)
        return { metadata: { ...(meta.title === undefined ? {} : { title: meta.title }), ...(meta.workspaceId === undefined ? {} : { workspaceId: meta.workspaceId }),
          ...(meta.modelSelection === undefined ? {} : { modelSelection: { ...meta.modelSelection } }), ...request.metadata }, project: { kind: 'unmanaged' } }
      })
    },
    async withHandoff(operation, mode, control, use) {
      assertAvailable()
      if (operation.prepared.requestIntent.project.kind !== 'unmanaged') throw new ForkAdmissionError('policy')
      const key = canonicalJsonData(operation), priorCleanup = debt.get(key)
      if (priorCleanup) { await priorCleanup(); debt.delete(key) }
      const sourceId = operation.prepared.core.sourceSessionId, passive = mode.kind === 'passive'
      const assertAdmission = () => { assertAvailable(); if (!passive && control.signal?.aborted) throw new ForkAdmissionError('cancelled') }
      let source: ForkSourceWitness | undefined, ids: string[] = []
      if (!passive) {
        assertAdmission()
        if (mode.kind === 'warm') { source = mode.source; source.assertUnchanged() }
        else { await coordinator.flush(sourceId); assertAdmission(); source = createForkSourceWitness(await coordinator.openManagedDocument(sourceId)); assertAdmission() }
        ids = await discoverResultLineage(coordinator, sourceId, assertAdmission)
      }
      assertAdmission()
      if (!coordinator.storageRoot) throw new ForkAdmissionError('unsupported')
      const location = await contextWorkspaceLocation(options.workspace, coordinator.storageRoot)
      assertAdmission()
      const lease = await acquireResultReadStore({ ...options, sessionId: passive ? operation.invocation.targetSessionId : sourceId,
        readCallerAvailable: () => { try { assertAvailable(); return true } catch { return false } } })
      if (!lease.service || !lease.observations) { await lease.release(); throw new ForkAdmissionError('unavailable') }
      const service = lease.service, observations = lease.observations
      const canonicalSource = { sourceId: contextSourceIdentity(location.workspaceKey, location.canonical), readonly: true }
      let legacy: LegacyForkTransferScope | undefined, managed: SeedDependencyTransferScope | undefined
      let active = true, legacyClosed = false, released = false, legacyCleanupFailed = false
      const cleanupLegacy = async () => {
        if (legacy && !legacyClosed) {
          try { await service.closeLegacyForkTransfer(legacy); legacyClosed = true; legacyCleanupFailed = false }
          catch (cause) { legacyCleanupFailed = true; throw cause }
        }
      }
      let callbackFinished = false, observationCleanup: ObservationCleanupHandle | undefined
      const cleanup = async () => {
        if (!callbackFinished) throw new Error('Fork cleanup cannot join its own callback/acquisition')
        // L1 scope drainage and F0 native release are independent only after
        // their original callback ended. The service lease depends on L1.
        const originalObservation = observationCleanup
        const results = await Promise.allSettled([
          cleanupLegacy(),
          ...(originalObservation ? [originalObservation.retry().then(() => { if (observationCleanup === originalObservation) observationCleanup = undefined })] : []),
        ])
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length) throw new AggregateError(failures, 'Fork original cleanup unresolved')
        if (!released) { await lease.release(); released = true }
        debt.delete(key)
      }
      let failed = false, failure: unknown, result: Awaited<ReturnType<typeof use>> | undefined
      try {
        result = await coordinator.withSessionBindingObservation!({ existingSessionIds: ids, target: operation.invocation,
          ...(!passive && control.signal ? { signal: control.signal } : {}) }, async observation => {
          const assertTargetCurrent = createArtifactCurrentGuard(() => {
            assertAvailable(); observation.assertCurrent()
            if (!active || observation.binding(operation.invocation.targetSessionId).kind !== 'absent') throw new ForkTargetPolicyDeniedError()
          })
          const assertSourceCurrent = createArtifactCurrentGuard(() => {
            assertTargetCurrent()
            if (passive || control.signal?.aborted || !source) throw new ForkAdmissionError('cancelled')
            assertResultLineage(observation, ids, sourceId); source.assertUnchanged()
            for (const id of ids) if (observation.binding(id).kind !== 'absent') throw new ForkAdmissionError('policy')
          })
          if (!passive) assertSourceCurrent()
          let manifestDigest: string | undefined
          const targetPreparation = {
            async confirm(request: Parameters<NonNullable<import('@i-harness/session-persistence').BootstrapGuards['targetPreparation']>['confirm']>[0], current: () => boolean, facts?: import('@i-harness/core-session').BootstrapPreparationFacts) {
              return invokeLegacy(request, facts, current)
            },
            async reconcile(request: import('@i-harness/session-persistence').BootstrapTargetPreparationRequest, facts?: import('@i-harness/core-session').BootstrapPreparationFacts) { return invokeLegacy(request, facts) },
            assertTargetCurrent,
          }
          async function invokeLegacy(request: import('@i-harness/session-persistence').BootstrapTargetPreparationRequest, input: import('@i-harness/core-session').BootstrapPreparationFacts | undefined, current?: () => boolean): Promise<import('@i-harness/session-persistence').BootstrapTargetPreparationOutcome> {
            assertTargetCurrent()
            if (!input) return { kind: 'blocked', reason: 'unavailable' }
            const facts = captureBootstrapPreparationFacts(input)
            if (!same(facts.invocation, operation.invocation) || facts.manifestDigest !== request.manifestDigest || !same(request.invocation, operation.invocation)
              || facts.sourceObservation.kind !== 'semantic' || manifestDigest !== undefined && manifestDigest !== facts.manifestDigest) return { kind: 'blocked', reason: 'conflict' }
            manifestDigest = facts.manifestDigest
            if (!legacy) {
              const observed = !passive ? legacyObservationFor(observations.current(sourceId)!) : undefined
              legacy = service.registerLegacyForkTransfer({ invocation: operation.invocation, sourceSessionId: sourceId, semanticSeedDigest: facts.seedDigest,
                sourceObservationDigest: facts.sourceObservation.digest, selection: operation.prepared.core.selection,
                target: { available: () => active, assertCurrent: assertTargetCurrent, sourceId: () => { assertTargetCurrent(); return canonicalSource.sourceId } },
                ...(observed && source ? { source: { view: source.view, read: observed, assertCurrent: assertSourceCurrent } } : {}),
                ...(!passive && control.signal ? { signal: control.signal } : {}) })
            }
            const result = current ? await service.confirmLegacyForkTransfer(legacy, request, current, facts) : await service.reconcileLegacyForkTransfer(legacy, request, facts)
            assertTargetCurrent(); return result
          }
          const invokeManaged = async (request: import('@i-harness/session-persistence').BootstrapDependencyRequest, current?: () => boolean): Promise<import('@i-harness/session-persistence').BootstrapDependencyOutcome> => {
            assertTargetCurrent()
            if (request.operationId !== operation.invocation.operationId || request.targetSessionId !== operation.invocation.targetSessionId || request.sourceSessionId !== sourceId || request.manifestDigest !== manifestDigest) return { kind: 'blocked', reason: 'conflict' }
            managed ??= service.registerSeedDependencyTransfer({ binding: { operationId: request.operationId, manifestDigest: request.manifestDigest, sourceSessionId: sourceId,
              targetSessionId: operation.invocation.targetSessionId, targetDocumentId: operation.invocation.targetSessionId },
              sourceAccess: { sessionId: sourceId, ...(!passive && control.signal ? { signal: control.signal } : {}) },
              sourceAvailable: () => { try { assertSourceCurrent(); return true } catch { return false } }, assertSourceCurrent,
              targetAvailable: () => active, assertTargetCurrent, targetScope: () => { assertTargetCurrent(); return { source: canonicalSource, revision: canonicalJsonData(operation.invocation) } } })
            const result = current ? await service.confirmSeedDependencies(managed, request, current) : await service.reconcileSeedDependencies(managed, request)
            assertTargetCurrent(); return result
          }
          const run = async () => {
            let bodyFailed = false, bodyError: unknown, bodyResult: Awaited<ReturnType<typeof use>> | undefined
            try { bodyResult = await use({ ...(source ? { source } : {}), guards: { ...(!passive && control.signal ? { signal: control.signal } : {}),
              assertCurrent: passive ? assertTargetCurrent : assertSourceCurrent, targetPreparation,
              dependencies: { confirm: (request, current) => invokeManaged(request, current), reconcile: request => invokeManaged(request) } } }) }
            catch (cause) { bodyFailed = true; bodyError = cause }
            try { await cleanupLegacy() }
            catch (cause) { throw new AggregateError([...(bodyFailed ? [bodyError] : []), cause], 'Fork original L1 cleanup unresolved') }
            if (bodyFailed) throw bodyError
            return bodyResult as Awaited<ReturnType<typeof use>>
          }
          try { return await (source ? observations.run({ sessionId: sourceId, sessionIds: ids, observation, document: source.document,
            currentSource: () => canonicalSource, assertHostCurrent: assertSourceCurrent }, run) : run()) }
          finally { active = false }
        })
      } catch (cause) {
        failed = true; failure = cause
        // Preserve exact nominal F0 debt before a host composite wraps it.
        observationCleanup = observationCleanupFor(coordinator, cause)
      }
      active = false; callbackFinished = true
      let leaseFailed = false, leaseFailure: unknown
      // Never silently retry a failed original disposer in this response.
      if (!legacyCleanupFailed && !observationCleanup) {
        try { await lease.release(); released = true }
        catch (cause) { leaseFailed = true; leaseFailure = cause }
      }
      if (legacyCleanupFailed || observationCleanup || leaseFailed) {
        const error = new AggregateError([...(failed ? [failure] : []), ...(leaseFailed ? [leaseFailure] : [])], 'Fork original reader cleanup unresolved')
        const handle = Object.freeze({ retry: cleanup })
        debt.set(key, cleanup); cleanupErrors.set(error, handle)
        throw error
      }
      if (failed) throw failure
      return result as Awaited<ReturnType<typeof use>>
    },
    async withReadyTarget(operation, document, use) {
      assertAvailable()
      return inline.withReadyTarget(operation, document, async () => { assertAvailable(); const result = await use(); assertAvailable(); return result })
    },
  }
  associateForkHostCleanupOwner(coordinator, host, error => error !== null && typeof error === 'object' ? cleanupErrors.get(error) : undefined)
  return host
}
