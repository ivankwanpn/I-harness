import type { SessionCoordinator } from './types.ts'
import type { createTaskDocumentTransitions } from './task-document-transition.ts'
const owners = new WeakMap<SessionCoordinator, ReturnType<typeof createTaskDocumentTransitions>>()
export function associateTaskDocumentTransitions(coordinator: SessionCoordinator, owner: ReturnType<typeof createTaskDocumentTransitions>) { owners.set(coordinator, owner) }
export function taskDocumentTransitionCleanupFor(coordinator: SessionCoordinator, error: unknown) { return owners.get(coordinator)?.cleanupFor(error) }
