import type { PersistenceBackend, CoordinatorOptions, SessionCoordinator } from "./coordinator/types.ts"
import { createOwnership } from "./coordinator/ownership.ts"
import { createMutations } from "./coordinator/mutations.ts"
import { createDocuments } from "./coordinator/documents.ts"
import { createLoads } from "./coordinator/load.ts"
import { createLifecycle } from "./coordinator/lifecycle.ts"
import { createManagedDocuments } from './coordinator/managed-documents.ts'
import { SessionWriteBehind, type SessionWriteBehindOptions } from "./write-behind.ts"
import { assertOutsideForkController, closeForkControllerAdmission } from './fork-controller.ts'
import { associateObservationCleanupOwner } from './coordinator/binding-observation.ts'
export * from './fork-contract.ts'
export { createForkSessionController, ForkAdmissionError, ForkTargetPolicyDeniedError } from './fork-controller.ts'
export type { ForkSessionController, ForkHost, ForkExecutionControl, ForkSourceWitness, ForkHandoffMode, ForkHandoff } from './fork-controller.ts'
export { compileSemanticSeed } from './semantic-seed.ts'
export type { CompiledSemanticSeed } from './semantic-seed.ts'
export type { BootstrapInvocation, BootstrapPhase, BootstrapResumeToken, BootstrapCallerMetadata, BootstrapLineage, BootstrapTarget, BootstrapInitial, BootstrapRequest, BootstrapDependencyRequest, BootstrapDependencyOutcome, BootstrapDependencyPort, BootstrapGuards, BootstrapReceipt, BootstrapOutcome, BootstrapInspection, BootstrapHeaderStage, BootstrapHeaderOperation, HeaderOutcome, BootstrapReadState, BootstrapFrame, BootstrapBackend } from './coordinator/bootstrap-types.ts'
export { parseBootstrapHeaderStage, rawHeaderDigest, bootstrapManifest } from './coordinator/bootstrap-header.ts'
export { captureBootstrapRequestIntent, createBootstrapRequestIntent } from './coordinator/bootstrap-intent.ts'
export type { BootstrapRequestIntent, BootstrapProjectIntent } from './coordinator/bootstrap-intent.ts'
export { readForkRequestCore } from './fork-contract.ts'
export type { ForkRequestCore } from './fork-contract.ts'
export type { BootstrapCaptureRequest, BootstrapCaptureReservation, BootstrapCaptureInspection, BootstrapCaptureReserveOutcome } from './coordinator/bootstrap-types.ts'
export { captureBootstrapCaptureRequest, parseBootstrapCaptureReservation, encodeBootstrapCaptureReservation } from './coordinator/bootstrap-capture.ts'
export { captureBootstrapTargetPreparationRequest } from './coordinator/bootstrap-preparation.ts'
export type { BootstrapTargetPreparationRequest, BootstrapTargetPreparationOutcome, BootstrapTargetPreparationPort } from './coordinator/bootstrap-types.ts'

export type {
  SessionMeta, SessionModelSelection, PersistenceBackend, SessionArtifactManifest,
  CoordinatorOptions, SessionCoordinator, ObservedDocument, SessionBindingObservationRequest, SessionBindingObservation, ExistingSessionBindingObservationRequest, ExistingSessionBindingObservation,
} from "./coordinator/types.ts"
export { SessionBindingObservationError } from './coordinator/types.ts'
export { SessionFormatUnsupportedError, registerUpgrade, registerEventType } from "./format/registry.ts"

export { SessionWriteBehind, type SessionWriteBehindOptions }
export { resolveSessionStoreRoot } from "./store-root.ts"
export { remapConversationSeed, SessionForkUnavailableError } from "./seed.ts"
export { repairTurnTail, TOOL_ABORTED_BEFORE_DISPATCH, TOOL_ABORTED_RECOVERY_RESULT } from "./repair.ts"
export {
  forkSession,
  retryForkSession,
  materializeMissingImageAdmissions,
  remapSeedEvent,
  type ForkSessionOptions,
} from "./fork.ts"

