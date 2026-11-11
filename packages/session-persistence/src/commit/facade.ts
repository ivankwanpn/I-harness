import type { SessionCoordinator } from '../coordinator/types.ts'
import { associateManagedExecution } from '../execution-internal.ts'
import { associateOriginalResultOrdering } from '../result-ordering-internal.ts'
import { associateOriginalResultRevocation } from '../coordinator/result-revocation.ts'
import { associateTaskDocumentOperations } from '../coordinator/task-document-association.ts'
import { associateColdExecutionWrites, createColdExecutionWrites } from '../coordinator/cold-execution-writes.ts'
import { associateRetainedCoordinatorClose } from '../coordinator/retained-cleanup.ts'
import type { TaskDocumentConfiguration } from '../coordinator/task-document-operation.ts'
import { CommitLogConflictError } from '@i-harness/session-commit-log'
import type { BootstrapCaptureRequest, BootstrapGuards, BootstrapOutcome, BootstrapRequest } from '../coordinator/bootstrap-types.ts'
import { createHash } from 'node:crypto'
import { canonicalJsonData } from '@i-harness/core-session'
import { captureBootstrapInvocation, captureBootstrapRequest } from '../coordinator/bootstrap-header.ts'
import type { CommitCoordinator } from './coordinator.ts'
import { createCommitTaskOperations } from './capabilities.ts'
import { taskDocumentStorageContract } from '../task-state-internal.ts'

export type CommitFacadeOptions = {
  readonly taskDocument?: { readonly validator: TaskDocumentConfiguration['validator']; readonly empty?: () => unknown }
}

/**
 * Present the commit coordinator as the existing SessionCoordinator surface.
 * The semantic bootstrap entry points use the same original native child
 * commit and its exact stored receipt. Resume without the original payload is
 * a passive refusal; it never invents a stage or a replacement birth.
 * The managed-execution, ordering, revocation and task-document capabilities are
 * registered on this exact facade object, which is what the executor passes in.
 */
