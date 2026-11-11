import { captureOriginalManagedReadyGuard } from './coordinator/managed-document.ts'
import { associateArtifactCurrentnessReader, createArtifactCurrentGuard, isArtifactCurrentGuard } from './coordinator/artifact-path-association.ts'
import type { SessionCoordinator, SessionMeta } from './coordinator/types.ts'
import type { SessionView, ResultEnvelope } from '@i-harness/core-session'
import { sameBootstrapData } from './coordinator/bootstrap-header.ts'
import { ForkAdmissionError, ForkTargetPolicyDeniedError, restrictForkHostToEmptyClosure, type ForkHost, type ForkSourceWitness } from './fork-controller.ts'

function requireRoot(meta: Readonly<SessionMeta>): void {
  if (meta.archived) throw new ForkAdmissionError('policy')
  if (meta.parentSession !== undefined || meta.origin === 'subagent' || meta.origin === 'team' || meta.semanticSeed !== undefined) throw new ForkAdmissionError('unsupported')
}
function requiresResultHost(view: SessionView): boolean {
  return view.events.some(event => {
    if (event.type === 'context/result-ref' || event.type === 'conversation/seed-manifest' && event.artifacts.length > 0) return true
    const envelope = 'envelope' in event ? event.envelope as ResultEnvelope | undefined : undefined
    return envelope?.retention.kind === 'artifact' || envelope?.dependencies?.kind === 'artifact-set'
  })
}
export function createForkSourceWitness(document: ForkSourceWitness['document']): ForkSourceWitness {
  document.assertReady()
  const view = document.view, events = view.events, eventCount = events.length
  const original = captureOriginalManagedReadyGuard(document)
  if (original && isArtifactCurrentGuard(original)) {
    const witness = { document, view, events, eventCount, assertUnchanged: createArtifactCurrentGuard(() => {
      original()
      if (document.view !== view || view.events !== events || events.length !== eventCount) throw new ForkAdmissionError('stale-source')
    }) }
    associateArtifactCurrentnessReader(witness, 'assertUnchanged')
    return witness
  }
  return { document, view, events, eventCount,
    assertUnchanged() { document.assertReady(); if (document.view !== view || view.events !== events || events.length !== eventCount) throw new ForkAdmissionError('stale-source') } }
}
/** Conservative root-only standalone host. Shipping hosts supply real result ports. */
export function createInlineForkHost(coordinator: SessionCoordinator): ForkHost {
  const host: ForkHost = {
    assertAvailable() {
      if (!coordinator.withSessionBindingObservation || !coordinator.withExistingSessionBindingObservation) throw new ForkAdmissionError('unsupported')
    },
    async resolvePreparation(request, signal) {
      this.assertAvailable()
      return coordinator.withExistingSessionBindingObservation!({ sessionIds: [request.sourceSessionId], ...(signal ? { signal } : {}) }, async observed => {
        observed.assertCurrent()
        const meta = observed.metadata(request.sourceSessionId); requireRoot(meta)
        if (observed.binding(request.sourceSessionId).kind !== 'absent') throw new ForkAdmissionError('unsupported')
        return { metadata: { ...(meta.title === undefined ? {} : { title: meta.title }), ...(meta.workspaceId === undefined ? {} : { workspaceId: meta.workspaceId }),
          ...(meta.modelSelection === undefined ? {} : { modelSelection: { ...meta.modelSelection } }), ...request.metadata }, project: { kind: 'unmanaged' } }
      })
    },
    async withHandoff(operation, mode, control, use) {
      this.assertAvailable()
      const sourceId = operation.prepared.core.sourceSessionId
      let source: ForkSourceWitness | undefined
      if (mode.kind !== 'passive') {
        if (control.signal?.aborted) throw new ForkAdmissionError('cancelled')
        if (mode.kind === 'warm') { source = mode.source; source.assertUnchanged() }
        else { await coordinator.flush(sourceId); source = createForkSourceWitness(await coordinator.openManagedDocument(sourceId)) }
        if (requiresResultHost(source.view)) throw new ForkAdmissionError('unsupported')
      }
      return coordinator.withSessionBindingObservation!({ existingSessionIds: mode.kind === 'passive' ? [] : [sourceId], target: operation.invocation,
        ...(mode.kind !== 'passive' && control.signal ? { signal: control.signal } : {}) }, async observed => {
        observed.assertCurrent()
        if (mode.kind !== 'passive') {
          requireRoot(observed.metadata(sourceId))
          if (observed.binding(sourceId).kind !== 'absent') throw new ForkAdmissionError('unsupported')
          source!.assertUnchanged()
        }
        if (observed.binding(operation.invocation.targetSessionId).kind !== 'absent') throw new ForkTargetPolicyDeniedError()
        const assertCurrent = () => { observed.assertCurrent(); if (mode.kind !== 'passive') { if (control.signal?.aborted) throw new ForkAdmissionError('cancelled'); source!.assertUnchanged() } }
        return use({ ...(source ? { source } : {}), guards: { ...(mode.kind !== 'passive' && control.signal ? { signal: control.signal } : {}), assertCurrent,
          dependencies: { async confirm() { throw new Error('Standalone artifact dependency port is unreachable') }, async reconcile() { throw new Error('Standalone artifact dependency port is unreachable') } } } })
      })
    },
    async withReadyTarget(operation, document, use) {
      this.assertAvailable()
      return coordinator.withExistingSessionBindingObservation!({ sessionIds: [operation.invocation.targetSessionId] }, async observed => {
        const assertCurrent = () => {
          observed.assertCurrent(); document.assertReady()
          const meta = observed.metadata(operation.invocation.targetSessionId), seed = meta.semanticSeed
          if (meta.archived || observed.binding(meta.sessionId).kind !== 'absent') throw new ForkTargetPolicyDeniedError()
          if (meta.sessionId !== operation.invocation.targetSessionId || meta.parentSession !== operation.prepared.core.sourceSessionId
            || meta.origin !== 'fork' || meta.createdAt !== operation.invocation.createdAt || seed?.operationId !== operation.invocation.operationId
            || seed.requestDigest !== operation.invocation.requestDigest || !sameBootstrapData(seed, document.view.header?.semanticSeed)) throw new Error('Fork target identity unavailable')
        }
        assertCurrent(); const result = await use(); assertCurrent(); return result
      })
    },
  }
  restrictForkHostToEmptyClosure(host)
  return host
}
