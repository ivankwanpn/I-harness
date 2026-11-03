import type { TaskRegistry } from './types.ts'
import type { TaskPersistence } from './persistence.ts'
const owners = new WeakMap<TaskRegistry, TaskPersistence>()
export function associateTaskSaveOwner(registry: TaskRegistry, owner: TaskPersistence) { owners.set(registry, owner) }
export function lastOriginalTaskSave(registry: TaskRegistry) { return owners.get(registry)?.lastOwnedSave() }

/** Preserve only the existing last-save inspection for a mount's guarded view. */
export function associateTaskSaveFacade(facade: TaskRegistry, original: TaskRegistry) {
  const owner = owners.get(original)
  if (!owner || owners.has(facade)) throw new Error('Original task save owner unavailable')
  owners.set(facade, owner)
}
