import { associateManagedResultRefusal } from './artifact/result-capabilities.ts'
import { captureResultTargetIds } from '../../session-persistence/src/coordinator/result-revocation-data.ts'
import { fields, captureTarget } from './artifact/transfer-codec.ts'
import { createArtifactQualificationIO } from './artifact/qualification-io.ts'
import { canonicalJsonData } from '@i-harness/core-session'
import { originalResultRevocationFor, beginOriginalRevocationOrdering, runOriginalRevocationOrdering, joinOriginalRevocationPredecessors, completeOriginalRevocationOrdering, assertOutsideOriginalRevocationOrdering, captureOriginalRevocationDomain, acquireOriginalRevocationCoverage, assertOriginalRevocationCoverage, closeOriginalRevocationCoverage, beginOriginalRevocationEffect, type OriginalRevocationCoverage, issueOriginalResultRevocationScope, type OriginalResultRevocationTicket, type ResultRevocationAdmission } from '../../session-persistence/src/coordinator/result-revocation.ts'
import type { WorkspaceMutationCleanup } from './workspace-mutation.ts'
import { captureOriginalDeletionScope, captureOriginalDeletionSelection, originalDeletionSelectionIds, originalDeletionPreparationAvailable, installOriginalDeletionParticipant, type OriginalDeletionReservation, type DeletionPreparationScope, type OriginalDeletionSelection } from '../../session-persistence/src/coordinator/deletion-preparation.ts'
import { borrowOriginalDeletionCoverage, attachOriginalDeletionCoverage, drainOriginalRevocationCoverage, issueOriginalDeletionRevocationScope, assertOriginalRevocationOrdering } from '../../session-persistence/src/coordinator/result-revocation.ts'
export interface OriginalResultRevocationPreparation { readonly frontier: number; assertCovered(ids: readonly string[]): void; close(): Promise<void> }
export interface OriginalResultRevocationRequest { readonly kind: 'workspace' | 'session'; readonly sessionIds: readonly string[]; readonly documents: readonly string[] }
const revocationPreparers = new WeakMap<ContextOutputService, (coordinator: SessionCoordinator, request: OriginalResultRevocationRequest, retain: (cleanup: OriginalResultRevocationPreparation) => void) => Promise<OriginalResultRevocationPreparation>>()
export function prepareOriginalResultRevocation(service: ContextOutputService, coordinator: SessionCoordinator, request: OriginalResultRevocationRequest, retain: (cleanup: OriginalResultRevocationPreparation) => void) {
  const prepare = revocationPreparers.get(service)
  if (!prepare) throw TypeError('Original result service required')
  return prepare(coordinator, request, retain)
}
import type { SeedDependencyTransferScope } from './artifact/bootstrap-transfer.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access as fileAccess } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkAbort, serializedBytes } from './bytes.ts'
import { configureContext, DEFAULT_CONTEXT_OUTPUT_CONFIG, identity, integer } from './config.ts'
import { ContextStore } from './store.ts'
import type { ContextAccess, ContextOutputOptions, ContextOutputService, ContextOutputStatus, ContextResultRef } from './types.ts'
import { createArtifactOwnership } from './artifact/ownership.ts'
type CodeManifestQuery = ReturnType<typeof createArtifactOwnership>['captureConfirmedCodeManifest']
const codeManifestQueries = new WeakMap<ContextOutputService, CodeManifestQuery>()
const codeManifestScopeQueries = new WeakMap<ContextOutputService, (scope:Parameters<CodeManifestQuery>[0])=>void>()
declare const codeManifestAdapterBrand: unique symbol, codeManifestReceiptBrand: unique symbol
export type OriginalCodeManifestAdapter = Readonly<{[codeManifestAdapterBrand]:true}>
export type OriginalCodeManifestReceipt = Readonly<{[codeManifestReceiptBrand]:true}>
const codeManifestAdapters = new WeakMap<OriginalCodeManifestAdapter,{service:ContextOutputService;scope:Parameters<CodeManifestQuery>[0]}>()
const codeManifestHistory = new WeakMap<OriginalCodeManifestReceipt,ReturnType<CodeManifestQuery>>()
function copyCodeManifestHistory(snapshot:ReturnType<CodeManifestQuery>):ReturnType<CodeManifestQuery> {
  // The existing source codec rejects extras and non-scalar optional fields
  // before history can retain any arbitrary nested object from a live owner.
  captureTarget({source:snapshot.source,revision:'confirmation-history'})
  if(Buffer.byteLength(canonicalJsonData(snapshot))>65536)throw new Error('Original confirmation metadata exceeds limit')
  const {source,ref}=snapshot
  return Object.freeze({operationId:snapshot.operationId,sessionId:snapshot.sessionId,callId:snapshot.callId,
    source:Object.freeze({sourceId:source.sourceId,...source.path!==undefined?{path:source.path}:{},...source.revision!==undefined?{revision:source.revision}:{},...source.readonly!==undefined?{readonly:source.readonly}:{}}),
    ref:Object.freeze({version:ref.version,id:ref.id,revision:ref.revision,codec:ref.codec,encodedBytes:ref.encodedBytes,contentDigest:ref.contentDigest,completeness:ref.completeness})})
}
export function captureOriginalCodeManifestAdapter(service:ContextOutputService, scope:Parameters<CodeManifestQuery>[0]):OriginalCodeManifestAdapter {
  const query=codeManifestScopeQueries.get(service)
  if(!query)throw new Error('Original context output service required')
  query(scope)
  const adapter=Object.freeze({}) as OriginalCodeManifestAdapter
  codeManifestAdapters.set(adapter,{service,scope})
  return adapter
}
export function captureCodeManifestConfirmation(adapter:OriginalCodeManifestAdapter, sink:Parameters<CodeManifestQuery>[1], expected:Parameters<CodeManifestQuery>[2]):OriginalCodeManifestReceipt {
  const original=codeManifestAdapters.get(adapter)
  if(!original)throw new Error('Original manifest adapter required')
  const query=codeManifestQueries.get(original.service)
  if(!query)throw new Error('Original context output service required')
  const snapshot=copyCodeManifestHistory(query(original.scope,sink,expected))
  const receipt=Object.freeze({}) as OriginalCodeManifestReceipt
  codeManifestHistory.set(receipt,snapshot)
  return receipt
}
export function readCodeManifestConfirmationHistory(receipt:OriginalCodeManifestReceipt) {
  const snapshot=codeManifestHistory.get(receipt)
  if(!snapshot)throw new Error('Original confirmation receipt required')
  return copyCodeManifestHistory(snapshot)
}
declare const confirmedCodeManifestBrand: unique symbol
export type OriginalConfirmedCodeManifest = Readonly<{[confirmedCodeManifestBrand]:true}>
const codeManifestProofs=new WeakMap<OriginalConfirmedCodeManifest,{service:ContextOutputService;args:Parameters<CodeManifestQuery>}>()
export function captureConfirmedCodeManifest(service: ContextOutputService, ...args: Parameters<CodeManifestQuery>):OriginalConfirmedCodeManifest {
  const query = codeManifestQueries.get(service)
  if (!query) throw new Error('Original context output service required')
  const snapshot=query(...args),proof=Object.freeze({}) as OriginalConfirmedCodeManifest
  codeManifestProofs.set(proof,{service,args:[args[0],args[1],snapshot]})
  return proof
}
export function readConfirmedCodeManifest(service:ContextOutputService,proof:OriginalConfirmedCodeManifest) {
  const original=codeManifestProofs.get(proof),query=codeManifestQueries.get(service)
  if(!original||original.service!==service||!query)throw new Error('Original confirmed Code manifest required')
  return query(...original.args)
}
import { captureLegacy } from './legacy/capture.ts'
import { readLegacy, searchLegacy } from './legacy/query.ts'
import { createWorkspaceMutationOwner, failuresTogether, type WorkspaceMutationTurn } from './workspace-mutation.ts'
import { createLegacyForkOwner } from './legacy/fork-transfer.ts'
import { captureObservation, observedAllowed, prepareObservedIndex } from './legacy/observed-read.ts'
import { createLegacyUseGate, type LegacyUseLease } from './legacy/use-gate.ts'
import type { IndexedLegacyContext } from './legacy/index-lifecycle.ts'
import { commitment } from './legacy/fork-codec.ts'
import type { LegacyReadObservation, LegacyReadQuery, LegacySearchQuery } from './legacy/fork-types.ts'
import { createSelectedMetadata, createColdSelectedMetadata } from './legacy/selected-metadata.ts'
import { captureOriginalColdObservation, type ColdSelectedObservation } from '../../session-persistence/src/selected-source-owner.ts'
import type { SessionCoordinator } from '../../session-persistence/src/coordinator/types.ts'
import type { OriginalLegacyOrderingParticipant, OriginalOrderingReservation, OriginalOrderingRegistration, OriginalOrderingOrigin } from '../../session-persistence/src/coordinator/result-ordering-types.ts'
import { beginOriginalResultOrderingRegistration, captureOriginalResultOrderingRegistration } from '../../session-persistence/src/result-ordering-internal.ts'
import type { createSeedDependencyTransfer } from './artifact/bootstrap-transfer.ts'

