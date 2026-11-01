import type { TaskIdentity, TaskRegistry } from './types.ts'

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

/** A restored binding is data, never an ordinary initial-launch admission. */
export function assertInitialTaskAdmission(registry: TaskRegistry, identity: TaskIdentity): void {
  // Anonymous lookup allocates identity state and can never adopt a prior task.
  if (identity.callEventSeq === undefined && identity.toolCallId === undefined) return
  assertColdTaskAdmission(registry, registry.getByIdentity(identity)?.id)
}

/** Registry admission supplies its private records lookup, not a replaceable public reader. */
export function assertColdTaskAdmission(registry: TaskRegistry, taskId: string | undefined): void {
  if (taskId !== undefined && owners.get(registry)?.().has('task:' + taskId)) {
    throw Object.assign(new Error('Restored cold bound task has no initial launch authority'), { code: 'TASK_COLD_BINDING_UNAVAILABLE' })
  }
}
