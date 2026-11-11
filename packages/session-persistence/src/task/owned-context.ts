import type { SessionView } from '@i-harness/core-session'
import type { ManagedDocument } from '../coordinator/fact-types.ts'
import type { SessionCoordinator } from '../coordinator/types.ts'
import { taskDocumentOperationsFor } from '../coordinator/task-document-association.ts'
import {isManagedExecutionDomain,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'

const issued = new WeakSet<object>()
export function captureOwnedTaskContext(coordinator: SessionCoordinator, document: ManagedDocument | ManagedExecutionDomain['owner'], view: SessionView | ManagedExecutionDomain, stateId: string) {
  const operations = taskDocumentOperationsFor(coordinator)
  if (!operations) return undefined
  const parent = operations.parent(document); operations.assertParentSession(parent, stateId)
  if ('identity' in view) {
    if (!isManagedExecutionDomain(view) || view.owner !== document || view.sessionId !== stateId) throw new Error('Original task parent unavailable')
    view.assertCurrent()
  } else {
    const descriptor = Object.getOwnPropertyDescriptor(document, 'view')
    if (!descriptor || !('value' in descriptor) || descriptor.value !== view) throw new Error('Original task parent unavailable')
  }
  const context = Object.freeze({ operations, parent, coordinator, stateId, document }); issued.add(context); return context
}
export function isOwnedTaskContext(value: unknown): value is NonNullable<ReturnType<typeof captureOwnedTaskContext>> { return typeof value === 'object' && value !== null && issued.has(value) }