type ColdManagedOwner = Pick<ReturnType<typeof createSeedDependencyTransfer>, 'acquireColdManagedQualification' | 'revokeColdTransfers'>
type LegacyOrderingOwner = { participant: OriginalLegacyOrderingParticipant; coordinators: Map<SessionCoordinator, ReturnType<typeof originalResultRevocationFor>>; operations: Set<object> }
const legacyOrderingOwners = new WeakMap<ContextOutputService, LegacyOrderingOwner>()
type DeletionWork = { snapshot(cutoff: number): Promise<{ identity: string; targets: readonly string[] }>; bind(coverage: OriginalRevocationCoverage): void; effect(): Promise<void>; close(): Promise<void>; assertSettled(): void; settle(): void; fail(cause: unknown): void }
type DeletionFactory = (coordinator: SessionCoordinator, scope: DeletionPreparationScope, selection: OriginalDeletionSelection, reservation: OriginalDeletionReservation) => DeletionWork
const deletionOwners = new WeakMap<ContextOutputService, DeletionFactory>()
// Membership is part of the original construction relation, not a runtime selector.
const deletionMembers = new WeakMap<SessionCoordinator, { services: Set<ContextOutputService>; active: Set<object> }>()
type DeletionMember = { service: ContextOutputService; topology: LegacyOrderingOwner; create: DeletionFactory }
type DeletionTopology = { membership: NonNullable<ReturnType<typeof deletionMembers.get>>; members: readonly DeletionMember[]; domain?: ReturnType<typeof captureOriginalRevocationDomain>; ports: readonly ResultRevocationAdmission[]; done: PromiseWithResolvers<void>; begun: boolean; settled: boolean; closed: boolean; failure?: { cause: unknown } }
const deletionTopologies = new WeakMap<OriginalDeletionReservation, DeletionTopology>()
function stageOriginalDeletionService(service: ContextOutputService, coordinator: SessionCoordinator): () => void {
  if (!originalDeletionPreparationAvailable(coordinator)) return () => {}
  let membership = deletionMembers.get(coordinator)
  if (!membership) {
    membership = { services: new Set(), active: new Set() }
    const captured = membership
    installOriginalDeletionParticipant(coordinator, Object.freeze({ assertReady() {
      const ports: ResultRevocationAdmission[] = []
      for (const service of captured.services) {
        const topology = legacyOrderingOwners.get(service)
        if (!topology || !deletionOwners.has(service) || !topology.coordinators.has(coordinator)) throw Error('Original deletion service unavailable')
        for (const [owner, port] of topology.coordinators) { if (originalResultRevocationFor(owner) !== port) throw Error('Changed original deletion coordinator'); ports.push(port) }
      }
      if (ports.length) captureOriginalRevocationDomain(ports)
    }, reserve(origin: OriginalOrderingOrigin, retain: (reservation: OriginalDeletionReservation, cleanup: import('../../session-persistence/src/coordinator/ownership.ts').OwnershipCleanup) => void) {
      const reservation = Object.freeze({}) as OriginalDeletionReservation
      const record: DeletionTopology = { membership: captured, members: [], ports: [], done: Promise.withResolvers<void>(), begun: false, settled: false, closed: false }
      deletionTopologies.set(reservation, record); void record.done.promise.catch(() => {})
      const cleanup = Object.freeze({ assertSettled() { if (!record.closed) throw Error('Original deletion topology cleanup unresolved') }, async close() {
        if (record.closed) return
        if (record.begun && !record.settled) { if (record.failure) throw record.failure.cause; throw Error('Original deletion aggregate cleanup unresolved') }
        for (const member of record.members) member.topology.operations.delete(reservation)
        captured.active.delete(reservation); record.closed = true; record.done.resolve()
      } })
      // The original attempt owns this exact cleanup before any fence can fail.
      retain(reservation, cleanup)
      record.members = Object.freeze([...captured.services].map(service => {
        const topology = legacyOrderingOwners.get(service), create = deletionOwners.get(service)
        if (!topology || !create || !topology.coordinators.has(coordinator)) throw Error('Original deletion service unavailable')
        return { service, topology, create }
      }))
      record.ports = Object.freeze([...new Set(record.members.flatMap(member => [...member.topology.coordinators.values()]))])
      for (const member of record.members) for (const [owner, port] of member.topology.coordinators) if (originalResultRevocationFor(owner) !== port) throw TypeError('Changed original deletion coordinator')
      if (record.ports.length) { record.domain = captureOriginalRevocationDomain(record.ports); assertOriginalRevocationOrdering(record.domain, origin) }
      captured.active.add(reservation); for (const member of record.members) member.topology.operations.add(reservation)
      return reservation
    }, begin(input: DeletionPreparationScope, reservation?: OriginalDeletionReservation) {
      const record = reservation && deletionTopologies.get(reservation)
      if (!record || record.membership !== captured || record.closed || record.begun) throw TypeError('Original retained deletion topology required')
      const scope = captureOriginalDeletionScope(coordinator, input), selection = captureOriginalDeletionSelection(coordinator, scope)
      const members = record.members, ports = record.ports, domain = record.domain, works: DeletionWork[] = [], tickets: OriginalResultRevocationTicket[] = []
      if (captured.services.size !== members.length || members.some(member => !captured.services.has(member.service) || !member.topology.operations.has(reservation!))) throw Error('Original deletion topology changed')
      record.begun = true
      let coverage: OriginalRevocationCoverage | undefined, targets: readonly string[] = [], prepared = false, issued = false, closedWork = false, settled = false
      const check = () => { scope.assertCurrent(); if (captured.services.size !== members.length || members.some(member => !captured.services.has(member.service))) throw Error('Original deletion topology changed'); for (const member of members) for (const [owner, port] of member.topology.coordinators) if (originalResultRevocationFor(owner) !== port) throw Error('Changed original deletion coordinator') }
      const operation = Object.freeze({
        async prepare() {
          if (this !== operation || prepared) throw TypeError('Original deletion preparation required')
          try {
            check()
            for (const member of members) works.push(member.create(coordinator, scope, selection, reservation!))
            for (const port of ports) {
              const member = members.find(member => [...member.topology.coordinators.values()].includes(port))!
              tickets.push(port.begin(issueOriginalDeletionRevocationScope(port, coordinator, scope, member.topology.participant)))
            }
            for (let index = 0; index < ports.length; index++) for (const work of works) ports[index]!.retainCleanup(tickets[index]!, work)
            const first = await Promise.all(works.map(work => work.snapshot(Date.now()))); check()
            targets = Object.freeze([...new Set([scope.sessionId, ...first.flatMap(value => value.targets)])].sort())
            await scope.planTargets(targets); check()
            if (domain) coverage = await borrowOriginalDeletionCoverage(domain, coordinator, scope, tickets, targets, value => { coverage = value })
            await scope.acquireTargets(targets); check()
            if (coverage) attachOriginalDeletionCoverage(coverage, coordinator, scope)
            if (coverage) for (const work of works) work.bind(coverage)
            const frontier = Date.now(), second = await Promise.all(works.map(work => work.snapshot(frontier))); check()
            if (first.some((value, index) => canonicalJsonData(value) !== canonicalJsonData(second[index]))) throw Error('Original deletion inventory changed')
            if (coverage) assertOriginalRevocationCoverage(coverage, targets)
            prepared = true
          } catch (cause) { for (const work of works) work.fail(cause); throw cause }
        },
        async effect() {
          if (this !== operation || !prepared || issued) throw TypeError('Original single deletion effect required')
          check(); scope.assertDocumentsCovered(scope.manifest.documents); if (coverage) assertOriginalRevocationCoverage(coverage, targets)
          issued = true
          const active = coverage && beginOriginalRevocationEffect(coverage)
          try { for (const work of works) { check(); scope.assertDocumentsCovered(scope.manifest.documents); await work.effect() } }
          catch (cause) { for (const work of works) work.fail(cause); throw cause }
          finally { active?.close() }
        },
        async close() {
          if (this !== operation) throw TypeError('Original deletion cleanup required')
          if (closedWork) return
          if (coverage) await drainOriginalRevocationCoverage(coverage)
          else for (const work of works) { await work.close(); work.assertSettled() }
          closedWork = true
        },
        async settle() {
          if (this !== operation || !closedWork) throw TypeError('Original deletion cleanup not acknowledged')
          if (settled) return
          if (coverage) await closeOriginalRevocationCoverage(coverage)
          for (const ticket of tickets) await ticket.close()
          for (const work of works) work.settle()
          settled = true; record.settled = true
        },
        fail(cause: unknown) { if (this !== operation) throw TypeError('Original deletion failure receiver required'); record.failure = { cause }; record.done.reject(cause); for (const work of works) work.fail(cause) },
      })
      return operation
    } }))
    deletionMembers.set(coordinator, membership)
  }
  if (membership.active.size) throw Error('Original deletion registration busy')
  const captured = membership
  return () => { captured.services.add(service) }
}
export function hasOriginalDeletionService(service: ContextOutputService, coordinator: SessionCoordinator): boolean { return deletionMembers.get(coordinator)?.services.has(service) === true }
const orderingRequired = new WeakSet<ContextOutputService>(), orderingConfigured = new WeakSet<ContextOutputService>()
export function requireOriginalLegacyOrdering(service: ContextOutputService) {
  if (!legacyOrderingOwners.has(service)) throw TypeError('Original legacy ordering service required')
  orderingRequired.add(service)
}
export function commitOriginalLegacyOrdering(service: ContextOutputService, registration: OriginalOrderingRegistration, coordinator: SessionCoordinator) {
  const original = legacyOrderingOwners.get(service)
  if (!original) throw TypeError('Original legacy ordering service required')
  if (original.operations.size) throw Error('Original result topology operation busy')
  captureOriginalResultOrderingRegistration(coordinator, registration)
  const admission = originalResultRevocationFor(coordinator)
  const commitDeletion = stageOriginalDeletionService(service, coordinator)
  registration.commit(original.participant); original.coordinators.set(coordinator, admission); orderingConfigured.add(service); commitDeletion()
}
export function registerOriginalLegacyOrdering(service: ContextOutputService, coordinator: SessionCoordinator) {
  const original = legacyOrderingOwners.get(service)
  if (!original) throw TypeError('Original legacy ordering service required')
  if (original.operations.size) throw Error('Original result topology operation busy')
  const registration = beginOriginalResultOrderingRegistration(coordinator, service)
  try { commitOriginalLegacyOrdering(service, registration, coordinator) } catch (failure) { registration.cancel(); throw failure }
}
const coldManagedOwners = new WeakMap<ContextOutputService, ColdManagedOwner>()
export function acquireColdManagedQualification(service: ContextOutputService, ...args: Parameters<ColdManagedOwner['acquireColdManagedQualification']>) {
  const original = coldManagedOwners.get(service); if (!original) throw Error('Original context service required')
  return original.acquireColdManagedQualification(...args)
}
export function revokeColdManagedQualifications(service: ContextOutputService, ids?: readonly string[]) {
  const original = coldManagedOwners.get(service); if (!original) throw Error('Original context service required'); original.revokeColdTransfers(ids)
}