// M23: the ownership lease's typed errors are part of the coordinator's
// fail-closed surface (create/append/adopt/load/flush propagate them), so
// consumers can catch them without depending on @i-harness/fs-lock directly.
export { SessionLockConflictError, SessionLockUnsupportedError } from "@i-harness/fs-lock"

export function createSessionCoordinator(backend: PersistenceBackend, opts?: CoordinatorOptions): SessionCoordinator {
  const report = opts?.reportBackgroundFailure
    ?? ((error: unknown) => { console.warn("[i-harness] background persistence failure:", error) })
  const maxDelayMs = opts?.maxDelayMs ?? 200
  const ownership = createOwnership(backend, opts)
  let managed: ReturnType<typeof createManagedDocuments>
  const documents = createDocuments(backend, ownership, report)
  const observations = documents.observations
  const mutations = createMutations(backend, ownership, maxDelayMs, report, id => managed?.assertMutation(id), observations)
  const loads = createLoads(backend, ownership, mutations)
  managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, report, mutations)
  const lifecycle = createLifecycle(backend, ownership, mutations, documents, managed)

  async function retire<T>(id: string, run: () => Promise<T>) {
    managed.assertOutsideCapture(id)
    const admission = observations.beginRetirement(id)
    try { await admission.join(); return await run() } finally { admission.finish() }
  }
  const coordinator: SessionCoordinator = {
    ...(ownership.lockEnabled && backend.readDocumentObserved && (process.platform === 'win32' || process.platform === 'linux') ? { withSessionBindingObservation: observations.withSessionBindingObservation, withExistingSessionBindingObservation: observations.withExistingSessionBindingObservation } : {}),
    bootstrapSemanticTarget(request, guards) { if(managed.captureSelfConflict(request,true))return Promise.resolve({kind:'refused',reason:'conflict'}); return observations.withBootstrapRequest(request, guards, (captured, capturedGuards) => managed.bootstrapSemanticTarget(captured, capturedGuards)) },
    resumeSemanticTarget(invocation, guards, originalPayload) { if(managed.captureSelfConflict(invocation))return Promise.resolve({kind:'refused',reason:'conflict'}); return observations.withBootstrapResume(invocation, guards, originalPayload, (captured, capturedGuards, payload) => managed.resumeSemanticTarget(captured, capturedGuards, payload)) },
    ...(managed.captureSupported()?{
      inspectBootstrapCapture:managed.inspectBootstrapCapture,
      bootstrapSemanticTargetWithCapture(request:import('./coordinator/bootstrap-types.ts').BootstrapCaptureRequest,guards:import('./coordinator/bootstrap-types.ts').BootstrapGuards,capture:()=>Promise<import('./coordinator/bootstrap-types.ts').BootstrapRequest>){
        if(managed.captureSelfConflict(request,true))return Promise.resolve<import('./coordinator/bootstrap-types.ts').BootstrapOutcome>({kind:'refused',reason:'conflict'})
        return observations.withBootstrapCapture(request,guards,capture,managed.bootstrapSemanticTargetWithCapture)
      },
    }:{}),
    inspectBootstrap: managed.inspectBootstrap,
    ...(backend.storageRoot === undefined ? {} : { storageRoot: backend.storageRoot }),
    async openManagedDocument(sessionId) { observations.assertOutsideObservedSession(sessionId); observations.assertSessionAdmission(sessionId); return managed.open(sessionId) },
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
    adoptOwnership: mutations.adoptOwnership,
    releaseOwnership(sessionId) { return retire(sessionId, async () => { await managed.closeOne(sessionId); await mutations.releaseOwnership(sessionId) }) },
  }
  associateObservationCleanupOwner(coordinator, observations.cleanupForError)
  return coordinator
}

export { ownedContextReadiness } from "./context-readiness.ts"
export type { HeldFactOwner, IssuingFactOwner, BackendFactOutcome, OwnedFactBackend, ManagedDocument } from './coordinator/fact-types.ts'
export { isHeldFactOwner } from './coordinator/fact-owner.ts'