export function asSessionCoordinator(coordinator: CommitCoordinator, options: CommitFacadeOptions = {}): SessionCoordinator {
  const taskDocument = options.taskDocument ?? { validator: taskDocumentStorageContract, empty: taskDocumentStorageContract.empty }
  const initialTaskDocument = () => {
    if (!taskDocument.empty) return undefined
    const value = taskDocument.empty()
    if (value === undefined) throw new TypeError('Initial Task document must be JSON data')
    taskDocument.validator.validate(value)
    return value
  }
  const inspectTarget = coordinator.inspectBirth.bind(coordinator)
  const bootstrap = async (request: BootstrapRequest, guards: BootstrapGuards): Promise<BootstrapOutcome> => {
    guards.assertCurrent()
    try {
      const created = await coordinator.createChildSession(request, { closure: request.seed.dependencyDigest, initialTaskDocument: initialTaskDocument() })
      return { kind: 'ready', receipt: created.receipt, document: created.document }
    } catch (error) {
      if ((error as { code?: string } | null | undefined)?.code === 'COMMIT_EXISTING_EMPTY_UNSUPPORTED') return { kind: 'not-issued', reason: 'unsupported' }
      if (error instanceof CommitLogConflictError) return { kind: 'refused', reason: 'conflict' }
      throw error
    }
  }
  const bootstrapChild: NonNullable<SessionCoordinator['bootstrapChildTargetWithCapture']> = async (request, guards, capture) => {
    guards.assertCurrent()
    const payload = captureBootstrapRequest(await capture())
    guards.assertCurrent()
    if (canonicalJsonData(payload.invocation) !== canonicalJsonData(request.invocation)) return { kind: 'refused', reason: 'manifest-invalid' }
    return bootstrap(payload, guards)
  }
  const coldWrites = createColdExecutionWrites()
  const ports = coordinator.capabilities()
  const facade: SessionCoordinator & Pick<CommitCoordinator, 'acquireExecution'> = {
    ...coordinator,
    create: async (meta?: Parameters<typeof coordinator.create>[0]) => coordinator.create(meta, initialTaskDocument()),
    append: async (id: string, events: Parameters<typeof coordinator.append>[1]) => {
      const result = await coordinator.append(id, events)
      coldWrites.committed(id)
      return result
    },
    bootstrapSemanticTarget: bootstrap,
    async resumeSemanticTarget(invocation, guards, originalPayload) {
      if (!originalPayload) return { kind: 'not-issued', reason: 'unsupported' }
      const request = captureBootstrapRequest(originalPayload), expected = captureBootstrapInvocation(invocation)
      if (canonicalJsonData(request.invocation) !== canonicalJsonData(expected)) return { kind: 'refused', reason: 'manifest-invalid' }
      return bootstrap(request, guards)
    },
    async bootstrapSemanticTargetWithCapture(request: BootstrapCaptureRequest, guards: BootstrapGuards, capture: () => Promise<BootstrapRequest>): Promise<BootstrapOutcome> {
      // SCL creates the child directly: the capture is the only source of the
      // seed, and the receipt is verified by the caller against it.
      guards.assertCurrent()
      const captured = captureBootstrapRequest(await capture())
      guards.assertCurrent()
      if (canonicalJsonData(captured.invocation) !== canonicalJsonData(request.invocation)) return { kind: 'refused', reason: 'manifest-invalid' }
      const result = await bootstrap(captured, guards)
      if (result.kind !== 'ready' && result.kind !== 'already-ready') return result
      // Preserve the original capture intent's project binding independently
      // from the immutable semantic birth; never overwrite an existing binding.
      const project = (request as { requestIntent?: { project?: { kind?: string; projectId?: string } } }).requestIntent?.project
      if (project?.kind === 'project' && typeof project.projectId === 'string') {
        const key = 'desktop-session-project-' + createHash('sha256').update(captured.invocation.targetSessionId).digest('hex')
        if (await coordinator.getDocument(key) === undefined) await coordinator.putDocument(key, Object.freeze({ version: 1, projectId: project.projectId }))
      }
      return result
    },
    resumeChildTarget: (request, guards, payload) => payload
      ? bootstrapChild(request, guards, async () => payload)
      : coordinator.resumeChildTarget(request, guards, payload),
    bootstrapChildTargetWithCapture: bootstrapChild,
    inspectBootstrap: inspectTarget,
    inspectChildBootstrap: request => inspectTarget(request.invocation),
    inspectBootstrapCapture: async request => {
      const result = await inspectTarget(request.invocation)
      if (result.kind === 'absent') return { kind: 'absent' }
      return { kind: result.kind === 'ready' ? 'materialized' : 'conflict' }
    },
    revokeManagedDocumentNewWork: coordinator.revokeManagedDocumentNewWork.bind(coordinator),
    getDocument: coordinator.getDocument.bind(coordinator),
    putDocument: coordinator.putDocument.bind(coordinator),
    acquireExecution: coordinator.acquireExecution.bind(coordinator),
    retainExistingSessionBindingObservation: ports.observations.retainExistingSessionBindingObservation,
  }
  // Retained bindings validate against the coordinator that issued them; the
  // observations instance owns the reference ledger.
  ports.observations.associateRetainedCoordinator(facade as never)
  if (taskDocument) {
    associateTaskDocumentOperations(facade as never, createCommitTaskOperations(ports, {
      putDocument: ports.documents.putDocument,
      getDocument: ports.documents.getDocument,
    }, {
      validator: taskDocument.validator,
      ...(taskDocument.empty ? { empty: taskDocument.empty } : {}),
      sessionOfDocument: document => coordinator.sessionOfDocument(document),
    }) as never)
  }
  associateOriginalResultOrdering(facade as never, ports.ownership as never)
  associateOriginalResultRevocation(facade as never, ports.admission as never, ports.ownership as never)
  associateColdExecutionWrites(facade as never, coldWrites)
  // No retained bindings exist on this coordinator; close is the whole cleanup.
  associateRetainedCoordinatorClose(facade as never, async () => { await coordinator.close() })
  associateManagedExecution(facade, {
    acquire: id => coordinator.acquireExecution(id),
    assertAdmission: () => {},
  })
  return facade
}
