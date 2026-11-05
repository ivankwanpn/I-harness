import type { SessionCoordinator } from '../coordinator/types.ts'
import { associateManagedExecution } from '../execution-internal.ts'
import { associateOriginalResultOrdering } from '../result-ordering-internal.ts'
import type { CommitCoordinator } from './coordinator.ts'

/**
 * Present the commit coordinator as the existing SessionCoordinator surface.
 * Everything the SCL core implements is forwarded; the stage-based bootstrap
 * entry points are explicitly unsupported until the fork/team call sites move
 * to intents, so a caller fails loudly instead of silently degrading.
 * The managed-execution attachment is registered on this exact facade object,
 * which is what the session executor passes to acquireManagedExecution.
 */
export function asSessionCoordinator(coordinator: CommitCoordinator): SessionCoordinator {
  const unsupported = <T>(): Promise<T> => Promise.reject(Object.assign(new Error('commit-log coordinator does not support the stage bootstrap API'), { code: 'TASK_TRANSITION_UNSUPPORTED' }))
  const facade: CommitCoordinator & Record<string, unknown> = {
    ...coordinator,
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
  // v1 ordering: the write lease serializes every writer of a session and the
  // commit log fixes the order, so a registration only needs a stable ledger
  // identity (no cross-session scheduling).
  associateOriginalResultOrdering(facade as never, Object.freeze({
    lockEnabled: true,
    beginResultOrderingRegistration() {
      let finished = false
      return Object.freeze({
        commit() { if (finished) throw new TypeError('Original ordering registration expired'); finished = true },
        cancel() { finished = true },
      })
    },
    async retryResultOrdering() {},
  }) as never)
  associateManagedExecution(facade, {
    acquire: id => coordinator.acquireExecution(id),
    // v1: admission currentness is enforced by the attachment's own guards; the
    // legacy check only fenced a capture/observation that SCL does not hold.
    assertAdmission: () => {},
  })
  return facade as unknown as SessionCoordinator
}
