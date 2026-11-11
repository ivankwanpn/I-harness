import { createSessionCoordinatorCore } from './coordinator-factory.ts'
import { types as utilTypes } from 'node:util'
import { SessionLockUnsupportedError } from '@i-harness/fs-lock'
export { captureBootstrapRoute, captureBootstrapCaptureRoute, childBootstrapPathKey, routeInvocation, routeForReservation, encodeOwnedCaptureReservation, parseOwnedCaptureReservation, validateOwnedCaptureStage } from './coordinator/bootstrap-route.ts'
export type { BootstrapRoute, BootstrapCaptureRoute, BootstrapRouteBackend } from './coordinator/bootstrap-route.ts'
import type { PersistenceBackend, CoordinatorOptions, SessionCoordinator } from "./coordinator/types.ts"
import { SessionWriteBehind, type SessionWriteBehindOptions } from "./write-behind.ts"
export * from './fork-contract.ts'
export { createForkSessionController, ForkAdmissionError, ForkTargetPolicyDeniedError } from './fork-controller.ts'
export type { ForkSessionController, ForkHost, ForkExecutionControl, ForkSourceWitness } from './fork-controller.ts'
export { compileSemanticSeed } from './semantic-seed.ts'
export type { CompiledSemanticSeed } from './semantic-seed.ts'
export type { BootstrapInvocation, BootstrapPhase, BootstrapResumeToken, BootstrapCallerMetadata, BootstrapRequest, BootstrapDependencyRequest, BootstrapDependencyOutcome, BootstrapDependencyPort, BootstrapGuards, BootstrapReceipt, BootstrapOutcome, BootstrapInspection, BootstrapHeaderStage, BootstrapHeaderOperation, HeaderOutcome, BootstrapReadState, BootstrapFrame, BootstrapBackend } from './coordinator/bootstrap-types.ts'
export { parseBootstrapHeaderStage, rawHeaderDigest, bootstrapManifest } from './coordinator/bootstrap-header.ts'
export { captureBootstrapRequestIntent, createBootstrapRequestIntent } from './coordinator/bootstrap-intent.ts'
export type { BootstrapRequestIntent, BootstrapProjectIntent } from './coordinator/bootstrap-intent.ts'
export { readForkRequestCore } from './fork-contract.ts'
export type { ForkRequestCore } from './fork-contract.ts'
export type { BootstrapCaptureRequest, BootstrapCaptureReservation, BootstrapCaptureInspection, BootstrapCaptureReserveOutcome } from './coordinator/bootstrap-types.ts'
export { captureBootstrapCaptureRequest, parseBootstrapCaptureReservation, encodeBootstrapCaptureReservation } from './coordinator/bootstrap-capture.ts'
export { captureChildBootstrapCore, createChildBootstrapRequestIntent, captureChildBootstrapCaptureRequest, encodeChildBootstrapReservation, parseChildBootstrapReservation, childInitialCommitment, CHILD_BOOTSTRAP_DOMAINS } from './coordinator/child-bootstrap-intent.ts'
export { childRoleDigest } from './coordinator/child-bootstrap-intent.ts'
export type { ChildHistory, ChildBootstrapCore, ChildBootstrapCaptureRequest, ChildBootstrapReservation, ChildBootstrapCaptureInspection, OwnedCaptureReservation, OwnedCaptureInspection } from './coordinator/child-bootstrap-intent.ts'
export { captureBootstrapTargetPreparationRequest } from './coordinator/bootstrap-preparation.ts'
export type { BootstrapTargetPreparationRequest, BootstrapTargetPreparationOutcome, BootstrapTargetPreparationPort } from './coordinator/bootstrap-types.ts'

export type {
  SessionMeta, SessionModelSelection, PersistenceBackend, SessionArtifactManifest,
  CoordinatorOptions, SessionCoordinator, ObservedDocument, SessionBindingObservationRequest, SessionBindingObservation, ExistingSessionBindingObservationRequest, ExistingSessionBindingObservation,
} from "./coordinator/types.ts"
export type { ProcessReadOptions, ProcessReadInitial, ProcessReadUpdate, ProcessReadObservation } from './coordinator/process-read-owner.ts'
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
  if (opts?.lock?.enabled === false) throw new SessionLockUnsupportedError('Current-format writable coordination requires ownership; use createReadOnlySessionCoordinator for non-owning reads')
  if (!backend || typeof backend !== 'object' || utilTypes.isProxy(backend)) throw new TypeError('Original writable backend constructor required')
  const factory = Object.getOwnPropertyDescriptor(backend, 'createCoordinator')
  if (!factory || !('value' in factory) || factory.writable || factory.configurable || typeof factory.value !== 'function' || utilTypes.isProxy(factory.value)) {
    throw new TypeError('Backend has no original writable coordinator factory; use createReadOnlySessionCoordinator for legacy or non-owning reads')
  }
  return Reflect.apply(factory.value, backend, [opts]) as SessionCoordinator
}
/** A read facet over one original storage owner. It never exposes adoption or
 * mutation, and reads remain usable while another coordinator holds the writer. */
export interface ReadOnlySessionCoordinator {
  readonly access: 'read'
  readonly list: SessionCoordinator['list']
  readonly profile: SessionCoordinator['profile']
  readonly snapshot: NonNullable<SessionCoordinator['snapshot']>
  readonly getDocument: SessionCoordinator['getDocument']
  readonly close: SessionCoordinator['close']
}
export function createReadOnlySessionCoordinator(backend: PersistenceBackend, opts?: CoordinatorOptions): ReadOnlySessionCoordinator {
  const owner = createSessionCoordinatorCore(backend, opts)
  return Object.freeze({
    access: 'read' as const,
    list: owner.list.bind(owner),
    profile: owner.profile.bind(owner),
    snapshot: owner.snapshot!.bind(owner),
    getDocument: owner.getDocument.bind(owner),
    close: owner.close.bind(owner),
  })
}
export { ownedContextReadiness } from "./context-readiness.ts"
export type { HeldFactOwner, IssuingFactOwner, BackendFactOutcome, OwnedFactBackend, ManagedDocument } from './coordinator/fact-types.ts'
export { isHeldFactOwner } from './coordinator/fact-owner.ts'
export { captureSelectedResultsRoute, selectedBootstrapPathKey } from './coordinator/selected-results-route.ts'
export type { SelectedResultsRoute } from './coordinator/selected-results-route.ts'
export { parseSelectedResultsReservation } from './coordinator/selected-results-intent.ts'
export type { SelectedResultsReservationV1 } from './coordinator/selected-results-intent.ts'
export { parseSelectedResultsHeaderStage } from './coordinator/selected-results-header.ts'
export type { SelectedResultsHeaderStageV2 } from './coordinator/selected-results-header.ts'

export type { HeldTaskDocumentScope, TaskDocumentWitness, TaskDocumentAck, TaskObservation, Confirmation, RawTaskObservation, TaskDocumentBackendSession, OpenTaskDocumentSession } from './coordinator/task-document-types.ts'
export type { TaskWriteOutcome, TaskDocumentWrite } from './coordinator/task-document-types.ts'
export { isHeldTaskDocumentScope } from './coordinator/task-document-scope.ts'
export { TASK_DOCUMENT_MAX_BYTES } from './coordinator/task-document-operation.ts'
