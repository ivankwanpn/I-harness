import { createArtifactQualificationIO, type ArtifactQualificationIO } from './qualification-io.ts'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canonicalJsonData, EMPTY_SEMANTIC_DEPENDENCY_DIGEST, type BootstrapDependencyRequest, type BootstrapDependencyOutcome, type ManagedArtifactRef } from '@i-harness/core-session'
import { failuresTogether, type WorkspaceMutationCleanup } from '../workspace-mutation.ts'
import type { ContextAccess, ContextOutputOptions } from '../types.ts'
import { confirmAtomicJson, continueAtomicJson, createAtomicJsonPublication, ownedPath, type ImmutableMetadataOutcome } from './io.ts'
import { createDependencyMembership, validTransferMembership, type TransferMembership } from './dependency-membership.ts'
import { readDependencyCatalog } from './dependency-catalog.ts'
import type { ArtifactPin } from './pins.ts'
import { requireSpace } from './quota.ts'
import { sha } from './manifest.ts'
import { readVerifiedArtifactBytes } from './reader.ts'
import type { ArtifactOperation } from './types.ts'
import { captureHost, captureRequest, captureTarget, TransferBlocked, type SeedDependencyHostAccess, type SeedDependencyTransferScope } from './transfer-codec.ts'
import { canonicalCompare, createTransferClosure } from './transfer-closure.ts'
export type { SeedDependencyHostAccess, SeedDependencyTransferBinding, SeedDependencyTransferScope } from './transfer-codec.ts'

