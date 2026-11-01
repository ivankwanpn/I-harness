import type { SessionCoordinator } from './coordinator/types.ts'
import type { Ownership } from './coordinator/ownership.ts'
const owners = new WeakMap<SessionCoordinator, { owner: Ownership; create: SessionCoordinator['create'] }>()
export function associateOriginalResultOrdering(coordinator: SessionCoordinator, owner: Ownership) {
  if (owners.has(coordinator)) throw TypeError('Original result ordering already associated')
  owners.set(coordinator, { owner, create: coordinator.create })
}
export function beginOriginalResultOrderingRegistration(coordinator: SessionCoordinator, identity: object) {
  const record = owners.get(coordinator), create = Object.getOwnPropertyDescriptor(coordinator, 'create')
  if (!record || !create || !('value' in create) || create.value !== record.create) throw TypeError('Original result ordering coordinator required')
  return record.owner.beginResultOrderingRegistration(identity)
}
export function retryOriginalResultOrdering(coordinator: SessionCoordinator) {
  const record = owners.get(coordinator)
  if (!record) throw TypeError('Original result ordering coordinator required')
  return record.owner.retryResultOrdering()
}
