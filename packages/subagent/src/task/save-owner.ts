import type { TaskRegistry } from './types.ts'
import type { TaskPersistence } from './persistence.ts'
const owners = new WeakMap<TaskRegistry, TaskPersistence>()
export function associateTaskSaveOwner(registry: TaskRegistry, owner: TaskPersistence) { owners.set(registry, owner) }
export function lastOriginalTaskSave(registry: TaskRegistry) { return owners.get(registry)?.lastOwnedSave() }
