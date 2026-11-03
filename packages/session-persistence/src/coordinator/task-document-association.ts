import type { SessionCoordinator } from './types.ts'
import type { createTaskDocumentOperations } from './task-document-operation.ts'
const owners = new WeakMap<SessionCoordinator, ReturnType<typeof createTaskDocumentOperations>>()
export function associateTaskDocumentOperations(coordinator: SessionCoordinator, operations: ReturnType<typeof createTaskDocumentOperations>) { owners.set(coordinator, operations) }
export function taskDocumentOperationsFor(coordinator: SessionCoordinator) { return owners.get(coordinator) }
