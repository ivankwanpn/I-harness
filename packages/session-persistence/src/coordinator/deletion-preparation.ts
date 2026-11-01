import type { SessionCoordinator } from './types.ts'
import { types } from 'node:util'
import type { OriginalOwnershipBatch, OriginalOwnershipPlan, OwnershipCleanup, Ownership } from './ownership.ts'
import { assertOriginalOwnershipBatchCoverage, assertOriginalOwnershipPlanCoverage } from './ownership.ts'
import type { OriginalOrderingOrigin } from './result-ordering-types.ts'

declare const deletionBrand: unique symbol
/** Issued only by the original lifecycle while its genuine turn is active. */
export interface DeletionPreparationScope {
  readonly [deletionBrand]: true
  readonly sessionId: string
  readonly manifest: Readonly<{ documents: readonly string[]; files?: readonly string[] }>
  assertCurrent(): void
  assertDocumentsCovered(keys: readonly string[]): void
  planTargets(ids: readonly string[]): Promise<void>
  acquireTargets(ids: readonly string[]): Promise<void>
}
export interface DeletionParticipant {
  assertReady?(): void
  reserve?(origin: OriginalOrderingOrigin, retain: (reservation: OriginalDeletionReservation, cleanup: OwnershipCleanup) => void): OriginalDeletionReservation
  begin(scope: DeletionPreparationScope, reservation?: OriginalDeletionReservation): { prepare(): Promise<void>; effect(): Promise<void>; close(): Promise<void>; settle?(): Promise<void>; fail?(cause: unknown): void }
}
declare const reservationBrand: unique symbol
export interface OriginalDeletionReservation { readonly [reservationBrand]: true }
declare const cleanupBrand: unique symbol
export interface OriginalDeletionCleanup { readonly [cleanupBrand]: true }
const cleanups = new WeakMap<OriginalDeletionCleanup, { close(): Promise<void>; issued: boolean; settled: boolean; failure?: { cause: unknown }; flight?: Promise<void> }>()
const participantResults = new WeakMap<DeletionPreparationScope, { participant?: ReturnType<DeletionParticipant['begin']> }>()
export function beginOriginalDeletionParticipant(begin: DeletionParticipant['begin'], scope: DeletionPreparationScope, reservation?: OriginalDeletionReservation): ReturnType<DeletionParticipant['begin']> {
  if (participantResults.has(scope) || types.isProxy(scope)) throw TypeError('Original single deletion begin required')
  const record: { participant?: ReturnType<DeletionParticipant['begin']> } = {}; participantResults.set(scope, record)
  return record.participant = begin(scope, reservation)
}
/** Original Lifecycle captures the actual participant handler before prepare. */
export function captureOriginalDeletionCleanup(scope: DeletionPreparationScope, participant: ReturnType<DeletionParticipant['begin']>): OriginalDeletionCleanup {
  if (participantResults.get(scope)?.participant !== participant || types.isProxy(scope)) throw TypeError('Original Lifecycle participant required')
  captureDeletionMethod(participant, 'close')
  const close = Object.getOwnPropertyDescriptor(participant, 'close')!.value as () => Promise<void>
  const cleanup = Object.freeze({}) as OriginalDeletionCleanup
  cleanups.set(cleanup, { close: () => Reflect.apply(close, participant, []), issued: false, settled: false }); return cleanup
}
function originalCleanup(cleanup: OriginalDeletionCleanup) { const record = cleanups.get(cleanup); if (!record || types.isProxy(cleanup)) throw TypeError('Original deletion cleanup required'); return record }
export function originalDeletionCleanupIssued(cleanup: OriginalDeletionCleanup): boolean { return originalCleanup(cleanup).issued }
export function assertOriginalDeletionCleanupSettled(cleanup: OriginalDeletionCleanup): void {
  const record = originalCleanup(cleanup)
  if (!record.settled) { if (record.failure) throw record.failure.cause; throw Error('Original deletion cleanup unresolved') }
}
export function closeOriginalDeletionCleanup(cleanup: OriginalDeletionCleanup): Promise<void> {
  const record = originalCleanup(cleanup)
  if (record.settled) return Promise.resolve()
  if (record.flight) return record.flight
  record.issued = true
  const flight = (async () => { try { await record.close(); record.settled = true } catch (cause) { record.failure = { cause }; throw cause } })()
  record.flight = flight; void flight.finally(() => { if (record.flight === flight) record.flight = undefined }).catch(() => {}); return flight
}
type Port = { installDeletionParticipant(participant: DeletionParticipant): void; captureDeletionScope(scope: DeletionPreparationScope): DeletionPreparationScope; captureDeletionBatch(scope: DeletionPreparationScope): { batch: OriginalOwnershipBatch; cleanup: OwnershipCleanup }; captureDeletionPlan(scope: DeletionPreparationScope): { plan: OriginalOwnershipPlan; cleanup: OwnershipCleanup }; retryDeletionCleanup(): Promise<void> }
const owners = new WeakMap<SessionCoordinator, { port: Port; deletion: SessionCoordinator['deleteOwnedSession'] }>()
declare const selectionBrand: unique symbol
export interface OriginalDeletionSelection { readonly [selectionBrand]: true }
const selections = new WeakMap<OriginalDeletionSelection, readonly string[]>()
export function captureOriginalDeletionSelection(coordinator: SessionCoordinator, scope: DeletionPreparationScope): OriginalDeletionSelection {
  original(coordinator).captureDeletionScope(scope)
  const selection = Object.freeze({}) as OriginalDeletionSelection
  selections.set(selection, Object.freeze([...new Set([scope.sessionId, ...scope.manifest.documents])].sort())); return selection
}
export function originalDeletionSelectionIds(selection: OriginalDeletionSelection): readonly string[] {
  const ids = selections.get(selection)
  if (!ids || types.isProxy(selection)) throw TypeError('Original deletion selection required')
  return ids
}
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
export function captureOriginalDeletionBatch(coordinator: SessionCoordinator, scope: DeletionPreparationScope, owner: Ownership, ids: readonly string[]) {
  const port = original(coordinator)
  port.captureDeletionScope(scope)
  const captured = port.captureDeletionBatch(scope)
  assertOriginalOwnershipBatchCoverage(owner, captured.batch, ids)
  return captured
}
export function captureOriginalDeletionPlan(coordinator: SessionCoordinator, scope: DeletionPreparationScope, owner: Ownership, ids: readonly string[]) {
  const port = original(coordinator); port.captureDeletionScope(scope)
  const captured = port.captureDeletionPlan(scope)
  assertOriginalOwnershipPlanCoverage(owner, captured.plan, ids); return captured
}
export function originalDeletionPreparationAvailable(coordinator: SessionCoordinator): boolean { if (!owners.has(coordinator)) return false; original(coordinator); return true }
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
