import type { SessionCoordinator } from '../coordinator/types.ts'
import { associateManagedExecution } from '../execution-internal.ts'
import { associateOriginalResultOrdering } from '../result-ordering-internal.ts'
import { associateOriginalResultRevocation } from '../coordinator/result-revocation.ts'
import { associateTaskDocumentOperations } from '../coordinator/task-document-association.ts'
import { associateColdExecutionWrites, createColdExecutionWrites } from '../coordinator/cold-execution-writes.ts'
import type { TaskDocumentConfiguration } from '../coordinator/task-document-operation.ts'
import type { CommitCoordinator } from './coordinator.ts'
import { createCommitCapabilities } from './capabilities.ts'

/**
 * Present the commit coordinator as the existing SessionCoordinator surface.
 * Everything the SCL core implements is forwarded; the stage-based bootstrap
 * entry points are explicitly unsupported until the fork/team call sites move
 * to intents, so a caller fails loudly instead of silently degrading.
 * The managed-execution, ordering and revocation capabilities are registered on
 * this exact facade object, which is what the session executor passes in.
 */
export type CommitFacadeOptions = {
  readonly taskDocument?: { readonly validator: TaskDocumentConfiguration['validator']; readonly empty?: () => unknown }
}

export function asSessionCoordinator(coordinator: CommitCoordinator, options: CommitFacadeOptions = {}): SessionCoordinator {
  const unsupported = <T>(): Promise<T> => Promise.reject(Object.assign(new Error('commit-log coordinator does not support the stage bootstrap API'), { code: 'TASK_TRANSITION_UNSUPPORTED' }))
  const coldWrites = createColdExecutionWrites()
  const facade: CommitCoordinator & Record<string, unknown> = {
    ...coordinator,
    create: async (meta?: Parameters<typeof coordinator.create>[0]) => {
      const result = await coordinator.create(meta)
      // The task registry loads the parent's task document before any save, so a
      // fresh session starts with the composition's empty document.
      if (options.taskDocument?.empty) await coordinator.putDocument(`task-${result.id}`, options.taskDocument.empty())
      return result
    },
    append: async (id: string, events: Parameters<typeof coordinator.append>[1]) => {
      const result = await coordinator.append(id, events)
      coldWrites.committed(id)
      return result
    },
    bootstrapSemanticTarget: () => unsupported(),
    resumeSemanticTarget: () => unsupported(),
    bootstrapSemanticTargetWithCapture: () => unsupported(),
    resumeChildTarget: coordinator.resumeChildTarget.bind(coordinator),
    bootstrapChildTargetWithCapture: coordinator.bootstrapChildTargetWithCapture.bind(coordinator),
    inspectBootstrap: async (invocation: { targetSessionId: string }) => ({ kind: 'absent', invocation, needsConfirmation: false }),
    inspectBootstrapCapture: async () => ({ kind: 'absent' }),
    revokeManagedDocumentNewWork: coordinator.revokeManagedDocumentNewWork.bind(coordinator),
    getDocument: coordinator.getDocument.bind(coordinator),
    putDocument: coordinator.putDocument.bind(coordinator),
    acquireExecution: coordinator.acquireExecution.bind(coordinator),
  }
  const capabilities = createCommitCapabilities(coordinator.storageRoot, {
    putDocument: (key, data) => coordinator.putDocument(key, data),
    getDocument: key => coordinator.getDocument(key),
    profile: id => coordinator.profile(id),
  }, { ...(options.taskDocument ? { taskDocument: options.taskDocument } : {}), sessionOfDocument: document => coordinator.sessionOfDocument(document) })
  if (capabilities.operations) associateTaskDocumentOperations(facade as never, capabilities.operations)
  associateColdExecutionWrites(facade as never, coldWrites)
  associateOriginalResultOrdering(facade as never, capabilities.ownership as never)
  associateOriginalResultRevocation(facade as never, capabilities.admission as never, capabilities.ownership as never)
  associateManagedExecution(facade, {
    acquire: id => coordinator.acquireExecution(id),
    assertAdmission: () => {},
  })
  return facade as unknown as SessionCoordinator
}
