import { types } from 'node:util'
import type { SessionCoordinator } from './types.ts'
import { assertOriginalBatchParticipant, type Ownership } from './ownership.ts'
import type { OriginalLegacyOrderingParticipant } from './result-ordering-types.ts'
import { captureResultTargetIds } from './result-revocation-data.ts'

declare const scopeBrand: unique symbol
declare const ticketBrand: unique symbol
export interface OriginalResultRevocationScope { readonly [scopeBrand]: true }
export interface OriginalResultRevocationTicket {
  readonly [ticketBrand]: true
  assertCurrent(): void
  join(): Promise<void>
  close(): Promise<void>
}
export interface ResultRevocationAdmission {
  begin(scope: OriginalResultRevocationScope): OriginalResultRevocationTicket
  acquireTargets(ticket: OriginalResultRevocationTicket, ids: readonly string[]): Promise<void>
  assertCovered(ticket: OriginalResultRevocationTicket, ids: readonly string[]): void
  retainCleanup(ticket: OriginalResultRevocationTicket, cleanup: Readonly<{ assertSettled(): void; close(): Promise<void> }>): void
}
export type ResultRevocationRequest = Readonly<{ kind: 'workspace' | 'session'; sessionIds: readonly string[] }>
const scopes = new WeakMap<object, { admission: ResultRevocationAdmission; request: ResultRevocationRequest }>()
const admissions = new WeakSet<object>()
const participants = new WeakMap<object, Ownership>()
const coordinators = new WeakMap<SessionCoordinator, { admission: ResultRevocationAdmission; methods: Map<string, unknown> }>()

export function associateOriginalResultRevocation(coordinator: SessionCoordinator, admission: ResultRevocationAdmission, owner: Ownership) {
  if (coordinators.has(coordinator)) throw TypeError('Original revocation already associated')
  const methods = new Map(['create', 'withSessionBindingObservation', 'deleteOwnedSession'].map(key => [key, Object.getOwnPropertyDescriptor(coordinator, key)?.value]))
  coordinators.set(coordinator, { admission, methods }); admissions.add(admission); participants.set(admission, owner)
}
export function originalResultRevocationFor(coordinator: SessionCoordinator): ResultRevocationAdmission {
  const original = coordinators.get(coordinator)
  if (!original || types.isProxy(coordinator)) throw TypeError('Original revocation coordinator required')
  for (const [key, value] of original.methods) {
    const now = Object.getOwnPropertyDescriptor(coordinator, key)
    if ((now && !('value' in now)) || now?.value !== value) throw TypeError('Changed original revocation coordinator')
  }
  return original.admission
}
/** Request data selects work; only the original admission can issue coverage. */
export function issueOriginalResultRevocationScope(admission: ResultRevocationAdmission, request: ResultRevocationRequest, participant: OriginalLegacyOrderingParticipant): OriginalResultRevocationScope {
  if (!admissions.has(admission) || !request || types.isProxy(request)) throw TypeError('Invalid original revocation request')
  const kind = Object.getOwnPropertyDescriptor(request, 'kind'), ids = Object.getOwnPropertyDescriptor(request, 'sessionIds')
  if (!kind || !ids || !('value' in kind) || !('value' in ids) || !['workspace', 'session'].includes(kind.value)) throw TypeError('Original revocation request data required')
  const captured = captureResultTargetIds(ids.value)
  assertOriginalBatchParticipant(participants.get(admission)!, participant)
  const scope = Object.freeze({}) as OriginalResultRevocationScope
  scopes.set(scope, { admission, request: Object.freeze({ kind: kind.value, sessionIds: captured }) })
  return scope
}
export function captureOriginalResultRevocationRequest(admission: ResultRevocationAdmission, scope: OriginalResultRevocationScope) {
  const original = scopes.get(scope)
  if (!original || original.admission !== admission || types.isProxy(scope)) throw TypeError('Original revocation scope required')
  return original.request
}
