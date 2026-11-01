import { originalOrderingLedgerFor } from '../result-ordering-internal.ts'
import { types } from 'node:util'
import type { SessionCoordinator } from './types.ts'
import { assertOriginalBatchParticipant, reserveOriginalOwnershipBatch, assertOriginalOwnershipBatchCoverage, type OriginalOwnershipBatch, type Ownership, type OwnershipCleanup } from './ownership.ts'
import type { OriginalLegacyOrderingParticipant, OriginalOrderingOrigin } from './result-ordering-types.ts'
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
  joinLocalTargets(ticket: OriginalResultRevocationTicket, ids: readonly string[]): Promise<void>
  bindOriginalCoverage(ticket: OriginalResultRevocationTicket, coverage: OriginalRevocationCoverage): void
}
export type ResultRevocationRequest = Readonly<{ kind: 'workspace' | 'session'; sessionIds: readonly string[] }>
const scopes = new WeakMap<object, { admission: ResultRevocationAdmission; request: ResultRevocationRequest }>()
const admissions = new WeakSet<object>()
const participants = new WeakMap<object, Ownership>()
const admissionCoordinators = new WeakMap<ResultRevocationAdmission, Set<SessionCoordinator>>()
const coordinators = new WeakMap<SessionCoordinator, { admission: ResultRevocationAdmission; methods: Map<string, unknown> }>()
declare const domainBrand: unique symbol
export interface OriginalRevocationDomain { readonly [domainBrand]: true }
const domains = new WeakMap<OriginalRevocationDomain, { owner: Ownership; admissions: readonly ResultRevocationAdmission[] }>()
declare const coverageBrand: unique symbol
export interface OriginalRevocationCoverage { readonly [coverageBrand]: true }
type CoverageRecord = {
  owner: Ownership; ports: readonly ResultRevocationAdmission[]; tickets: readonly OriginalResultRevocationTicket[]; ids: readonly string[]
  batch?: OriginalOwnershipBatch; native?: OwnershipCleanup; locals: Map<ResultRevocationAdmission, { ticket: OriginalResultRevocationTicket; drain(): Promise<void> }>
  done: Promise<void>; retired: boolean; effectActive?: object; closing?: Promise<void>
}
const coverages = new WeakMap<OriginalRevocationCoverage, CoverageRecord>()
function coverageFor(coverage: OriginalRevocationCoverage): CoverageRecord {
  const original = coverages.get(coverage)
  if (!original || types.isProxy(coverage)) throw TypeError('Original native coverage required')
  return original
}
/** Called only by an authenticated original local ticket with its captured drain. */
export function bindOriginalRevocationLocal(coverage: OriginalRevocationCoverage, port: ResultRevocationAdmission, ticket: OriginalResultRevocationTicket, drain: () => Promise<void>): void {
  const original = coverageFor(coverage)
  if (!admissions.has(port) || participants.get(port) !== original.owner || original.ports[original.tickets.indexOf(ticket)] !== port || original.retired || original.closing) throw TypeError('Original matching local coverage required')
  if (original.locals.has(port)) throw TypeError('Original local coverage already bound')
  original.locals.set(port, { ticket, drain })
}
export function assertOriginalRevocationNative(coverage: OriginalRevocationCoverage, port: ResultRevocationAdmission, ticket: OriginalResultRevocationTicket, ids: readonly string[]): void {
  const original = coverageFor(coverage)
  if (original.retired || original.closing || original.locals.get(port)?.ticket !== ticket || participants.get(port) !== original.owner) throw TypeError('Original live native coverage required')
  if (!original.ids.length && !ids.length) return
  if (!original.batch) throw TypeError('Original native acquisition remains active')
  assertOriginalOwnershipBatchCoverage(original.owner, original.batch, ids)
}
export function assertOriginalRevocationCoverage(coverage: OriginalRevocationCoverage, ids: readonly string[]): void {
  const original = coverageFor(coverage)
  if (original.retired || original.closing) throw TypeError('Original active native coverage required')
  for (let index = 0; index < original.ports.length; index++) {
    const port = original.ports[index]!, coordinators = admissionCoordinators.get(port)
    if (!coordinators?.size) throw TypeError('Original coverage coordinator required')
    for (const coordinator of coordinators) if (originalResultRevocationFor(coordinator) !== port) throw TypeError('Changed original coverage coordinator')
    port.assertCovered(original.tickets[index]!, ids)
  }
}
export function beginOriginalRevocationEffect(coverage: OriginalRevocationCoverage) {
  const original = coverageFor(coverage)
  assertOriginalRevocationCoverage(coverage, original.ids)
  if (original.effectActive) throw Error('Original covered effect already active')
  const identity = {}; original.effectActive = identity
  const effect = Object.freeze({ close() { if (this !== effect || original.effectActive !== identity) throw TypeError('Original covered effect receiver required'); original.effectActive = undefined } })
  return effect
}
export function assertOriginalRevocationClose(coverage: OriginalRevocationCoverage): void {
  if (coverageFor(coverage).effectActive) throw Error('Original covered clear in progress')
}
export function closeOriginalRevocationCoverage(coverage: OriginalRevocationCoverage): Promise<void> {
  const original = coverageFor(coverage)
  if (original.retired) return Promise.resolve()
  if (original.effectActive) return Promise.reject(Error('Original covered clear in progress'))
  if (original.closing) return original.closing
  const flight = (async () => {
    await original.done
    for (const local of original.locals.values()) await local.drain()
    await original.native?.close(); original.native?.assertSettled()
    original.retired = true
  })()
  original.closing = flight; void flight.finally(() => { if (original.closing === flight) original.closing = undefined }).catch(() => {}); return flight
}
export async function acquireOriginalRevocationCoverage(domain: OriginalRevocationDomain, tickets: readonly OriginalResultRevocationTicket[], input: readonly string[], retain: (coverage: OriginalRevocationCoverage) => void, origin?: OriginalOrderingOrigin): Promise<OriginalRevocationCoverage> {
  const original = domains.get(domain)
  if (!original || types.isProxy(domain) || !Array.isArray(tickets) || types.isProxy(tickets) || tickets.length !== original.admissions.length) throw TypeError('Original complete domain required')
  const capturedTickets: OriginalResultRevocationTicket[] = []
  for (let index = 0; index < tickets.length; index++) {
    const field = Object.getOwnPropertyDescriptor(tickets, String(index))
    if (!field || !('value' in field)) throw TypeError('Original ticket array data required')
    capturedTickets.push(field.value)
  }
  const ids = captureResultTargetIds(input), done = Promise.withResolvers<void>(), coverage = Object.freeze({}) as OriginalRevocationCoverage
  const record: CoverageRecord = { owner: original.owner, ports: original.admissions, tickets: Object.freeze(capturedTickets), ids, locals: new Map(), done: done.promise, retired: false }
  coverages.set(coverage, record)
  try {
    retain(coverage)
    // Every local owner retains this original acquisition before its first wait.
    for (let index = 0; index < record.ports.length; index++) record.ports[index]!.bindOriginalCoverage(record.tickets[index]!, coverage)
    await Promise.all(record.ports.map((port, index) => port.joinLocalTargets(record.tickets[index]!, ids)))
    if (ids.length) record.batch = await reserveOriginalOwnershipBatch(record.owner, ids, cleanup => { record.native = cleanup }, origin)
    if (ids.length) assertOriginalRevocationCoverage(coverage, ids)
    return coverage
  } finally { done.resolve() }
}
function originalDomain(domain: OriginalRevocationDomain) {
  const record = domains.get(domain)
  if (!record || types.isProxy(domain)) throw TypeError('Original revocation domain required')
  return record
}
export function beginOriginalRevocationOrdering(domain: OriginalRevocationDomain): OriginalOrderingOrigin { return originalOrderingLedgerFor(originalDomain(domain).owner).begin() }
export function runOriginalRevocationOrdering<T>(domain: OriginalRevocationDomain, origin: OriginalOrderingOrigin, work: () => Promise<T>): Promise<T> { return originalOrderingLedgerFor(originalDomain(domain).owner).run(origin, work) }
export function joinOriginalRevocationPredecessors(domain: OriginalRevocationDomain, origin: OriginalOrderingOrigin): Promise<void> | undefined { return originalOrderingLedgerFor(originalDomain(domain).owner).predecessors(origin)?.join() }
export function completeOriginalRevocationOrdering(domain: OriginalRevocationDomain, origin: OriginalOrderingOrigin): void { originalOrderingLedgerFor(originalDomain(domain).owner).complete(origin) }
export function assertOutsideOriginalRevocationOrdering(domain: OriginalRevocationDomain): void { originalOrderingLedgerFor(originalDomain(domain).owner).assertOutside() }
/** Native identity is the original owner object, never a matching pathname. */
export function captureOriginalRevocationDomain(input: readonly ResultRevocationAdmission[]): OriginalRevocationDomain {
  if (!Array.isArray(input) || types.isProxy(input) || !input.length) throw TypeError('Original revocation topology required')
  const ports: ResultRevocationAdmission[] = []
  let owner: Ownership | undefined
  for (let index = 0; index < input.length; index++) {
    const field = Object.getOwnPropertyDescriptor(input, String(index)), port = field && 'value' in field ? field.value as ResultRevocationAdmission : undefined
    if (!port || !admissions.has(port) || types.isProxy(port)) throw TypeError('Original revocation admission required')
    const current = participants.get(port)!
    if (owner && owner !== current) throw Error('Distinct original Ownership topology unsupported')
    owner = current; if (!ports.includes(port)) ports.push(port)
  }
  const domain = Object.freeze({}) as OriginalRevocationDomain
  domains.set(domain, { owner: owner!, admissions: Object.freeze(ports) }); return domain
}

export function associateOriginalResultRevocation(coordinator: SessionCoordinator, admission: ResultRevocationAdmission, owner: Ownership) {
  if (coordinators.has(coordinator)) throw TypeError('Original revocation already associated')
  if (admissions.has(admission) && participants.get(admission) !== owner) throw TypeError('Changed original admission native owner')
  const methods = new Map(['create', 'withSessionBindingObservation', 'deleteOwnedSession'].map(key => [key, Object.getOwnPropertyDescriptor(coordinator, key)?.value]))
  coordinators.set(coordinator, { admission, methods }); admissions.add(admission); participants.set(admission, owner)
  let aliases = admissionCoordinators.get(admission); if (!aliases) { aliases = new Set(); admissionCoordinators.set(admission, aliases) }; aliases.add(coordinator)
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
