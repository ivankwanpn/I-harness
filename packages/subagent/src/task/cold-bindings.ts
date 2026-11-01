import type { TaskRegistry } from './types.ts'

// The association belongs to the installed registry, never to a caller's row.
const owners = new WeakMap<TaskRegistry, () => ReadonlySet<string>>()
export function associateColdBindings(registry: TaskRegistry, read: () => ReadonlySet<string>): void { owners.set(registry, read) }
export function forwardColdBindings(facade: TaskRegistry, owner: TaskRegistry): void {
  const read = owners.get(owner)
  if (read) owners.set(facade, read)
}
export function isColdBoundChild(registry: TaskRegistry | undefined, child: string, taskId?: string): boolean {
  return registry !== undefined && ((owners.get(registry)?.().has(child) || taskId !== undefined && owners.get(registry)?.().has('task:' + taskId)) ?? false)
}
