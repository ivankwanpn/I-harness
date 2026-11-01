import type { SessionView } from '@i-harness/core-session'
import type { ManagedDocument, SessionCoordinator } from '@i-harness/session-persistence'
import { taskDocumentOperationsFor } from '@i-harness/session-persistence/internal/task-document-operations'

const issued = new WeakSet<object>()
export function captureOwnedTaskContext(coordinator: SessionCoordinator, document: ManagedDocument, view: SessionView, stateId: string) {
  const operations = taskDocumentOperationsFor(coordinator)
  if (!operations) return undefined
  const parent = operations.parent(document); operations.assertParentSession(parent, stateId)
  const descriptor = Object.getOwnPropertyDescriptor(document, 'view')
  if (!descriptor || !('value' in descriptor) || descriptor.value !== view) throw new Error('Original task parent unavailable')
  const context = Object.freeze({ operations, parent, coordinator, stateId, document }); issued.add(context); return context
}
export function isOwnedTaskContext(value: unknown): value is NonNullable<ReturnType<typeof captureOwnedTaskContext>> { return typeof value === 'object' && value !== null && issued.has(value) }
