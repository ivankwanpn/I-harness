import type { SessionCoordinator } from './coordinator/types.ts'
import type { Ownership } from './coordinator/ownership.ts'
import type { OriginalOrderingRegistration, OriginalOrderingLedger } from './coordinator/result-ordering-types.ts'
import { types } from 'node:util'
type OrderingPort = Readonly<{ beginRegistration(identity: object): OriginalOrderingRegistration }>
const owners = new WeakMap<SessionCoordinator, { owner: Ownership; create: SessionCoordinator['create']; port: OrderingPort }>()
const registrations = new WeakMap<OriginalOrderingRegistration, { coordinator: SessionCoordinator; port: OrderingPort }>()
const ledgers = new WeakMap<Ownership, OriginalOrderingLedger>()
export function associateOriginalOrderingLedger(owner: Ownership, ledger: OriginalOrderingLedger): void {
  if (ledgers.has(owner)) throw TypeError('Original ordering ledger already associated')
  ledgers.set(owner, ledger)
}
export function originalOrderingLedgerFor(owner: Ownership): OriginalOrderingLedger {
  const original = ledgers.get(owner)
  if (!original || types.isProxy(owner)) throw TypeError('Original ordering owner required')
  return original
}
export function associateOriginalResultOrdering(coordinator: SessionCoordinator, owner: Ownership) {
  if (owners.has(coordinator)) throw TypeError('Original result ordering already associated')
  const create = coordinator.create
  const port: OrderingPort = Object.freeze({ beginRegistration(identity: object) {
    if (this !== port || originalResultOrderingFor(coordinator) !== port) throw TypeError('Original result ordering capability required')
    const registration = owner.beginResultOrderingRegistration(identity)
    registrations.set(registration, { coordinator, port }); return registration
  } })
  owners.set(coordinator, { owner, create, port })
}
export function captureOriginalResultOrderingRegistration(coordinator: SessionCoordinator, registration: OriginalOrderingRegistration): void {
  const original = registrations.get(registration)
  if (!original || original.coordinator !== coordinator || original.port !== originalResultOrderingFor(coordinator)) throw TypeError('Original coordinator ordering registration required')
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