const artifactSettlement=new WeakMap<ContextOutputService,(scope:SeedDependencyTransferScope)=>Promise<void>>()
export function settleSeedDependencyTransferIO(service:ContextOutputService,scope:SeedDependencyTransferScope){const settle=artifactSettlement.get(service);if(!settle)throw Error('Original artifact service required');return settle(scope)}
type SelectedMetadataOwner=Awaited<ReturnType<typeof createSelectedMetadata>>
type SelectedCleanup={retry():Promise<void>}
type SelectedAcquisitionDebt={failure:unknown;store:ContextStore;settled:boolean;cleanup:SelectedCleanup}
type SelectedMetadataRecord=SelectedMetadataOwner & {cleanupForError(error:unknown):SelectedCleanup|undefined}
const selectedLegacyOwners=new WeakMap<ContextOutputService,ReturnType<typeof createLegacyForkOwner>['selected']>()
export function selectedLegacyTransferFor(service:ContextOutputService){const owner=selectedLegacyOwners.get(service);if(!owner)throw Error('Original context service required');return owner}
const selectedMetadataOwners=new WeakMap<ContextOutputService,{acquire(observation:LegacyReadObservation):Promise<SelectedMetadataOwner>;cleanupForError(error:unknown):SelectedCleanup|undefined}>()
const coldSelectedOwners = new WeakMap<ContextOutputService, (coordinator: SessionCoordinator, cold: ColdSelectedObservation, sourceId: string) => ReturnType<typeof createColdSelectedMetadata>>()
const coldSelectedRevokers = new WeakMap<ContextOutputService, (ids?: readonly string[]) => void>()
export function acquireColdSelectedQualification(service: ContextOutputService, coordinator: SessionCoordinator, cold: ColdSelectedObservation, sourceId: string) {
  const original = coldSelectedOwners.get(service); if (!original) throw Error('Original context service required'); return original(coordinator, cold, sourceId)
}
export function revokeColdSelectedQualifications(service: ContextOutputService, ids?: readonly string[]) {
  const original = coldSelectedRevokers.get(service); if (!original) throw Error('Original context service required'); original(ids)
}
/** Private core-service association; wrappers must forward this original closure. */
export function acquireSelectedMetadata(service:ContextOutputService,observation:LegacyReadObservation) {
  const owner=selectedMetadataOwners.get(service);if(!owner)throw Error('Original context service required');return owner.acquire(observation)
}
export function selectedMetadataCleanupFor(service:ContextOutputService,error:unknown) {return selectedMetadataOwners.get(service)?.cleanupForError(error)}

