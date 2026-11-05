import type { SessionCoordinator } from '../coordinator/types.ts'
import type { CommitCoordinator } from './coordinator.ts'

/**
 * Present the commit coordinator as the existing SessionCoordinator surface.
 * Everything the SCL core implements is forwarded; the stage-based bootstrap
 * entry points are explicitly unsupported until the fork/team call sites move
 * to intents, so a caller fails loudly instead of silently degrading.
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
  }
  return facade as unknown as SessionCoordinator
}
