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
import type { CommitCoordinator } from './coordinator.ts'
import { createCommitTaskOperations } from './capabilities.ts'

export type CommitFacadeOptions = {
  readonly taskDocument?: { readonly validator: TaskDocumentConfiguration['validator']; readonly empty?: () => unknown }
}

/**
 * Present the commit coordinator as the existing SessionCoordinator surface.
 * Everything the SCL core implements is forwarded; the stage-based bootstrap
 * entry points are explicitly unsupported until the fork/team call sites move
 * to intents, so a caller fails loudly instead of silently degrading.
 * The managed-execution, ordering, revocation and task-document capabilities are
 * registered on this exact facade object, which is what the executor passes in.
 */
export function asSessionCoordinator(coordinator: CommitCoordinator, options: CommitFacadeOptions = {}): SessionCoordinator {
  const unsupported = <T>(): Promise<T> => Promise.reject(Object.assign(new Error('commit-log coordinator does not support the stage bootstrap API'), { code: 'TASK_TRANSITION_UNSUPPORTED' }))
  const coldWrites = createColdExecutionWrites()
  const ports = coordinator.capabilities()
  const facade: CommitCoordinator & Record<string, unknown> = {
    ...coordinator,
    create: async (meta?: Parameters<typeof coordinator.create>[0]) => {
      const result = await coordinator.create(meta)
      // The task registry loads the parent's task document before any save, so a
      // fresh session starts with the composition's empty document.
      if (options.taskDocument?.empty) await coordinator.putDocument('task-' + result.id, options.taskDocument.empty())
      return result
    },
    append: async (id: string, events: Parameters<typeof coordinator.append>[1]) => {
      const result = await coordinator.append(id, events)
      coldWrites.committed(id)
      return result
    },
    bootstrapSemanticTarget: () => unsupported(),
    // SCL birth is a single committed child creation; the legacy staged resume
    // protocol has no counterpart, so a passive replay is a clean refusal.
    resumeSemanticTarget: async () => ({ kind: 'not-issued' as const, reason: 'unsupported' as const }),
    async bootstrapSemanticTargetWithCapture(_request: BootstrapCaptureRequest, guards: BootstrapGuards, capture: () => Promise<BootstrapRequest>): Promise<BootstrapOutcome> {
      // SCL creates the child directly: the capture is the only source of the
      // seed, and the receipt is verified by the caller against it.
      const captured = await capture()
      guards.assertCurrent()
      try {
        const created = await coordinator.createChildSession(captured, { closure: captured.seed.dependencyDigest })
        // The capture's project intent also names the target's binding, which
        // the fork host re-reads before handing the target to the caller.
        const project = (_request as { requestIntent?: { project?: { kind?: string; projectId?: string } } }).requestIntent?.project
        if (project?.kind === 'project' && typeof project.projectId === 'string') {
          const key = 'desktop-session-project-' + createHash('sha256').update(captured.invocation.targetSessionId).digest('hex')
          if (await coordinator.getDocument(key) === undefined) await coordinator.putDocument(key, Object.freeze({ version: 1, projectId: project.projectId }))
        }
        return { kind: 'ready' as const, receipt: created.receipt, document: created.document }
      } catch (error) {
        if (error instanceof CommitLogConflictError) return { kind: 'refused' as const, reason: 'conflict' as const }
        throw error
      }
    },
    resumeChildTarget: coordinator.resumeChildTarget.bind(coordinator),
    bootstrapChildTargetWithCapture: coordinator.bootstrapChildTargetWithCapture.bind(coordinator),
    inspectBootstrap: async (invocation: { targetSessionId: string }) => ({ kind: 'absent', invocation, needsConfirmation: false }),
    inspectBootstrapCapture: async () => ({ kind: 'absent' }),
    revokeManagedDocumentNewWork: coordinator.revokeManagedDocumentNewWork.bind(coordinator),
    getDocument: coordinator.getDocument.bind(coordinator),
    putDocument: coordinator.putDocument.bind(coordinator),
    acquireExecution: coordinator.acquireExecution.bind(coordinator),
    retainExistingSessionBindingObservation: ports.observations.retainExistingSessionBindingObservation,
  }
  // Retained bindings validate against the coordinator that issued them; the
  // observations instance owns the reference ledger.
  ports.observations.associateRetainedCoordinator(facade as never)
  if (options.taskDocument) {
    associateTaskDocumentOperations(facade as never, createCommitTaskOperations(ports, {
      putDocument: (key, data) => coordinator.putDocument(key, data),
      getDocument: key => coordinator.getDocument(key),
    }, {
      validator: options.taskDocument.validator,
      ...(options.taskDocument.empty ? { empty: options.taskDocument.empty } : {}),
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
  return facade as unknown as SessionCoordinator
}