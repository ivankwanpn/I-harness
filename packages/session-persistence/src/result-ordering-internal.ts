import type { SessionCoordinator } from './coordinator/types.ts'
import type { Ownership } from './coordinator/ownership.ts'
import type { OriginalOrderingRegistration } from './coordinator/result-ordering-types.ts'
type OrderingPort = Readonly<{ beginRegistration(identity: object): OriginalOrderingRegistration }>
const owners = new WeakMap<SessionCoordinator, { owner: Ownership; create: SessionCoordinator['create']; port: OrderingPort }>()
export function associateOriginalResultOrdering(coordinator: SessionCoordinator, owner: Ownership) {
  if (owners.has(coordinator)) throw TypeError('Original result ordering already associated')
  const create = coordinator.create
  const port: OrderingPort = Object.freeze({ beginRegistration(identity: object) {
    if (this !== port || originalResultOrderingFor(coordinator) !== port) throw TypeError('Original result ordering capability required')
    return owner.beginResultOrderingRegistration(identity)
  } })
  owners.set(coordinator, { owner, create, port })
}
export function originalResultOrderingFor(coordinator: SessionCoordinator): OrderingPort | undefined {
  const record = owners.get(coordinator)
  if (!record) return undefined
  const create = Object.getOwnPropertyDescriptor(coordinator, 'create')
  if (!create || !('value' in create) || create.value !== record.create) throw TypeError('Original result ordering coordinator required')
  return record.owner.lockEnabled ? record.port : undefined
}
export function beginOriginalResultOrderingRegistration(coordinator: SessionCoordinator, identity: object) {
  const port = originalResultOrderingFor(coordinator)
  if (!port) throw TypeError('Original result ordering coordinator required')
  return port.beginRegistration(identity)
}
export function retryOriginalResultOrdering(coordinator: SessionCoordinator) {
  const record = owners.get(coordinator)
  if (!record) throw TypeError('Original result ordering coordinator required')
  return record.owner.retryResultOrdering()
}