export function createContextOutputService(inputOptions: ContextOutputOptions): ContextOutputService {
  if (inputOptions.requireObservedLegacyRecipients !== undefined && typeof inputOptions.requireObservedLegacyRecipients !== 'boolean') throw new TypeError('Invalid observed legacy recipient mode')
  const workspaceId = inputOptions.workspaceId, root = inputOptions.root
  identity(workspaceId, 'workspaceId')
  identity(root, 'root')
  const options: ContextOutputOptions = { root: resolve(root), workspaceId, config: inputOptions.config,
    authorize: inputOptions.authorize, authorizeResult: inputOptions.authorizeResult, documentDeletions: inputOptions.documentDeletions,
    requireObservedLegacyRecipients: inputOptions.requireObservedLegacyRecipients === true }
  let config = configureContext({ ...DEFAULT_CONTEXT_OUTPUT_CONFIG }, options.config ?? {})
  const gate = createLegacyUseGate()
  const owner = createWorkspaceMutationOwner(options)
  const artifacts = createArtifactOwnership(options, () => config.maxDiskBytes, owner)
  type RevocationRecord = { original: ContextStore; first?: { managed: Awaited<ReturnType<typeof artifacts.passiveReleaseInventory>>; legacy: Awaited<ReturnType<ContextStore['passiveInventory']>>; targets: readonly string[] }; matched?: { managed: Awaited<ReturnType<typeof artifacts.passiveReleaseInventory>>; legacy: Awaited<ReturnType<ContextStore['passiveInventory']>>; targets: readonly string[] }; coverage?: OriginalRevocationCoverage; frontier?: number; rounds: number; effect?: Awaited<ReturnType<ContextStore['prepareCoveredClear']>>; effectFlight?: Promise<unknown>; io: ReturnType<typeof createArtifactQualificationIO>; workspaces: WorkspaceMutationCleanup[] }
  const revocationPreparations = new Map<OriginalResultRevocationPreparation, RevocationRecord>()
  let unsubscribeDeletions: (() => void) | undefined
  const releaseDocuments = async (documents: readonly string[]) => {
    artifacts.revokeColdTransfers(documents)
    for(const reader of selectedReaders)if(documents.includes(selectedReaderIds.get(reader)!))reader.revoke()
    for (const id of documents) legacy.retire(id)
    const managed = artifacts.releaseDocuments(documents)
    const cleanup = cleanupTransition(documents, async settled => {
      if (!store && !candidate) {
        const inventory = new ContextStore(options.root, workspaceId)
        let present = false
        for (const kind of ['artifacts', 'legacy-fork-v1']) {
          try { await fileAccess(resolve(inventory.directory, kind)); present = true }
          catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
        }
        if (!present) return
      }
      await withLegacyWrite(undefined, (current, lease) => owner.mutate(async turn => {
        for (const id of documents) { await current.clear(turn, lease, config.maxDiskBytes, id); settled(id) }
      }), 'cleanup')
    })
    const outcomes = await Promise.allSettled([managed, cleanup.promise])
    const failures = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length && cleanupRequest === cleanup.request) cleanupIndexUnavailable = false
    failuresTogether(failures, 'Original document cleanup failed')
  }
  let protectedResults = 0
  let state: ContextOutputStatus['state'] = config.enabled ? 'ready' : 'disabled'
  let closed = false
  let closing = false
  let closeFlight: Promise<void> | undefined
  let deletionsUnsubscribed = false
  let artifactsClosed = false
  let controls = 0
  let error: string|undefined
  let cleanupIndexUnavailable = false
  let cleanupRequest: symbol | undefined
  const cleanupFailures = new Map<string | undefined, string>()
  let store: ContextStore|undefined
  let candidate: ContextStore|undefined
  let failedOpeningCleanup: unknown
  let opening: Promise<ContextStore>|undefined
  let mutations: Promise<unknown> = Promise.resolve()
  let quiescence: Promise<void> | undefined
  let transitions: Promise<unknown> = Promise.resolve()
  type FiniteClear = { domain: ReturnType<typeof captureOriginalRevocationDomain>; origin: OriginalOrderingOrigin; sessionId: string | undefined; promise: Promise<ContextOutputStatus>; initialTickets: { port: ResultRevocationAdmission; ticket: OriginalResultRevocationTicket }[]; preparation?: OriginalResultRevocationPreparation; debt?: { cause: unknown }; released: boolean }
  let finiteClear: FiniteClear | undefined
  const clearContext = new AsyncLocalStorage<FiniteClear>()
  const jobs = new Map<AbortController, Promise<unknown>>()
  const orderingReservations = new Set<OriginalOrderingReservation>()
  const originalJobContext = new AsyncLocalStorage<{ active: boolean }>()
  const assertOrderingOutside = () => { if (originalJobContext.getStore()?.active) throw Error('Original legacy service job reentry'); gate.assertOutside(); owner.assertOutside() }
  const selectedReaders=new Set<Pick<SelectedMetadataRecord, 'revoke' | 'close' | 'cleanupForError'>>()
  const selectedReaderIds=new WeakMap<object,string>()
  const historicalSelectedReaders = new WeakSet<object>()
  const revokeSelectedAuthorities=(sessions?:readonly string[])=>{for(const reader of selectedReaders)if(!sessions||sessions.includes(selectedReaderIds.get(reader)!))reader.revoke();if(!sessions)legacy.selected.retire();else for(const session of sessions)legacy.selected.retire(session)}
  const revokeResumedAuthorities = () => { for (const reader of selectedReaders) if (historicalSelectedReaders.has(reader)) reader.revoke(); legacy.selected.retireHistorical() }
  const selectedAcquisitionDebts=new Set<SelectedAcquisitionDebt>()
  let closedSelectedStore:ContextStore|undefined
  const acknowledgeSelectedAcquisitions=(original:ContextStore)=>{for(const debt of selectedAcquisitionDebts)if(debt.store===original){debt.settled=true;selectedAcquisitionDebts.delete(debt)}}
  const legacy = createLegacyForkOwner({ strict: options.requireObservedLegacyRecipients === true, workspaceId,
    quota: () => config.maxDiskBytes, run: (signal, work) => run(signal, owned => withLegacyIndexWrite(owned, context => work(owned, context)), false, true),
    mutate: mutateIndex, runPassive: (original, work) => run(undefined, owned => gate.exclusive(owned, async lease => {
      gate.assertLease(lease); if (!store || store !== original) throw Error('Original legacy store unavailable')
      await original.resume(lease, config.maxDiskBytes, owned)
      return serial(() => owner.mutate(async turn => { turn.assertCurrent(); return work(owned, original) }))
    }), false, true) })
  unsubscribeDeletions = options.documentDeletions?.(releaseDocuments)

  function assertOpen(): void { if (closed || closing) throw new Error('Context output is closed') }

  function status(): ContextOutputStatus {
    const issue = store?.indexIssue() && `${cleanupIndexUnavailable && cleanupFailures.size === 0 ? 'Requested cleanup completed; ' : ''}${store.indexIssue()!.message}`
    const message = [error, ...cleanupFailures.values(), issue].filter(Boolean).join('; ')
    return { enabled: config.enabled && !closing && !closed, state: message && state !== 'stopping' && state !== 'disabled' ? 'error' : state, config: { ...config },
      ...(store?.counters() ?? { retainedBytes: 0, results: 0 }), activeJobs: jobs.size,
      ...(message ? { error: message } : {}), ...(protectedResults ? { protectedResults, clearDisposition: 'protected' as const } : {}) }
  }
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutations.then(operation)
    mutations = result.catch(() => {})
    return result
  }
  function quiesceLegacy(): Promise<void> {
    if (quiescence) return quiescence
    const original = store ?? candidate
    if (!original || original.lifetimeSettled()) return Promise.resolve()
    const flight = gate.exclusive(undefined, lease => original.quiesce(lease))
    quiescence = flight
    void flight.finally(() => { if (quiescence === flight) quiescence = undefined }).catch(() => {})
    return flight
  }
  async function getStore(lease: LegacyUseLease, mode: 'query'|'cleanup' = 'query', signal?: AbortSignal): Promise<ContextStore> {
    gate.assertLease(lease, 'exclusive')
    checkAbort(signal)
    if (store) { await store.resume(lease, config.maxDiskBytes, signal); return store }
    if (failedOpeningCleanup) throw failedOpeningCleanup
    if (!opening) {
      // Reject impossible startup budgets without creating even a lock path.
      if (mode === 'query' && config.maxDiskBytes < 65536) throw new Error('Context disk quota cannot fit an index')
      const next = candidate ?? (candidate = new ContextStore(options.root, workspaceId, owner, gate.assertLease, revokeSelectedAuthorities, revokeResumedAuthorities))
      opening = (async () => {
        try {
          await next.acquireLifetime(signal)
          checkAbort(signal)
          await serial(() => owner.mutate(turn => next.open(turn, lease, config.maxDiskBytes, mode, signal)))
          checkAbort(signal)
          if (closing || closed) throw new Error('Context output is closed')
          store = next
          return next
        } catch (failure) {
          try { await next.close(lease);closedSelectedStore=next;acknowledgeSelectedAcquisitions(next);candidate = undefined }
          catch (cleanup) { failedOpeningCleanup = new AggregateError([failure, cleanup], 'Legacy store opening and original cleanup failed') }
          if (!(failure instanceof Error && failure.name === 'AbortError')) {
            error = failure instanceof Error ? failure.message : String(failure)
            state = 'error'
          }
          throw failedOpeningCleanup ?? failure
        }
      })().finally(() => { opening = undefined })
    }
    const current = await opening
    checkAbort(signal)
    return current
  }
  async function initialize(signal?: AbortSignal): Promise<void> {
    await gate.exclusive(signal, lease => getStore(lease, 'query', signal).then(() => {}))
  }
  async function withLegacyOriginals<T>(signal: AbortSignal, work: (current: ContextStore) => Promise<T>): Promise<T> {
    await initialize(signal)
    return gate.shared(signal, async lease => { gate.assertLease(lease); return work(store!) })
  }
  async function withLegacyWrite<T>(signal: AbortSignal | undefined, work: (current: ContextStore, lease: LegacyUseLease) => Promise<T>, mode: 'query'|'cleanup' = 'query'): Promise<T> {
    return gate.exclusive(signal, async lease => work(await getStore(lease, mode, signal), lease))
  }
  function mutateIndex<T>(context: IndexedLegacyContext, work: (turn: WorkspaceMutationTurn) => Promise<T>): Promise<T> {
    gate.assertLease(context.lease, 'exclusive'); context.index.assertCurrent()
    return serial(() => owner.mutate(async turn => {
      gate.assertLease(context.lease, 'exclusive'); context.index.assertCurrent()
      if (context.store !== store) throw Error('Legacy store identity changed')
      const value = await work(turn); context.index.assertCurrent(); return value
    }))
  }
  function cleanupTransition(scopes: readonly (string | undefined)[], work: (settled: (scope: string | undefined) => void) => Promise<void>) {
    const request = Symbol('cleanup request')
    const promise = transition(async () => {
      // Admission and failure handling enclose inventory/open as well as Store
      // effects. A queued predecessor cannot supply this request's disposition.
      cleanupRequest = request; cleanupIndexUnavailable = false
      const pending = new Set(scopes)
      const settled = (scope: string | undefined) => {
        pending.delete(scope)
        if (scope === undefined) cleanupFailures.clear()
        else cleanupFailures.delete(scope)
      }
      try {
        await work(settled)
        for (const scope of pending) settled(scope)
        cleanupIndexUnavailable = !!store?.indexIssue()
      } catch (failure) {
        cleanupIndexUnavailable = false
        // If all canonical scopes settled but the surrounding owner turn failed,
        // the request still owes original resource cleanup for those scopes.
        for (const scope of pending.size ? pending : scopes) cleanupFailures.set(scope, `Requested original cleanup remains incomplete: ${failure instanceof Error ? failure.message : String(failure)}`)
        throw failure
      }
    })
    return { request, promise }
  }
  async function withLegacyIndex<T>(signal: AbortSignal, work: (context: IndexedLegacyContext) => Promise<T>): Promise<T> {
    await initialize(signal)
    const attempt = await indexReadScope(signal, async lease => {
      if (!store!.indexReady()) return { ready: false as const }
      return { ready: true as const, value: await work({ store: store!, lease, index: store!.indexUse(lease) }) }
    })
    if (attempt.ready) return attempt.value
    await gate.exclusive(signal, async lease => {
      if (await serial(() => owner.mutate(turn => store!.ensureIndex(turn, lease, config.maxDiskBytes))) !== 'ready') throw Object.assign(Error(store!.indexIssue()?.message ?? 'Derived context index unavailable'), { code: 'CONTEXT_INDEX_UNAVAILABLE' })
    })
    return indexReadScope(signal, lease => work({ store: store!, lease, index: store!.indexUse(lease) }))
  }
  async function indexReadScope<T>(signal: AbortSignal, work: (lease: LegacyUseLease) => Promise<T>): Promise<T> {
    let failedGeneration = false
    try {
      return await gate.shared(signal, async lease => {
        try { return await work(lease) }
        catch (failure) { failedGeneration = store!.indexRetirementPending(); throw failure }
      })
    } catch (failure) {
      const failures = [failure]
      // The failed reader's shared scope has settled. Disposal queues behind
      // the remaining consumers and never upgrades the reader's own lease.
      if (failedGeneration) try { await gate.exclusive(undefined, lease => serial(() => owner.mutate(turn => store!.retireInvalidIndex(turn, lease)))) } catch (cleanup) { failures.push(cleanup) }
      failuresTogether(failures, 'Derived query and original disposal failed'); throw failure
    }
  }
  async function withLegacyIndexWrite<T>(signal: AbortSignal, work: (context: IndexedLegacyContext) => Promise<T>): Promise<T> {
    return withLegacyWrite(signal, async (current, lease) => {
      if (await serial(() => owner.mutate(turn => current.ensureIndex(turn, lease, config.maxDiskBytes))) !== 'ready') throw Object.assign(Error(current.indexIssue()?.message ?? 'Derived context index unavailable'), { code: 'CONTEXT_INDEX_UNAVAILABLE' })
      const failures: unknown[] = []
      let value!: T
      try { value = await work({ store: current, lease, index: current.indexUse(lease) }) } catch (failure) { failures.push(failure) }
      if (!current.indexReady()) try { await serial(() => owner.mutate(turn => current.retireInvalidIndex(turn, lease))) } catch (failure) { failures.push(failure) }
      failuresTogether(failures, 'Legacy operation and derived cleanup failed')
      return value
    })
  }
  function run<T>(signal: AbortSignal|undefined, operation: (signal: AbortSignal) => Promise<T>, mutation = false, hostMetadata = false): Promise<T> {
    if (orderingRequired.has(service) && !orderingConfigured.has(service)) return Promise.reject(Error('Original result ordering registration required'))
    if (orderingReservations.size) return Promise.reject(Error('Original fresh ownership ordering in progress'))
    if (closed || closing) return Promise.reject(new Error('Context output is closed'))
    if ((!config.enabled && !hostMetadata) || controls > 0) return Promise.reject(new Error('Context output is disabled or stopping'))
    const controller = new AbortController()
    const owned = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const start = async () => {
      checkAbort(owned); const scope = { active: true }
      try { return await originalJobContext.run(scope, () => operation(owned)) } finally { scope.active = false }
    }
    const task = (mutation ? serial(start) : Promise.resolve().then(start))
    const result = (async () => {
      const failures: unknown[] = []; let value!: T
      try { value = await task } catch (failure) { failures.push(failure) }
      jobs.delete(controller)
      if (!failures.length && !jobs.size && !closing && !closed) try { await quiesceLegacy() } catch (failure) { failures.push(failure) }
      failuresTogether(failures, 'Legacy use and original idle cleanup failed'); return value
    })()
    jobs.set(controller, result)
    return result
  }
  function transition<T>(operation: () => Promise<T>, permanent = false): Promise<T> {
    if (orderingReservations.size && !permanent) return Promise.reject(Error('Original fresh ownership ordering in progress'))
    controls++
    if (permanent) closing = true
    state = 'stopping'
    for (const controller of jobs.keys()) controller.abort()
    const result = transitions.then(async () => {
      await Promise.allSettled([...jobs.values()])
      await mutations
      const failures: unknown[] = []; let value!: T
      const scope = { active: true }
      try { value = await originalJobContext.run(scope, operation) } catch (failure) { failures.push(failure) } finally { scope.active = false }
      if (!failures.length && !permanent) try { await quiesceLegacy() } catch (failure) { failures.push(failure) }
      failuresTogether(failures, 'Legacy transition and original idle cleanup failed'); return value
    }).finally(() => {
      controls--
      if (controls === 0) state = error ? 'error' : config.enabled && !closed && !closing ? 'ready' : 'disabled'
    })
    transitions = result.catch(() => {})
    return result
  }
  async function allowed(access: ContextAccess, ref: ContextResultRef, signal: AbortSignal): Promise<boolean> {
    checkAbort(signal)
    if (options.requireObservedLegacyRecipients && access.sessionId !== ref.sessionId) return false
    // A source-bearing artifact must recheck live host source visibility even
    // for its durable owner. Source-less refs retain owner/lineage augmentation.
    if (store!.owns(ref.id, access.sessionId) && !(ref.source && options.authorize)) return true
    const granted = options.authorize ? await options.authorize({ sessionId: access.sessionId, signal }, structuredClone(ref)) : false
    checkAbort(signal)
    return granted === true
  }
  async function readable(current: ContextStore, access: ContextAccess, id: string, signal: AbortSignal): Promise<ContextResultRef> {
    const ref = current.get(id)
    if (!ref || !await allowed(access, ref, signal)) throw new Error('Context reference unavailable or unauthorized')
    await current.canonicalRef(commitment(ref)); checkAbort(signal)
    // An asynchronous host policy may outlive retention.
    if (!current.get(id)) throw new Error('Context reference expired')
    return ref
  }
  function observed(context: IndexedLegacyContext, access: ContextAccess, input: LegacyReadObservation, signal: AbortSignal) {
    const observation = captureObservation(input)
    if (observation.sessionId !== access.sessionId) throw Error('Legacy observation session mismatch')
    const guard = () => { context.index.assertCurrent(); checkAbort(signal); assertOpen(); observation.assertCurrent() }
    async function allowedObserved(ref: ContextResultRef): Promise<boolean> {
      guard(); context.index.assertCurrent(); const current = context.store; guard()
      if (!current.get(ref.id)) return false
      if (!await observedAllowed(context, ref, observation, guard)) return false
      guard()
      if (ref.source && options.authorize && !await options.authorize({ sessionId: access.sessionId, signal }, structuredClone(ref))) return false
      guard(); return !!current.get(ref.id)
    }
    return { guard, allowed: allowedObserved }
  }
  async function readObserved(access: ContextAccess, query: LegacyReadQuery, input: LegacyReadObservation) {
    identity(access.sessionId, 'sessionId')
    const snapshot = captureObservation(input), caller = { sessionId: access.sessionId }
    const id = query.refId, offset = integer(query.offset ?? 0, 'offset'), budget = Math.min(config.maxReadBytes, integer(query.maxBytes ?? config.maxReadBytes, 'read budget', 1))
    return run(access.signal, signal => withLegacyIndexWrite(signal, async context => {
      const scope = observed(context, caller, snapshot, signal)
      const current = context.store; scope.guard()
      await prepareObservedIndex(context, snapshot, scope.guard, mutateIndex, config.maxDiskBytes); scope.guard()
      const result = await readLegacy(id, offset, budget, signal, async () => {
        scope.guard(); context.index.assertCurrent(); const ref = current.get(id)
        if (!ref || !await scope.allowed(ref)) throw Error('Context reference unavailable or unauthorized')
        scope.guard(); return ref
      }, (id, signal) => store!.bytes(id, signal))
      scope.guard()
      if (!await scope.allowed(result.ref) || result.ref.expiresAt <= Date.now()) throw Error('Context reference expired or unauthorized during read')
      scope.guard(); return result
    }))
  }
  async function searchObserved(access: ContextAccess, query: LegacySearchQuery, input: LegacyReadObservation) {
    identity(access.sessionId, 'sessionId')
    const snapshot = captureObservation(input), caller = { sessionId: access.sessionId }
    if (typeof query.query !== 'string' || !query.query.trim() || Buffer.byteLength(query.query) > 1024) throw Error('query must contain 1..1024 UTF-8 bytes')
    const terms = [...new Set(query.query.trim().split(/\s+/u))], limit = Math.min(100, integer(query.limit ?? 10, 'limit', 1)), maxBytes = Math.min(config.maxSearchBytes, integer(query.maxBytes ?? config.maxSearchBytes, 'search budget', 1))
    const filter = query.refIds === undefined ? undefined : new Set(query.refIds)
    if (filter && (filter.size > 100 || [...filter].some(id => typeof id !== 'string'))) throw Error('refIds must contain at most 100 references')
    if (maxBytes < serializedBytes({ hits: [], partial: true, reasons: ['byte-budget'] })) throw Error('search budget cannot fit result metadata')
    return run(access.signal, signal => withLegacyIndexWrite(signal, async context => {
      const scope = observed(context, caller, snapshot, signal)
      scope.guard()
      await prepareObservedIndex(context, snapshot, scope.guard, mutateIndex, config.maxDiskBytes); scope.guard()
      scope.guard(); const result = await searchLegacy({ terms, limit, maxBytes, filter }, context, ref => scope.allowed(ref), signal); scope.guard()
      const confirmed = [] as typeof result.hits
      for (const hit of result.hits) { if (await scope.allowed(hit.ref)) confirmed.push(hit); scope.guard() }
      result.hits = confirmed.filter(hit => hit.ref.expiresAt > Date.now())
      scope.guard(); return result
    }))
  }

  const service:ContextOutputService = {
    registerLegacyForkTransfer(capture) { assertOpen(); return legacy.register(capture) },
    confirmLegacyForkTransfer: legacy.confirm, reconcileLegacyForkTransfer: legacy.reconcile, closeLegacyForkTransfer: legacy.closeScope,
    readLegacyObserved: readObserved, searchLegacyObserved: searchObserved,
    registerSeedDependencyTransfer(access, originalPublication) { assertOpen(); return artifacts.registerSeedDependencyTransfer(access, originalPublication) },
    async confirmSeedDependencies(scope, request, current) {
      if (closed || closing) return { kind: 'blocked', reason: 'unavailable' }
      return artifacts.confirmSeedDependencies(scope, request, current)
    },
    reconcileSeedDependencies: artifacts.reconcileSeedDependencies,
    registerResultScope(owner, current) { assertOpen(); return artifacts.registerResultScope(owner, current) },
    registerResultDependencyScope(owner, current, entries) { assertOpen(); return artifacts.registerResultDependencyScope(owner, current, entries) },
    settleResultDependencyMembership: artifacts.settleResultDependencyMembership,
    async beginResult(scope, codec) { assertOpen(); return artifacts.beginResult(scope, codec) },
    confirmResultOwner: artifacts.confirmResultOwner,
    async readResult(access, query) { assertOpen(); return artifacts.readResult(access, query) },
    async readCodeOutputResult(access,query) {assertOpen();return artifacts.readCodeOutputResult(access,query)},
    async readExecResult(access, query) { assertOpen(); return artifacts.readExecResult(access, query) },
    reconcileResult: artifacts.reconcileResult,
    status,
    async configure(patch) {
      while (pendingDeletionTopologies().length) await joinDeletionUse()
      while (finiteClear) await joinFiniteClear()
      if (closed || closing) throw new Error('Context output is closed')
      configureContext(config, patch)
      await transition(async () => {
        const next = configureContext(config, patch)
        if (store && next.maxDiskBytes !== config.maxDiskBytes) await gate.exclusive(undefined, async lease => { await store!.resume(lease, config.maxDiskBytes); await owner.mutate(turn => store!.configureDiskBudget(turn, lease, next.maxDiskBytes)) })
        config = next
      })
      return status()
    },
    async capture(input, signal, producer) {
      identity(input.sessionId, 'sessionId')
      identity(input.callId, 'callId')
      if (typeof input.label !== 'string' || Buffer.byteLength(input.label) > 1024) throw new Error('label exceeds 1024 UTF-8 bytes')
      if (typeof input.text !== 'string' || typeof input.complete !== 'boolean') throw new Error('Invalid context capture')
      if (!config.enabled && !closed && !closing && controls === 0) return undefined
      // Snapshot caller objects before admitting asynchronous work.
      const captured = structuredClone(input)
      return run(signal, owned => captureLegacy(workspaceId, captured, producer, () => config,
        work => withLegacyWrite(owned, (current, lease) => serial(() => owner.mutate(turn => {
          if (current !== store) throw new Error('Legacy store identity changed')
          return work(current, turn, lease)
        }))), owned))
    },
    async read(access, query) {
      identity(access.sessionId, 'sessionId')
      const caller = { sessionId: access.sessionId }
      const id = query.refId
      const offset = integer(query.offset ?? 0, 'offset')
      const budget = Math.min(config.maxReadBytes, integer(query.maxBytes ?? config.maxReadBytes, 'read budget', 1))
      return run(access.signal, owned => withLegacyOriginals(owned, current => readLegacy(id, offset, budget, owned, () => readable(current, caller, id, owned), (id, signal) => current.bytes(id, signal))))
    },
    async search(access, query) {
      identity(access.sessionId, 'sessionId')
      const caller = { sessionId: access.sessionId }
      if (typeof query.query !== 'string' || !query.query.trim() || Buffer.byteLength(query.query) > 1024) throw new Error('query must contain 1..1024 UTF-8 bytes')
      const terms = [...new Set(query.query.trim().split(/\s+/u))]
      const limit = Math.min(100, integer(query.limit ?? 10, 'limit', 1))
      const maxBytes = Math.min(config.maxSearchBytes, integer(query.maxBytes ?? config.maxSearchBytes, 'search budget', 1))
      if (maxBytes < serializedBytes({ hits: [], partial: true, reasons: ['byte-budget'] })) throw new Error('search budget cannot fit result metadata')
      const filter = query.refIds === undefined ? undefined : new Set(query.refIds)
      if (filter && (filter.size > 100 || [...filter].some((id) => typeof id !== 'string'))) throw new Error('refIds must contain at most 100 references')
      return run(access.signal, owned => withLegacyIndex(owned, context => searchLegacy({ terms, limit, maxBytes, filter }, context, (ref, signal) => allowed(caller, ref, signal), owned)))
    },
    async grant(access, refIds, targetSessionId) {
      assertOpen()
      identity(access.sessionId, 'sessionId')
      identity(targetSessionId, 'targetSessionId')
      const ids = [...new Set(refIds)]
      const caller = { sessionId: access.sessionId }
      if (ids.length > 100) throw new Error('grant supports at most 100 references')
      const managedIds = ids.filter(id => /^ctxv1_[a-f0-9]{64}$/.test(id))
      if (managedIds.length) await artifacts.grantResults(access, managedIds, targetSessionId)
      const legacyIds = ids.filter(id => !managedIds.includes(id))
      if (!legacyIds.length) return
      return run(access.signal, owned => withLegacyWrite(owned, async (current, lease) => {
        const prepared: ContextResultRef[] = []
        for (const id of legacyIds) prepared.push(await readable(current, caller, id, owned))
        await serial(() => owner.mutate(async turn => {
          checkAbort(owned)
          if (current !== store || prepared.some(ref => JSON.stringify(current.get(ref.id)) !== JSON.stringify(ref))) throw new Error('Context reference expired or changed')
          await current.addOwners(turn, lease, legacyIds, targetSessionId, config.maxDiskBytes, owned)
        }))
      }, 'cleanup'), false, true)
    },
    async clear(sessionId) {
      while (finiteClear) await joinFiniteClear()
      if (closed || closing) throw new Error('Context output is closed')
      if (sessionId !== undefined) identity(sessionId, 'sessionId')
      const topology = legacyOrderingOwners.get(service)!
      if (topology.coordinators.size || orderingRequired.has(service)) {
        assertOrderingOutside(); captureOriginalRevocationDomain([...topology.coordinators.values()])
        return coveredPublicClear(sessionId, topology)
      }
      artifacts.revokeColdTransfers(sessionId === undefined ? undefined : [sessionId])
      for(const reader of selectedReaders)if(sessionId===undefined||selectedReaderIds.get(reader)===sessionId)reader.revoke()
      legacy.retire(sessionId)
      await cleanupTransition([sessionId], async () => {
        protectedResults = await artifacts.protectedCount()
        if (!store) {
          const inventory = new ContextStore(options.root, workspaceId)
          try { await fileAccess(inventory.directory) } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return; throw failure }
        }
        await withLegacyWrite(undefined, (current, lease) => owner.mutate(turn => current.clear(turn, lease, config.maxDiskBytes, sessionId)), 'cleanup')
      }).promise
      return status()
    },
    async close() {
      while (pendingDeletionTopologies().length) await joinDeletionUse()
      if (finiteClear) {
        if (clearContext.getStore() === finiteClear) throw Error('Original clear operation reentry')
        if (finiteClear.debt) {
          const original = finiteClear
          await original.preparation?.close(); for (const { ticket } of original.initialTickets) await ticket.close(); releaseClearFence(original)
        } else { while (finiteClear) await joinFiniteClear() }
      }
      if (closed) return
      artifacts.closeTransferAdmission()
      for(const reader of selectedReaders)reader.revoke()
      // The transition tail swallows failures to preserve queue ordering. Close
      // callers must join the original outcome instead, retaining the permanent
      // admission fence while a later explicit call retries unfinished cleanup.
      if (!closeFlight) closeFlight = transition(async () => {
        const failures: unknown[] = []
        for (const preparation of [...revocationPreparations.keys()]) try { await preparation.close() } catch (failure) { failures.push(failure) }
        if (failures.length) failuresTogether(failures, 'Original revocation cleanup unresolved')
        for(const reader of [...selectedReaders])try{await reader.close()}catch(failure){failures.push(failure)}
        try { await legacy.close() } catch (failure) { failures.push(failure) }
        if (!deletionsUnsubscribed) {
          try { unsubscribeDeletions?.(); deletionsUnsubscribed = true } catch (failure) { failures.push(failure) }
        }
        if (!artifactsClosed) {
          try { await artifacts.close(); artifactsClosed = true } catch (failure) { failures.push(failure) }
        }
        if (candidate && !selectedReaders.size) {
          try { const original=candidate;await gate.exclusive(undefined, async lease => {await original.close(lease);closedSelectedStore=original;acknowledgeSelectedAcquisitions(original)}); candidate = undefined; store = undefined } catch (failure) { failures.push(failure) }
        }
        if (artifactsClosed && !candidate && !selectedReaders.size) {
          try { await owner.close() } catch (failure) { failures.push(failure) }
        }
        failuresTogether(failures, 'Original context output resources failed to close')
        closed = true
        for (const coordinator of legacyOrderingOwners.get(service)!.coordinators.keys()) deletionMembers.get(coordinator)?.services.delete(service)
      }, true).catch(cause => { closeFlight = undefined; throw cause })
      await closeFlight
    },
  }
  const participant: OriginalLegacyOrderingParticipant = Object.freeze({ assertOutside: assertOrderingOutside, reserve(retain: (cleanup: OriginalOrderingReservation) => void) {
    assertOrderingOutside(); if (closing && !closed) throw Error('Original result service cleanup unresolved')
    const admittedTransitions = transitions
    let settled = false, closedReservation = false, flight: Promise<void> | undefined
    const reservation: OriginalOrderingReservation = Object.freeze({
      join() {
        if (this !== reservation) throw TypeError('Original ordering reservation receiver required')
        if (closedReservation) return Promise.reject(Error('Original ordering reservation closed'))
        if (settled) return Promise.resolve()
        if (!flight) { flight = (async () => {
          await Promise.allSettled([...jobs.values()]); await admittedTransitions
          // The queue tail preserves each caller's original outcome. Only the
          // actual retained cleanup below can acknowledge native settlement.
          await quiesceLegacy(); settled = true
        })().finally(() => { flight = undefined }) }
        return flight
      },
      assertSettled() { if (this !== reservation) throw TypeError('Original ordering reservation receiver required'); if (!settled) throw Error('Original ordering cleanup unresolved') },
      async close() { if (this !== reservation) throw TypeError('Original ordering reservation receiver required'); if (closedReservation) return; await reservation.join(); reservation.assertSettled(); closedReservation = true; orderingReservations.delete(reservation) },
    })
    orderingReservations.add(reservation); retain(reservation); return reservation
  } })
  legacyOrderingOwners.set(service, { participant, coordinators: new Map(), operations: new Set() })
  function pendingDeletionTopologies(): DeletionTopology[] {
    return [...legacyOrderingOwners.get(service)!.operations].map(operation => deletionTopologies.get(operation as OriginalDeletionReservation)).filter((record): record is DeletionTopology => !!record && !record.closed)
  }
  async function joinDeletionUse(): Promise<void> {
    const records = pendingDeletionTopologies()
    for (const original of records) { if (original.domain) assertOutsideOriginalRevocationOrdering(original.domain); if (original.failure) throw original.failure.cause }
    await Promise.all(records.map(original => original.done.promise))
  }
  deletionOwners.set(service, (coordinator, scope, selection, reservation) => {
    captureOriginalDeletionScope(coordinator, scope); assertOpen(); assertOrderingOutside()
    const topology = legacyOrderingOwners.get(service)!, members = [...topology.coordinators]
    const token = deletionTopologies.get(reservation), marker = {}
    if (!token || !token.begun || token.closed || !topology.operations.has(reservation)) throw TypeError('Original service deletion reservation required')
    // Other constructor-issued topology fences are still pre-issue metadata.
    // All real ordering debt and native resource predicates remain mandatory.
    if ([...topology.operations].some(operation => operation !== reservation && !deletionTopologies.has(operation as OriginalDeletionReservation) && operation !== finiteClear)) throw Error('Original deletion service busy')
    topology.operations.add(marker); controls++; state = 'stopping'
    const predecessors = { jobs: [...jobs.values()], transitions, mutations }, documents = originalDeletionSelectionIds(selection)
    for (const controller of jobs.keys()) controller.abort()
    artifacts.revokeColdTransfers(documents); for (const reader of selectedReaders) if (documents.includes(selectedReaderIds.get(reader)!)) reader.revoke(); for (const id of documents) legacy.retire(id)
    const original = candidate ?? store ?? new ContextStore(options.root, workspaceId, owner, gate.assertLease, revokeSelectedAuthorities, revokeResumedAuthorities)
    const io = createArtifactQualificationIO(), workspaces: WorkspaceMutationCleanup[] = []
    type Inventory = { managed: Awaited<ReturnType<typeof artifacts.passiveReleaseInventory>>; legacy: Awaited<ReturnType<ContextStore['passiveInventory']>>; targets: readonly string[] }
    let first: Inventory | undefined, matched: Inventory | undefined, coverage: OriginalRevocationCoverage | undefined
    let managedEffect: ReturnType<typeof artifacts.prepareCoveredRelease> | undefined, legacyEffect: Awaited<ReturnType<ContextStore['prepareCoveredClear']>> | undefined, active: Promise<unknown> | undefined, closedWork = false, settled = false
    const check = () => { assertOpen(); scope.assertCurrent(); if (topology.coordinators.size !== members.length || members.some(([co, port]) => topology.coordinators.get(co) !== port || originalResultRevocationFor(co) !== port)) throw Error('Original deletion service topology changed') }
    const work: DeletionWork = Object.freeze({
      async snapshot(cutoff: number) {
        check(); await Promise.allSettled(predecessors.jobs); await predecessors.transitions; await predecessors.mutations; check()
        const flight = gate.exclusive(undefined, async lease => {
          await original.acquireLifetime(); check()
          const inventory = await owner.mutate(async turn => {
            const managed = await artifacts.passiveReleaseInventory(turn, documents, io), legacy = await original.passiveDeletionInventory(turn, selection, cutoff)
            check(); if (managed.recoveryRequired || legacy.recoveryRequired) throw Error('Original deletion recovery required')
            return { managed, legacy, targets: Object.freeze([...new Set([...managed.targets, ...legacy.targets])].sort()) }
          }, cleanup => { workspaces.push(cleanup) })
          await original.quiesce(lease); check(); return inventory
        })
        active = flight; const value = await flight
        if (!first) first = value; else matched = value
        return { identity: canonicalJsonData({ managed: value.managed, legacy: value.legacy }), targets: value.targets }
      },
      bind(originalCoverage: OriginalRevocationCoverage) { if (!first || coverage) throw Error('Original deletion inventory required'); assertOriginalRevocationCoverage(originalCoverage, first.targets); coverage = originalCoverage },
      async effect() {
        check(); scope.assertDocumentsCovered(scope.manifest.documents)
        if (!matched || !coverage) throw Error('Original matched deletion inventory required')
        const flight = gate.exclusive(undefined, async lease => {
          await original.acquireLifetime(); check(); assertOriginalRevocationCoverage(coverage!, matched!.targets)
          return owner.mutate(async turn => {
            check(); scope.assertDocumentsCovered(scope.manifest.documents)
            managedEffect = artifacts.prepareCoveredRelease(turn, matched!.managed, coverage!)
            legacyEffect = await original.prepareCoveredClear(turn, lease, matched!.legacy, coverage!)
            await artifacts.applyCoveredRelease(turn, managedEffect)
            let present = true
            try { await fileAccess(original.directory) } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') present = false; else throw failure }
            if (candidate && candidate !== original || store && store !== original) throw Error('Original deletion store changed')
            if (candidate || store || present) candidate = store = original
            await original.applyCoveredClear(turn, lease, config.maxDiskBytes, legacyEffect)
          }, cleanup => { workspaces.push(cleanup) })
        })
        active = flight; await flight
      },
      async close() {
        if (closedWork) return
        await active?.catch(() => {})
        await io.settle(); io.assertSettled(); await original.joinLegacyFiles(); original.assertLegacyFilesSettled()
        for (const cleanup of workspaces) { await cleanup.close(); cleanup.assertSettled() }
        await gate.exclusive(undefined, lease => original.quiesce(lease))
        if (managedEffect) artifacts.assertCoveredReleaseSettled(managedEffect)
        if (legacyEffect) original.assertCoveredClearSettled(legacyEffect)
        if (!original.lifetimeSettled()) throw Error('Original deletion lifetime remains unresolved')
        closedWork = true
      },
      assertSettled() { if (!closedWork) throw Error('Original deletion service cleanup unresolved') },
      settle() { if (!closedWork) throw Error('Original deletion service cleanup unresolved'); if (settled) return; settled = true; topology.operations.delete(marker); controls--; state = controls ? 'stopping' : config.enabled ? 'ready' : 'disabled' },
      fail(cause: unknown) { token.failure = { cause }; token.done.reject(cause) },
    })
    return work
  })
  async function joinFiniteClear(): Promise<void> {
    const original = finiteClear
    if (!original) return
    if (clearContext.getStore() === original) throw Error('Original clear operation reentry')
    if (original.debt) throw original.debt.cause
    try { await original.promise } catch { const debt = readClearDebt(original); if (finiteClear === original && debt) throw debt.cause }
  }
  function readClearDebt(original: FiniteClear) { return original.debt }
  function releaseClearFence(original: FiniteClear): void {
    if (original.released) return
    completeOriginalRevocationOrdering(original.domain, original.origin)
    original.released = true; legacyOrderingOwners.get(service)!.operations.delete(original)
    if (finiteClear === original) finiteClear = undefined
    controls--; state = config.enabled ? 'ready' : 'disabled'
  }
  function coveredPublicClear(sessionId: string | undefined, topology: LegacyOrderingOwner): Promise<ContextOutputStatus> {
    const domain = captureOriginalRevocationDomain([...topology.coordinators.values()]), origin = beginOriginalRevocationOrdering(domain)
    const completion = Promise.withResolvers<ContextOutputStatus>(), original: FiniteClear = { domain, origin, sessionId, promise: completion.promise, initialTickets: [], released: false }
    const predecessors = { transitions, jobs: [...jobs.values()] }
    finiteClear = original; topology.operations.add(original); controls++; state = 'stopping'
    for (const controller of jobs.keys()) controller.abort()
    const running = runOriginalRevocationOrdering(domain, origin, () => clearContext.run(original, async () => {
      const request = { kind: sessionId === undefined ? 'workspace' as const : 'session' as const, sessionIds: sessionId === undefined ? [] : [sessionId] }
      for (const [coordinator, port] of topology.coordinators) {
        if (originalResultRevocationFor(coordinator) !== port) throw Error('Changed original clear coordinator')
        if (original.initialTickets.some(entry => entry.port === port)) continue
        const ticket = port.begin(issueOriginalResultRevocationScope(port, request, topology.participant)); original.initialTickets.push({ port, ticket })
      }
      artifacts.revokeColdTransfers(sessionId === undefined ? undefined : [sessionId])
      for (const reader of selectedReaders) if (sessionId === undefined || selectedReaderIds.get(reader) === sessionId) reader.revoke()
      legacy.retire(sessionId)
      const earlier = joinOriginalRevocationPredecessors(domain, origin); if (earlier) await earlier
      await Promise.allSettled(predecessors.jobs); await predecessors.transitions; await mutations
      let rounds = 0
      while (rounds < 3) {
        const prepared = await prepareRevocation({ kind: sessionId === undefined ? 'workspace' : 'session', sessionIds: sessionId === undefined ? [] : [sessionId], documents: [] }, cleanup => { original.preparation = cleanup }, 3 - rounds, rounds === 0 ? original.initialTickets : undefined, original)
        const record = revocationPreparations.get(prepared)
        if (!record?.first || !record.coverage) throw TypeError('Original clear preparation required')
        rounds += record.rounds
        let applied = false
        await cleanupTransition([sessionId], async settled => {
          // Same original handle/receipt only. No caller-supplied effect callback.
          const flight = gate.exclusive(undefined, async lease => {
            await record.original.acquireLifetime(); assertOriginalRevocationCoverage(record.coverage!, record.first!.targets)
            return owner.mutate(async turn => {
              const cutoff = Date.now(), managed = await artifacts.passiveReleaseInventory(turn, [], record.io)
              const legacy = await record.original.passiveInventory(turn, sessionId, cutoff)
              const targets = Object.freeze([...new Set([...(sessionId === undefined ? [] : [sessionId]), ...managed.targets, ...legacy.targets])].sort())
              if (canonicalJsonData({ managed, legacy, targets }) !== canonicalJsonData(record.first)) return false
              record.matched = { managed, legacy, targets }; record.frontier = cutoff
              assertOriginalRevocationCoverage(record.coverage!, targets)
              const effect = beginOriginalRevocationEffect(record.coverage!)
              try {
                protectedResults = await artifacts.protectedCount()
                if (candidate && candidate !== record.original || store && store !== record.original) throw Error('Original clear store changed')
                let present = true
                try { await fileAccess(record.original.directory) } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') present = false; else throw failure }
                if (candidate || store || present) candidate = store = record.original
                record.effect = await record.original.prepareCoveredClear(turn, lease, record.matched!.legacy, record.coverage!)
                await record.original.applyCoveredClear(turn, lease, config.maxDiskBytes, record.effect)
                return true
              } finally { effect.close() }
            }, cleanup => { record.workspaces.push(cleanup) })
          })
          record.effectFlight = flight; applied = await flight
          if (applied) settled(sessionId)
        }).promise
        await prepared.close(); original.preparation = undefined
        if (applied) return status()
      }
      throw Error('Original clear inventory changed repeatedly')
    }))
    void running.then(value => { releaseClearFence(original); completion.resolve(value) }, cause => { original.debt = { cause }; error = cause instanceof Error ? cause.message : String(cause); state = 'error'; completion.reject(cause) })
    return completion.promise
  }
  revocationPreparers.set(service, async (coordinator, request, retain) => {
    const topology = legacyOrderingOwners.get(service)!
    if (pendingDeletionTopologies().length) throw Error('Original deletion topology operation busy')
    if (!topology.coordinators.has(coordinator)) throw Error('Original complete service registration required')
    return prepareRevocation(request, retain)
  })
  async function prepareRevocation(request: OriginalResultRevocationRequest, retain: (cleanup: OriginalResultRevocationPreparation) => void, limit = 3, initial?: readonly { port: ResultRevocationAdmission; ticket: OriginalResultRevocationTicket }[], clear?: FiniteClear): Promise<OriginalResultRevocationPreparation> {
    assertOpen(); assertOrderingOutside()
    fields(request, ['kind', 'sessionIds', 'documents'])
    if (typeof retain !== 'function' || !['workspace', 'session'].includes(request.kind)) throw TypeError('Original revocation request required')
    const ids = captureResultTargetIds(request.sessionIds), documents = captureResultTargetIds(request.documents), kind = request.kind
    for (const id of [...ids, ...documents]) identity(id, 'revocation identity')
    const topology = legacyOrderingOwners.get(service)!
    if (clear && (finiteClear !== clear || clearContext.getStore() !== clear || !topology.operations.has(clear) || documents.length || (clear.sessionId === undefined ? kind !== 'workspace' || ids.length !== 0 : kind !== 'session' || ids.length !== 1 || ids[0] !== clear.sessionId))) throw TypeError('Original finite clear owner required')
    const members = [...topology.coordinators], ports = [...new Set(members.map(([, port]) => port))], domain = captureOriginalRevocationDomain(ports), participant = topology.participant
    if (!clear) assertOutsideOriginalRevocationOrdering(domain)
    const check = () => { assertOpen(); if (members.length !== topology.coordinators.size) throw Error('Original result topology changed'); for (const [coordinator, port] of members) if (topology.coordinators.get(coordinator) !== port || originalResultRevocationFor(coordinator) !== port) throw TypeError('Changed original revocation association') }
    let tickets: OriginalResultRevocationTicket[] = [], finished = false, closingFlight: Promise<void> | undefined
    const io = createArtifactQualificationIO(), workspaces: WorkspaceMutationCleanup[] = []
    const original = candidate ?? new ContextStore(options.root, workspaceId, owner, gate.assertLease, revokeSelectedAuthorities, revokeResumedAuthorities), record: RevocationRecord = { original, rounds: 0, io, workspaces }
    const done = Promise.withResolvers<void>(); let passFlight: Promise<unknown> | undefined
    const dependentCleanup = Object.freeze({
      assertSettled() { io.assertSettled(); original.assertLegacyFilesSettled(); for (const cleanup of workspaces) cleanup.assertSettled(); if (!original.lifetimeSettled()) throw Error('Original discovery lifetime cleanup unresolved'); if (record.effect) original.assertCoveredClearSettled(record.effect) },
      async close() {
        await passFlight?.catch(() => {}); await record.effectFlight?.catch(() => {})
        await io.settle(); io.assertSettled(); await original.joinLegacyFiles(); original.assertLegacyFilesSettled()
        for (const cleanup of workspaces) { await cleanup.close(); cleanup.assertSettled() }
        await gate.exclusive(undefined, lease => original.quiesce(lease)); dependentCleanup.assertSettled()
      },
    })
    const handle: OriginalResultRevocationPreparation = Object.freeze({
      get frontier() { if (this !== handle || record.frontier === undefined || finished) throw Error('Original frontier unavailable'); return record.frontier },
      assertCovered(requested: readonly string[]) { if (this !== handle || record.frontier === undefined || finished || !record.coverage) throw Error('Original revocation preparation unavailable'); check(); assertOriginalRevocationCoverage(record.coverage, requested) },
      close() {
        if (this !== handle) return Promise.reject(TypeError('Original revocation preparation required'))
        assertOrderingOutside()
        if (finished) return Promise.resolve()
        if (closingFlight) return closingFlight
        const flight = (async () => {
          await done.promise
          if (record.coverage) await closeOriginalRevocationCoverage(record.coverage); else await dependentCleanup.close()
          for (const ticket of tickets) await ticket.close()
          finished = true; revocationPreparations.delete(handle); topology.operations.delete(handle)
        })()
        closingFlight = flight; void flight.finally(() => { if (closingFlight === flight) closingFlight = undefined }).catch(() => {}); return flight
      },
    })
    revocationPreparations.set(handle, record); topology.operations.add(handle)
    try { retain(handle) } catch (failure) { revocationPreparations.delete(handle); topology.operations.delete(handle); done.resolve(); throw failure }
    async function pass() {
      check(); for (const ticket of tickets) ticket.assertCurrent()
      return gate.exclusive(undefined, async lease => {
        await original.acquireLifetime(); check()
        const inventory = await owner.mutate(async turn => {
          const cutoff = Date.now(), managed = await artifacts.passiveReleaseInventory(turn, documents, io); check()
          const legacy = await original.passiveInventory(turn, kind === 'workspace' ? undefined : ids[0], cutoff); check()
          if (kind === 'session' && ids.length !== 1) throw Error('One original session request required')
          const targets = Object.freeze([...new Set([...ids, ...managed.targets, ...legacy.targets])].sort())
          if (managed.recoveryRequired || legacy.recoveryRequired) throw Error('Original revocation inventory recovery required')
          return { inventory: { managed, legacy, targets }, cutoff }
        }, cleanup => { workspaces.push(cleanup) })
        await original.quiesce(lease); check(); return inventory
      })
    }
    try {
      for (let attempt = 0; attempt < limit; attempt++) {
        record.rounds++; tickets = []
        if (attempt === 0 && initial) {
          if (initial.length !== ports.length || initial.some((entry, index) => entry.port !== ports[index])) throw Error('Changed original clear topology')
          tickets = initial.map(entry => entry.ticket)
        } else for (const port of ports) tickets.push(port.begin(issueOriginalResultRevocationScope(port, { kind, sessionIds: ids }, participant)))
        for (let index = 0; index < ports.length; index++) ports[index]!.retainCleanup(tickets[index]!, dependentCleanup)
        await Promise.all(tickets.map(ticket => ticket.join()))
        const { inventory: first } = await (passFlight = pass()); io.assertSettled(); original.assertLegacyFilesSettled()
        for (const cleanup of workspaces) cleanup.assertSettled()
        record.coverage = await acquireOriginalRevocationCoverage(domain, tickets, first.targets, coverage => { record.coverage = coverage }, clear?.origin); check()
        if (clear) { record.first = first; return handle }
        const { inventory: second, cutoff } = await (passFlight = pass())
        for (const cleanup of workspaces) cleanup.assertSettled()
        if (canonicalJsonData(first) === canonicalJsonData(second)) { assertOriginalRevocationCoverage(record.coverage, second.targets); record.matched = second; record.frontier = cutoff; return handle }
        await closeOriginalRevocationCoverage(record.coverage); for (const ticket of tickets) await ticket.close(); tickets = []; record.coverage = undefined
      }
      throw Error('Original revocation inventory changed repeatedly')
    } finally { done.resolve() }
  }
  artifactSettlement.set(service,artifacts.settleSeedDependencyTransfer)
  coldManagedOwners.set(service, { acquireColdManagedQualification(...args) { assertOpen(); return artifacts.acquireColdManagedQualification(...args) }, revokeColdTransfers: artifacts.revokeColdTransfers })
  coldSelectedRevokers.set(service, revokeSelectedAuthorities)
  coldSelectedOwners.set(service, (coordinator, input, sourceId) => {
    assertOpen(); identity(sourceId, 'sourceId')
    const cold = captureOriginalColdObservation(coordinator, input), sessionId = cold.metadata.sessionId
    const outstanding = selectedAcquisitionDebts.values().next().value; if (outstanding) throw outstanding.failure
    let acquisitionStore: ContextStore | undefined
    const observation: LegacyReadObservation = Object.freeze({ sessionId, sourceId,
      bootstrap: Object.freeze({ invocation: cold.facts.invocation, manifestDigest: cold.facts.manifestDigest, seedDigest: cold.facts.seedDigest }), selectedView: cold.view,
      assertCurrent() { captureOriginalColdObservation(coordinator, cold) },
      localVisible() { throw Error('Cold legacy source lookup unavailable') }, anchorVisible() { throw Error('Cold legacy source lookup unavailable') },
    })
    const withRead = <T>(work: (current: ContextStore) => Promise<T>) => run(undefined, async signal => {
      await gate.exclusive(signal, async lease => {
        gate.assertLease(lease, 'exclusive'); assertOpen()
        const current = candidate ?? (candidate = new ContextStore(options.root, workspaceId, owner, gate.assertLease, revokeSelectedAuthorities, revokeResumedAuthorities))
        if (acquisitionStore && acquisitionStore !== current) throw Error('Original cold metadata store changed')
        acquisitionStore = current; await current.resume(lease, config.maxDiskBytes, signal)
      })
      return gate.shared(signal, async lease => {
        gate.assertLease(lease); assertOpen(); const current = store ?? candidate
        if (!current || acquisitionStore && acquisitionStore !== current) throw Error('Original cold metadata store changed')
        acquisitionStore = current; historicalSelectedReaders.add(selected); return work(current)
      })
    })
    const settle = () => gate.exclusive(undefined, async lease => {
      gate.assertLease(lease, 'exclusive'); const original = acquisitionStore
      if (!original) return
      if (closedSelectedStore === original) { acknowledgeSelectedAcquisitions(original); return }
      if ((store ?? candidate) !== original) throw Error('Original cold metadata store changed')
      await original.joinLegacyFiles(); original.assertLegacyFilesSettled(); acknowledgeSelectedAcquisitions(original)
    })
    const assertCurrent = () => { assertOpen(); if (acquisitionStore && (store ?? candidate) !== acquisitionStore) throw Error('Original cold metadata store changed') }
    let selected!: ReturnType<typeof createColdSelectedMetadata> & { cleanupForError(error: unknown): SelectedCleanup | undefined }
    const original = createColdSelectedMetadata(observation, withRead, settle, assertCurrent, () => selectedReaders.delete(selected))
    let failed = false, closeError: unknown
    const receiver = (value: unknown) => { if (value !== selected) throw TypeError('Invalid cold selected receiver') }
    selected = Object.freeze({ qualify() { receiver(this); return original.qualify() }, sealWhileActive() { receiver(this); original.sealWhileActive() }, settle() { receiver(this); return original.settle() }, assertSettledCurrent() { receiver(this); original.assertSettledCurrent() }, revoke() { receiver(this); original.revoke() }, async close() { receiver(this); try { await original.close(); failed = false } catch (failure) { failed = true; closeError = failure; throw failure } }, cleanupForError(failure: unknown) { receiver(this); return failed && failure === closeError ? { retry: () => selected.close() } : undefined } })
    selectedReaderIds.set(selected, sessionId); selectedReaders.add(selected); return selected
  })
  selectedLegacyOwners.set(service,legacy.selected)
  selectedMetadataOwners.set(service,{cleanupForError(error){for(const debt of selectedAcquisitionDebts)if(debt.failure===error)return debt.cleanup;for(const reader of selectedReaders){const cleanup=reader.cleanupForError(error);if(cleanup)return cleanup}},async acquire(observation){
    assertOpen()
    const sessionField=Object.getOwnPropertyDescriptor(observation,'sessionId');if(!sessionField||!('value' in sessionField)||typeof sessionField.value!=='string')throw Error('Invalid metadata source')
    const sessionId=sessionField.value
    const outstanding=selectedAcquisitionDebts.values().next().value
    if(outstanding)throw outstanding.failure
    let acquisitionStore:ContextStore|undefined
    const withRead=<T>(work:(current:ContextStore)=>Promise<T>)=>run(undefined,async signal=>{
      await gate.exclusive(signal,async lease=>{gate.assertLease(lease,'exclusive');assertOpen();const current=store??candidate??(candidate=new ContextStore(options.root,workspaceId,owner,gate.assertLease,revokeSelectedAuthorities,revokeResumedAuthorities));await current.resume(lease,config.maxDiskBytes,signal)})
      return gate.shared(signal,async lease=>{gate.assertLease(lease);assertOpen();const current=store??candidate;if(!current)throw Error('Original metadata store unavailable');if(acquisitionStore&&acquisitionStore!==current)throw Error('Original metadata store changed');acquisitionStore=current;return work(current)})
    })
    let selected!:SelectedMetadataRecord
    const settle=(original:ContextStore,stillOwed:()=>boolean=()=>true)=>gate.exclusive(undefined,async lease=>{gate.assertLease(lease,'exclusive');if(!stillOwed())return;if(closedSelectedStore===original){acknowledgeSelectedAcquisitions(original);return}if((store??candidate)!==original)throw Error('Original metadata store changed');await original.joinLegacyFiles();acknowledgeSelectedAcquisitions(original)})
    let originalReader:SelectedMetadataOwner
    try { originalReader=await createSelectedMetadata(observation,withRead,settle,assertOpen,()=>selectedReaders.delete(selected)) }
    catch(error) {
      const original=acquisitionStore??store??candidate
      if(original)try{await settle(original)}catch(cleanup){const debt:SelectedAcquisitionDebt={store:original,settled:false,failure:new AggregateError([error,cleanup],'Original selected metadata cleanup unresolved'),cleanup:Object.freeze({async retry(){if(debt.settled)return;await settle(original,()=>!debt.settled)}})};selectedAcquisitionDebts.add(debt);throw debt.failure}
      throw error
    }
    let failed=false,closeError:unknown
    selected=Object.freeze({...originalReader,async close(){try{await originalReader.close();failed=false}catch(error){failed=true;closeError=error;throw error}},cleanupForError(error:unknown){return failed&&error===closeError?{retry:()=>selected.close()}:undefined}})
    selectedReaderIds.set(selected,sessionId);selectedReaders.add(selected);historicalSelectedReaders.add(selected)
    try{assertOpen()}catch(error){await selected.close();throw error}
    return selected
  }})
  associateManagedResultRefusal(service)
  const methodNames=['registerResultScope','beginResult','confirmResultOwner'] as const
  const originalMethods=methodNames.map(name=>Object.getOwnPropertyDescriptor(service,name)!)
  let querying=false
  const assertManifestService=()=>{
    if(closing||closed)throw new Error('Original manifest service closed')
    for(const [i,name] of methodNames.entries()){
      const field=Object.getOwnPropertyDescriptor(service,name),original=originalMethods[i]!
      if(!field||!('value'in field)||field.value!==original.value||field.enumerable!==original.enumerable||field.configurable!==original.configurable||field.writable!==original.writable)throw new Error('Original service methods required')
    }
  }
  codeManifestQueries.set(service, (...args) => {
    if(querying)throw new Error('Original manifest query reentry unavailable')
    assertManifestService();querying=true
    try{const result=artifacts.captureConfirmedCodeManifest(...args);assertManifestService();return result}finally{querying=false}
  })
  codeManifestScopeQueries.set(service, scope => {
    if(querying)throw new Error('Original manifest query reentry unavailable')
    assertManifestService();querying=true
    try{artifacts.assertOriginalManifestScope(scope);assertManifestService()}finally{querying=false}
  })
  return service
}
