import type { PersistenceBackend, CoordinatorOptions, SessionCoordinator } from './coordinator/types.ts'
import { createOwnership } from './coordinator/ownership.ts'
import { createMutations } from './coordinator/mutations.ts'
import { createDocuments } from './coordinator/documents.ts'
import { createLoads } from './coordinator/load.ts'
import { createLifecycle } from './coordinator/lifecycle.ts'
import { createManagedDocuments } from './coordinator/managed-documents.ts'
import { assertOutsideForkController, closeForkControllerAdmission } from './fork-controller.ts'
import { associateObservationCleanupOwner } from './coordinator/binding-observation.ts'
import { createProcessReadLatches } from './coordinator/process-read-latches.ts'
import type { ProcessReadStorage } from './coordinator/process-read-storage.ts'
import { captureBootstrapInvocation } from './coordinator/bootstrap-header.ts'
import type { BootstrapOutcome, BootstrapInvocation } from './coordinator/bootstrap-types.ts'
import { types as utilTypes } from 'node:util'
import { retainSelectedSourceRead } from './coordinator/managed-document.ts'
const selectedSources=new WeakMap<SessionCoordinator,{acquire:ReturnType<typeof createDocuments>['observations']['acquireSelectedBindingRead'];cleanupForError:ReturnType<typeof createDocuments>['observations']['cleanupForError'];captureSelected:ReturnType<typeof createManagedDocuments>['captureSelected'];reconcileSelected:ReturnType<typeof createManagedDocuments>['reconcileSelected'];releaseSelected:ReturnType<typeof createManagedDocuments>['releaseSelected'];retain(document:import('./coordinator/fact-types.ts').ManagedDocument,onRevoke:()=>void):ReturnType<typeof retainSelectedSourceRead>}>()
export function selectedSourceFor(coordinator:SessionCoordinator) {const owner=selectedSources.get(coordinator);if(!owner)throw new TypeError('Original coordinator required');return owner}
export function createSessionCoordinatorCore(backend: PersistenceBackend, opts?: CoordinatorOptions, storage?: ProcessReadStorage, onConstruct?: (owners: { managed: ReturnType<typeof createManagedDocuments>; latches: ReturnType<typeof createProcessReadLatches> }) => void): SessionCoordinator {
  const report = opts?.reportBackgroundFailure
    ?? ((error: unknown) => { console.warn("[i-harness] background persistence failure:", error) })
  const maxDelayMs = opts?.maxDelayMs ?? 200
  const ownership = createOwnership(backend, opts)
  let managed: ReturnType<typeof createManagedDocuments>
  const processLatches = storage ? createProcessReadLatches() : undefined
  const documents = createDocuments(backend, ownership, report, processLatches)
  const observations = documents.observations
  const mutations = createMutations(backend, ownership, maxDelayMs, report, id => managed?.assertMutation(id), observations, processLatches)
  const loads = createLoads(backend, ownership, mutations, processLatches)
  managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, report, mutations, processLatches)
  const lifecycle = createLifecycle(backend, ownership, mutations, documents, managed, processLatches)

  async function retire<T>(id: string, run: () => Promise<T>) {
    managed.assertOutsideCapture(id)
    const token = processLatches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'other' })
    let outcome: 'settled' | 'unknown' = 'unknown'
    try {
      const admission = observations.beginRetirement(id)
      try { await admission.join(); const result = await run(); outcome = 'settled'; return result } finally { admission.finish() }
    } catch (error) { outcome = 'unknown'; throw error } finally { token?.end(outcome) }
  }
  function trackBootstrap(input: unknown, wrapped: boolean, run: () => Promise<BootstrapOutcome>) {
    let invocation: BootstrapInvocation
    try {
      if (input && typeof input === 'object' && utilTypes.isProxy(input)) return run()
      const value = wrapped && input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'invocation')?.value : input
      invocation = captureBootstrapInvocation(value)
    } catch { return run() }
    return managed.trackBootstrapInvocation(invocation, run)
  }
  const coordinator: SessionCoordinator = {
    ...(ownership.lockEnabled && backend.readDocumentObserved && (process.platform === 'win32' || process.platform === 'linux') ? { withSessionBindingObservation: observations.withSessionBindingObservation, withExistingSessionBindingObservation: observations.withExistingSessionBindingObservation } : {}),
    bootstrapSemanticTarget(request, guards) { if(managed.captureSelfConflict(request,true))return Promise.resolve({kind:'refused',reason:'conflict'}); return trackBootstrap(request,true,()=>observations.withBootstrapRequest(request, guards, (captured, capturedGuards) => managed.bootstrapSemanticTarget(captured, capturedGuards))) },
    resumeSemanticTarget(invocation, guards, originalPayload) { if(managed.captureSelfConflict(invocation))return Promise.resolve({kind:'refused',reason:'conflict'}); return trackBootstrap(invocation,false,()=>observations.withBootstrapResume(invocation, guards, originalPayload, (captured, capturedGuards, payload) => managed.resumeSemanticTarget(captured, capturedGuards, payload))) },
    ...(managed.captureSupported()?{
      inspectBootstrapCapture:managed.inspectBootstrapCapture,
      bootstrapSemanticTargetWithCapture(request:import('./coordinator/bootstrap-types.ts').BootstrapCaptureRequest,guards:import('./coordinator/bootstrap-types.ts').BootstrapGuards,capture:()=>Promise<import('./coordinator/bootstrap-types.ts').BootstrapRequest>){
        if(managed.captureSelfConflict(request,true))return Promise.resolve<import('./coordinator/bootstrap-types.ts').BootstrapOutcome>({kind:'refused',reason:'conflict'})
        return trackBootstrap(request,true,()=>observations.withBootstrapCapture(request,guards,capture,managed.bootstrapSemanticTargetWithCapture))
      },
    }:{}),
    ...(managed.childSupported()?{
      inspectChildBootstrapCapture:managed.inspectChildBootstrapCapture,
      bootstrapChildTargetWithCapture(request:import('./coordinator/child-bootstrap-intent.ts').ChildBootstrapCaptureRequest,guards:import('./coordinator/bootstrap-types.ts').BootstrapGuards,capture:()=>Promise<import('./coordinator/bootstrap-types.ts').BootstrapRequest>){
        if(managed.captureSelfConflict(request,true))return Promise.resolve<import('./coordinator/bootstrap-types.ts').BootstrapOutcome>({kind:'refused',reason:'conflict'})
        return trackBootstrap(request,true,()=>observations.withChildBootstrapCapture(request,guards,capture,managed.bootstrapChildTargetWithCapture))
      },
      resumeChildTarget(request:import('./coordinator/child-bootstrap-intent.ts').ChildBootstrapCaptureRequest,guards:import('./coordinator/bootstrap-types.ts').BootstrapGuards,payload?:import('./coordinator/bootstrap-types.ts').BootstrapRequest){
        if(managed.captureSelfConflict(request,true))return Promise.resolve<import('./coordinator/bootstrap-types.ts').BootstrapOutcome>({kind:'refused',reason:'conflict'})
        return trackBootstrap(request,true,()=>observations.withChildBootstrapResume(request,guards,payload,managed.resumeChildTarget))
      },
    }:{}),    inspectBootstrap: managed.inspectBootstrap,
    ...(backend.storageRoot === undefined ? {} : { storageRoot: backend.storageRoot }),
    async openManagedDocument(sessionId) { managed.assertOutsideCapture(sessionId); observations.assertOutsideObservedSession(sessionId); observations.assertSessionAdmission(sessionId); return managed.open(sessionId) },
    revokeManagedDocumentNewWork: managed.revoke,
    closeManagedDocument(sessionId) { return retire(sessionId, () => managed.closeOne(sessionId)) },
    ...(backend.deletionReceipt ? { deletionReceipt: (sessionId: string) => backend.deletionReceipt!(sessionId) } : {}),
    ...(backend.deleteOwnedSession ? {
      async deleteOwnedSession(sessionId:string,manifest:import('./coordinator/types.ts').SessionArtifactManifest){
        managed.assertOutsideCapture(sessionId)
        return lifecycle.deleteOwnedSession(sessionId,manifest)
      },onDocumentDeleted:lifecycle.onDocumentDeleted,
    }:{}),
    ensureWritableFormat: mutations.ensureWritableFormat,
    create: mutations.create,
    append(sessionId, events) {
      if (managed.has(sessionId)) return Promise.reject(new Error('Managed document requires fact admission'))
      return mutations.append(sessionId, events)
    },
    enqueue(sessionId, events) {
      if (managed.has(sessionId)) throw new Error('Managed document requires fact admission')
      mutations.enqueue(sessionId, events)
    },
    async snapshot(sessionId) { const session = await managed.snapshot(sessionId); return session ? { session } : loads.snapshot(sessionId) },
    async load(sessionId) { observations.assertOutsideObservedSession(sessionId); const session = await managed.snapshot(sessionId); return session ? { session } : loads.load(sessionId) },
    async loadOwned(sessionId) { observations.assertOutsideObservedSession(sessionId); observations.assertSessionAdmission(sessionId); const session = await managed.snapshot(sessionId); return session ? { session } : loads.loadOwned(sessionId) },
    async list() { return backend.list() },
    async profile(sessionId) { observations.assertOutsideObservedSession(sessionId); return backend.profile(sessionId) },
    updateMeta: mutations.updateMeta,
    flush: mutations.flush,
    async close() {
      managed.assertOutsideCapture()
      assertOutsideForkController(coordinator)
      processLatches?.closeAdmission()
      const join = observations.closeAdmission()
      const joinCapture = managed.closeCaptureAdmission()
      const joinFork = closeForkControllerAdmission(coordinator)
      const errors: unknown[] = []
      const joined=await Promise.allSettled([join(),joinCapture(),joinFork().then(() => managed.close())])
      for(const result of joined)if(result.status==='rejected')errors.push(result.reason)
      // Dependent original leases survive unresolved observation/managed work.
      if (errors.length === 0) await lifecycle.close()
      else {
        try { await lifecycle.close(false) } catch (error) { errors.push(error) }
        throw new AggregateError(errors, 'Coordinator cleanup is unresolved')
      }
    },
    putDocument: documents.putDocument,
    putDocumentStrict: documents.putDocumentStrict,
    getDocument: documents.getDocument,
    ownerOf: ownership.ownerOf,
    hasLiveOwnership: ownership.hasLiveOwnership,
    adoptOwnership: mutations.adoptOwnership,
    releaseOwnership(sessionId) { return retire(sessionId, async () => { await managed.closeOne(sessionId); await mutations.releaseOwnership(sessionId) }) },
  }
  associateObservationCleanupOwner(coordinator, observations.cleanupForError)
  selectedSources.set(coordinator,Object.freeze({acquire:observations.acquireSelectedBindingRead,cleanupForError:observations.cleanupForError,captureSelected:managed.captureSelected,reconcileSelected:managed.reconcileSelected,releaseSelected:managed.releaseSelected,retain(document,onRevoke){return retainSelectedSourceRead(document,ownership,onRevoke)}}))
  if (processLatches) onConstruct?.({ managed, latches: processLatches })
  return coordinator
}

