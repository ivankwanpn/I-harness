import type { SessionCoordinator } from './types.ts'
import { types } from 'node:util'

declare const deletionBrand: unique symbol
/** Issued only by the original lifecycle while its genuine turn is active. */
export interface DeletionPreparationScope {
  readonly [deletionBrand]: true
  readonly sessionId: string
  readonly manifest: Readonly<{ documents: readonly string[]; files?: readonly string[] }>
  assertCurrent(): void
  assertDocumentsCovered(keys: readonly string[]): void
  acquireTargets(ids: readonly string[]): Promise<void>
}
export interface DeletionParticipant {
  begin(scope: DeletionPreparationScope): { prepare(): Promise<void>; effect(): Promise<void>; close(): Promise<void> }
}
type Port = { installDeletionParticipant(participant: DeletionParticipant): void; captureDeletionScope(scope: DeletionPreparationScope): DeletionPreparationScope; retryDeletionCleanup(): Promise<void> }
const owners = new WeakMap<SessionCoordinator, { port: Port; deletion: SessionCoordinator['deleteOwnedSession'] }>()
export function associateDeletionPreparation(coordinator: SessionCoordinator, port: Port) {
  if (owners.has(coordinator)) throw new TypeError('Deletion owner already associated')
  owners.set(coordinator, { port, deletion: coordinator.deleteOwnedSession })
}
function original(coordinator: SessionCoordinator) {
  const owner = owners.get(coordinator), field = Object.getOwnPropertyDescriptor(coordinator, 'deleteOwnedSession')
  if (!owner || types.isProxy(coordinator) || !field || !('value' in field) || field.value !== owner.deletion || !owner.deletion) throw new TypeError('Original deletion coordinator required')
  return owner.port
}
export function installOriginalDeletionParticipant(coordinator: SessionCoordinator, participant: DeletionParticipant) { original(coordinator).installDeletionParticipant(participant) }
export function captureOriginalDeletionScope(coordinator: SessionCoordinator, scope: DeletionPreparationScope) { return original(coordinator).captureDeletionScope(scope) }
/** Drains only captured cleanup. Never discovers targets or repeats effects. */
export function retryOriginalDeletionCleanup(coordinator: SessionCoordinator) { return original(coordinator).retryDeletionCleanup() }

export function captureDeletionMethod<T extends object, K extends keyof T>(object: T, key: K): T[K] {
  if (!object || types.isProxy(object)) throw new TypeError('Original deletion participant required')
  const field = Object.getOwnPropertyDescriptor(object, key)
  if (!field || !('value' in field) || typeof field.value !== 'function' || types.isProxy(field.value)) throw new TypeError('Original deletion method required')
  return ((...args: unknown[]) => {
    const now = Object.getOwnPropertyDescriptor(object, key)
    if (!now || !('value' in now) || now.value !== field.value) throw new TypeError('Changed deletion method')
    return Reflect.apply(field.value, object, args)
  }) as T[K]
}