interface Registration { passiveOnly?: boolean; activeAcknowledged?: true; io:ArtifactQualificationIO; access: SeedDependencyHostAccess; request?: string; target?: string; revoked: boolean; checking?:boolean; publications?: Map<string, { value: string; original: ReturnType<typeof createAtomicJsonPublication> }> }
export interface ColdManagedQualification { qualify(): Promise<void>; sealWhileActive(): void; settle(): Promise<void>; assertSettledCurrent(): void; revoke(): void; close(): Promise<void> }
interface SourceRelation { ref: ManagedArtifactRef; viaCatalog?: ManagedArtifactRef }
interface Publication { path: string; value: ArtifactPin | TransferMembership | { version: 1; sessionId: string; revision: string; pinId: string }; relations: Set<SourceRelation> }
export function createSeedDependencyTransfer(deps: {
  root: string; options: ContextOutputOptions; directory(id: string): string; quota(): number;
  mutate<T>(work: () => Promise<T>, retain?: (cleanup: WorkspaceMutationCleanup) => void): Promise<T>;
  available(document: string): boolean;
  authorized(access: ContextAccess, ref: ManagedArtifactRef, viaCatalog?: ManagedArtifactRef, verifyOriginalCatalog?: boolean): Promise<ArtifactOperation>;
  membership: ReturnType<typeof createDependencyMembership>;
}) {
  let qualificationClosing=false
  const scopes = new WeakMap<SeedDependencyTransferScope, Registration>()
  // Original publication IO cleanup only; this collection grants no authority.
  const qualificationIO = new Set<ArtifactQualificationIO>()
  const publicationIO = new Set<ReturnType<typeof createAtomicJsonPublication>>()
  const coldQualifications = new Set<{ ids: readonly string[]; revoke(): void; close(): Promise<void> }>()
  // The WeakMap scope retains identity. Only active/debt IO needs strong cleanup ownership.
  function retireEmptyQualification(io:ArtifactQualificationIO){try{io.assertSettled();qualificationIO.delete(io)}catch{/* original active cleanup debt stays reachable */}}
  async function settleQualification(io:ArtifactQualificationIO){qualificationIO.add(io);try{await io.settle()}finally{retireEmptyQualification(io)}}
  function registerSeedDependencyTransfer(access: SeedDependencyHostAccess, originalPublication?: 'original-publication'): SeedDependencyTransferScope {
    const captured = captureHost(access)
    if (!deps.available(captured.binding.targetDocumentId)) throw new TransferBlocked('unavailable')
    const scope = Object.freeze({ kind: 'seed-dependency-transfer' as const })
    const io=createArtifactQualificationIO()
    scopes.set(scope, { io, access: captured, revoked: false, ...(originalPublication === 'original-publication' ? { publications: new Map() } : {}) }); return scope
  }
  function metadataOutcome(result: ImmutableMetadataOutcome): void {
    if (result.kind !== 'confirmed') throw new TransferBlocked(result.kind === 'conflict' ? 'conflict' : result.kind === 'absent' || result.kind === 'not-issued' ? 'unavailable' : 'unknown')
  }
  function invoke(scope: SeedDependencyTransferScope, input: BootstrapDependencyRequest, caller: (() => boolean) | undefined, retain?: (cleanup: WorkspaceMutationCleanup) => void): Promise<BootstrapDependencyOutcome> {
    let registration: Registration, request: BootstrapDependencyRequest
    try {
      const held = scopes.get(scope); if (!held) throw new TransferBlocked('unavailable')
      if(held.checking){held.revoked=true;throw new TransferBlocked('policy')}
      if (held.passiveOnly && caller !== undefined) throw new TransferBlocked('policy')
      registration = held; request = captureRequest(input, held.access.binding, held.passiveOnly)
      const encoded = canonicalJsonData(request)
      if (held.request !== undefined && held.request !== encoded) throw new TransferBlocked('conflict')
      held.request ??= encoded
      if (caller !== undefined && typeof caller !== 'function') throw new TransferBlocked('conflict')
    } catch (cause) { return Promise.resolve({ kind: 'blocked', reason: cause instanceof TransferBlocked ? cause.reason : 'conflict' }) }
    // A genuine active ACK retains this original operation's settlement window,
    // not permission to qualify a new passive scope after close starts.
    const retainedReconciliation = caller === undefined && registration.activeAcknowledged === true && !registration.passiveOnly
    const qualificationUnavailable = () => qualificationClosing && !retainedReconciliation
    return deps.mutate<BootstrapDependencyOutcome>(async () => {
      const { access } = registration, binding = access.binding, passive = caller === undefined
      let targetSourceId: string
      const check = () => {
        if(passive&&qualificationUnavailable())throw new TransferBlocked('unavailable')
        if (!deps.available(binding.targetSessionId) || !deps.available(binding.targetDocumentId)) throw new TransferBlocked('unavailable')
        if (registration.revoked) throw new TransferBlocked('policy')
        if('kind' in access){
          if(qualificationUnavailable())throw new TransferBlocked('unavailable')
          if(registration.checking){registration.revoked=true;throw new TransferBlocked('policy')}
          registration.checking=true
          try{
            try{if(!passive){if(!deps.available(binding.sourceSessionId)||caller!()!==true)throw Error('source or caller unavailable');access.sourceAccess.signal?.throwIfAborted()}}catch{throw new TransferBlocked('policy')}
            if(registration.revoked)throw new TransferBlocked('policy')
            try{
              const observed=access.observeCurrent(passive?'passive':'active'),target=captureTarget(observed)
              if(registration.target!==undefined&&registration.target!==target)throw Error('target revision changed')
              registration.target??=target;targetSourceId=observed.source.sourceId
              if(qualificationUnavailable()||registration.revoked||!deps.available(binding.targetSessionId)||!deps.available(binding.targetDocumentId)||!passive&&!deps.available(binding.sourceSessionId))throw Error('transfer retired')
            }catch{registration.revoked=true;throw new TransferBlocked('policy')}
          }finally{registration.checking=false}
          return
        }
        try {
          if (access.targetAvailable() !== true) throw new Error('target unavailable')
          access.assertTargetCurrent()
          const observed = access.targetScope(), target = captureTarget(observed)
          if (registration.target !== undefined && registration.target !== target) throw new Error('target revision changed')
          registration.target ??= target
          targetSourceId = observed.source.sourceId
        } catch { registration.revoked = true; throw new TransferBlocked('policy') }
        try {
          if (!passive) {
            if (!deps.available(binding.sourceSessionId) || access.sourceAvailable() !== true || caller!() !== true) throw new Error('source or caller unavailable')
            access.sourceAccess.signal?.throwIfAborted(); access.assertSourceCurrent()
          }
        } catch { throw new TransferBlocked('policy') }
      }
      // Every asynchronous boundary checks currentness before its result can
      // inform another read, mutation, or successful acknowledgement.
      const wait = async <T>(promise: Promise<T>): Promise<T> => { const result = await promise; check(); return result }
      qualificationIO.add(registration.io)
      try {
        await registration.io.settle();check()
        const roots = [...request.artifacts].sort((a, b) => canonicalCompare(a.ref, b.ref)), operations = new Map<string, ArtifactOperation>()
        const publications = new Map<string, Publication>(), closure = createTransferClosure(deps.options.workspaceId, binding)
        // These are immutable relation descriptors for this attempt, never
        // cached authorization decisions. A shared member retains every via.
        const sourceRelations = new Map<string, SourceRelation>()
        function sourceRelation(ref: ManagedArtifactRef, viaCatalog?: ManagedArtifactRef): SourceRelation {
          const key = canonicalJsonData([ref, viaCatalog ?? null])
          let relation = sourceRelations.get(key)
          if (!relation) { relation = { ref, ...(viaCatalog ? { viaCatalog } : {}) }; sourceRelations.set(key, relation) }
          return relation
        }
        async function renew(relations: Iterable<SourceRelation>) {
          if (passive) return
          for (const relation of relations) {
            check()
            await wait(deps.authorized(access.sourceAccess, relation.ref, relation.viaCatalog, relation.viaCatalog !== undefined))
          }
        }
        function publication(path: string, value: Publication['value'], relation: SourceRelation) {
          const existing = publications.get(path)
          if (existing) {
            if (canonicalJsonData(existing.value) !== canonicalJsonData(value)) throw new TransferBlocked('conflict')
            existing.relations.add(relation)
          } else publications.set(path, { path, value, relations: new Set([relation]) })
        }
        async function operation(ref: ManagedArtifactRef) {
          const key = canonicalJsonData(ref), prior = operations.get(key)
          if (prior) return prior
          const value = await wait(deps.membership.operation(ref,registration.io))
          // A zero-length verified range checks the retained manifest, index
          // header/root and physical file sizes without reading body bytes.
          await wait(readVerifiedArtifactBytes(deps.root, deps.directory(ref.id), ref, 0, 0, registration.io))
          operations.set(key, value); return value
        }
        function targetCompatible(value: ArtifactOperation) {
          check()
          // The genuine captured preparation scope is staging authority before
          // READY. Ordinary target read visibility is deliberately not queried.
          if (value.owner.source && value.owner.source.sourceId !== targetSourceId) throw new TransferBlocked('policy')
        }
        function retain(value: ArtifactOperation, relation: SourceRelation) {
          const ref = value.ref!, directory = deps.directory(ref.id), pinId = sha(binding.targetDocumentId)
          const pin: ArtifactPin = { version: 1, documentId: binding.targetDocumentId, sessionId: binding.targetSessionId, operationId: value.owner.operationId, revision: ref.revision, state: 'committed', seedTransfer: binding }
          publication(resolve(directory, 'pins', pinId + '.json'), pin, relation)
          publication(resolve(directory, 'access', sha(binding.targetSessionId) + '.json'), { version: 1, sessionId: binding.targetSessionId, revision: ref.revision, pinId }, relation)
        }
        for (const artifact of roots) {
          const value = await operation(artifact.ref), relation = sourceRelation(artifact.ref)
          await renew([relation])
          targetCompatible(value); closure.root(artifact, value.owner); retain(value, relation)
        }
        for (const artifact of roots) {
          const use = artifact.uses.find(use => use.kind === 'dependency-catalog')
          if (!use || use.kind !== 'dependency-catalog') continue
          const catalog = await operation(artifact.ref), canonical = new Set<string>()
          closure.catalog()
          await wait(readDependencyCatalog(deps.root, deps.directory(artifact.ref.id), artifact.ref, async (entry, ordinal) => {
            check()
            if (entry.retention.kind !== 'artifact') { closure.entry(artifact.ref, catalog.owner, ordinal, entry); return }
            const memberRef = entry.retention.ref, member = await operation(memberRef)
            closure.entry(artifact.ref, catalog.owner, ordinal, entry, member.owner)
            const key = canonicalJsonData(memberRef)
            if (canonical.has(key)) return
            canonical.add(key)
            const relation = sourceRelation(memberRef, artifact.ref)
            await renew([relation])
            targetCompatible(member); retain(member, relation)
            const record: TransferMembership = { version: 2, kind: 'result-dependency-transfer', workspaceId: deps.options.workspaceId, documentId: binding.targetDocumentId, sessionId: binding.targetSessionId,
              memberRef, catalogRef: artifact.ref, catalogOperationId: catalog.owner.operationId, sourceId: entry.sourceId, ordinal, catalogOwner: catalog.owner,
              memberOperationId: member.owner.operationId, manifestDigest: binding.manifestDigest, transferOperationId: binding.operationId, sourceSessionId: binding.sourceSessionId }
            if (!validTransferMembership(record)) throw new TransferBlocked('unavailable')
            const path = deps.membership.companion(memberRef, binding.targetDocumentId, artifact.ref)
            publication(path, record, relation)
          }, use.count, registration.io))
        }
        // All original metadata, catalog EOF and source witnesses are verified
        // before the first target mutation. Existing final/pending bytes also
        // participate before issuing any missing publication.
        const unfinished: Publication[] = []
        for (const publication of publications.values()) {
          const { path, value } = publication
          if (!registration.publications) {
            const result = await wait(confirmAtomicJson(deps.root, path, value,undefined,registration.io))
            if (passive || result.kind === 'conflict') metadataOutcome(result)
            if (result.kind !== 'confirmed') unfinished.push(publication)
            continue
          }
          let retained = registration.publications.get(path)
          const encoded = canonicalJsonData(value)
          if (retained && retained.value !== encoded) throw new TransferBlocked('conflict')
          if (!retained) {
            if (passive) throw new TransferBlocked('unknown')
            retained = { value: encoded, original: createAtomicJsonPublication(deps.root, path, value) }
            registration.publications.set(path, retained)
            publicationIO.add(retained.original)
          }
          const result = await wait(passive ? retained.original.settle(() => { check(); return true }) : retained.original.confirm())
          if (passive || result.kind === 'conflict') metadataOutcome(result)
          // NEW may continue its exact retained pending transaction; already
          // confirmed publications require neither growth nor mkdir/cleanup.
          if (result.kind !== 'confirmed') unfinished.push(publication)
        }
        if (!passive && unfinished.length) {
          await wait(requireSpace(deps.root, deps.quota(), unfinished.reduce((n, item) => n + Buffer.byteLength(JSON.stringify(item.value)) + 4096, 0)))
          // Preflight may outlive branch/ref visibility even when the source
          // runtime and captured project revision remain current.
          await renew(sourceRelations.values())
          for (const { path, value, relations } of unfinished) {
            await renew(relations)
            const parent = dirname(path), isCompanion = 'kind' in value && value.kind === 'result-dependency-transfer'
            const directories = isCompanion ? [dirname(parent), parent] : [parent]
            for (const directory of directories) {
              check()
              try { await wait(mkdir(directory)) } catch (cause) { if ((cause as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw cause; check() }
              await wait(ownedPath(deps.root, directory))
            }
            await renew(relations)
            check(); metadataOutcome(await wait(registration.publications ? registration.publications.get(path)!.original.issue(() => { check(); return true }) : continueAtomicJson(deps.root, path, value, () => { check(); return true })))
            await renew(relations)
          }
        }
        // A surviving source is irrelevant to passive confirmation. Only exact
        // target publications, original operations and target policy gate it.
        for (const { path, value } of publications.values()) metadataOutcome(await wait(registration.publications ? registration.publications.get(path)!.original.confirm() : confirmAtomicJson(deps.root, path, value,undefined,registration.io)))
        for (const value of operations.values()) {
          if (canonicalJsonData(await wait(deps.membership.operation(value.ref!,registration.io))) !== canonicalJsonData(value)) throw new TransferBlocked('conflict')
          await wait(readVerifiedArtifactBytes(deps.root, deps.directory(value.id), value.ref!, 0, 0, registration.io))
        }
        for (const value of operations.values()) targetCompatible(value)
        // No source callbacks in PASSIVE. NEW must renew all direct and via
        // relations after the last publication/integrity await before success.
        await renew(sourceRelations.values())
        registration.io.assertSettled();check(); return { kind: 'confirmed', closureDigest: request.artifacts.length ? closure.finish() : EMPTY_SEMANTIC_DEPENDENCY_DIGEST }
      } catch (cause) {
        return { kind: 'blocked', reason: cause instanceof TransferBlocked ? cause.reason : (cause as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT' ? 'unavailable' : 'unknown' }
      } finally {retireEmptyQualification(registration.io)}
    }, retain).then(outcome => {
      // The mutation promise includes native workspace-release acknowledgment.
      // A callback result alone cannot certify an uncertain release.
      if (caller !== undefined && outcome.kind === 'confirmed') registration.activeAcknowledged = true
      return outcome
    })
  }
  function acquireColdManagedQualification(access: SeedDependencyHostAccess, input: BootstrapDependencyRequest, expectedClosure: string): ColdManagedQualification {
    if (qualificationClosing || !/^[a-f0-9]{64}$/.test(expectedClosure)) throw Error('Cold managed qualification unavailable')
    const scope = registerSeedDependencyTransfer(access), registration = scopes.get(scope)!
    registration.passiveOnly = true
    const request = captureRequest(input, registration.access.binding, true), encoded = canonicalJsonData(request)
    let qualified = false, sealed = false, settled = false, closed = false, target: string | undefined
    let qualification: Promise<void> | undefined, settlement: Promise<void> | undefined, closing: Promise<void> | undefined
    const turns: WorkspaceMutationCleanup[] = []
    const independent = () => {
      if (closed || qualificationClosing || registration.revoked || scopes.get(scope) !== registration || !deps.available(request.targetSessionId) || !deps.available(registration.access.binding.targetDocumentId)) throw Error('Cold managed qualification revoked')
      if (registration.request !== encoded || target !== registration.target) throw Error('Cold managed registration changed')
    }
    const cleanup = async () => {
      const failures: unknown[] = []
      try { await settleQualification(registration.io) } catch (failure) { failures.push(failure) }
      for (const turn of turns) try { await turn.close(); turn.assertSettled() } catch (failure) { failures.push(failure) }
      failuresTogether(failures, 'Cold managed original cleanup unresolved')
    }
    const record = { ids: [request.targetSessionId, registration.access.binding.targetDocumentId], revoke() { registration.revoked = true }, close: () => handle.close() }
    const handle: ColdManagedQualification = Object.freeze({
      qualify() {
        if (this !== handle) throw TypeError('Invalid cold managed receiver')
        if (qualification) return qualification
        if (closed || registration.revoked || qualificationClosing) return Promise.reject(Error('Cold managed qualification revoked'))
        qualification = invoke(scope, request, undefined, turn => { turns.push(turn) }).then(outcome => {
          if (outcome.kind !== 'confirmed' || outcome.closureDigest !== expectedClosure) throw Error('Cold managed closure unavailable')
          qualified = true
        }); void qualification.catch(() => {}); return qualification
      },
      sealWhileActive() {
        if (this !== handle || !qualified || closed || registration.revoked || qualificationClosing) throw Error('Cold managed qualification unverified')
        const originalAccess=registration.access;if('kind'in originalAccess)throw Error('Cold coherent qualification unavailable')
        originalAccess.assertTargetCurrent()
        if (captureTarget(originalAccess.targetScope()) !== registration.target) throw Error('Cold managed target changed')
        target = registration.target; independent(); sealed = true
      },
      settle() {
        if (this !== handle) throw TypeError('Invalid cold managed receiver')
        if (settlement) return settlement
        const flight = (async () => { if (!qualification) throw Error('Cold managed qualification unused'); await qualification; if (!sealed) throw Error('Cold managed qualification unsealed'); await cleanup(); independent(); settled = true })()
        settlement = flight; void flight.finally(() => { if (settlement === flight) settlement = undefined }).catch(() => {}); return flight
      },
      assertSettledCurrent() {
        if (this !== handle || !qualified || !sealed || !settled || settlement || closing) throw Error('Cold managed qualification unsettled')
        independent(); registration.io.assertSettled(); for (const turn of turns) turn.assertSettled()
      },
      revoke() { if (this !== handle) throw TypeError('Invalid cold managed receiver'); record.revoke() },
      close() {
        if (this !== handle) throw TypeError('Invalid cold managed receiver')
        if (closed) return Promise.resolve(); if (closing) return closing
        record.revoke()
        const flight = (async () => { await qualification?.catch(() => {}); await settlement?.catch(() => {}); await cleanup(); closed = true; coldQualifications.delete(record) })()
        closing = flight; void flight.finally(() => { if (closing === flight) closing = undefined }).catch(() => {}); return flight
      },
    })
    coldQualifications.add(record); return handle
  }
  return { registerSeedDependencyTransfer, acquireColdManagedQualification,
    revokeColdTransfers(ids?: readonly string[]) { for (const record of coldQualifications) if (!ids || record.ids.some(id => ids.includes(id))) record.revoke() },
    closeTransferAdmission(){qualificationClosing=true;for(const record of coldQualifications)record.revoke()},
    settleSeedDependencyTransfer(scope:SeedDependencyTransferScope){const registration=scopes.get(scope);if(!registration)throw Error('Original artifact transfer scope required');return deps.mutate(()=>settleQualification(registration.io))},
    async closeTransfers() { const results=await Promise.allSettled([...coldQualifications].map(record=>record.close()).concat([...qualificationIO].map(settleQualification),[...publicationIO].map(original=>original.close())));const failures=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(failures.length)throw new AggregateError(failures,'Original transfer IO cleanup failed') },
    confirmSeedDependencies: (scope: SeedDependencyTransferScope, request: BootstrapDependencyRequest, current: () => boolean): Promise<BootstrapDependencyOutcome> => typeof current === 'function' ? invoke(scope, request, current) : Promise.resolve({ kind: 'blocked', reason: 'conflict' }),
    reconcileSeedDependencies: (scope: SeedDependencyTransferScope, request: BootstrapDependencyRequest) => invoke(scope, request, undefined) }
}
