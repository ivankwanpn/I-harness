import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { canonicalJsonData, type BootstrapDependencyRequest, type BootstrapDependencyOutcome, type ManagedArtifactRef } from '@i-harness/core-session'
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

interface Registration { access: SeedDependencyHostAccess; request?: string; target?: string; revoked: boolean; publications?: Map<string, { value: string; original: ReturnType<typeof createAtomicJsonPublication> }> }
interface SourceRelation { ref: ManagedArtifactRef; viaCatalog?: ManagedArtifactRef }
interface Publication { path: string; value: ArtifactPin | TransferMembership | { version: 1; sessionId: string; revision: string; pinId: string }; relations: Set<SourceRelation> }
export function createSeedDependencyTransfer(deps: {
  root: string; options: ContextOutputOptions; directory(id: string): string; quota(): number;
  mutate<T>(work: () => Promise<T>): Promise<T>;
  available(document: string): boolean;
  authorized(access: ContextAccess, ref: ManagedArtifactRef, viaCatalog?: ManagedArtifactRef, verifyOriginalCatalog?: boolean): Promise<ArtifactOperation>;
  membership: ReturnType<typeof createDependencyMembership>;
}) {
  const scopes = new WeakMap<SeedDependencyTransferScope, Registration>()
  // Original publication IO cleanup only; this collection grants no authority.
  const publicationIO = new Set<ReturnType<typeof createAtomicJsonPublication>>()
  function registerSeedDependencyTransfer(access: SeedDependencyHostAccess, originalPublication?: 'original-publication'): SeedDependencyTransferScope {
    const captured = captureHost(access)
    if (!deps.available(captured.binding.targetDocumentId)) throw new TransferBlocked('unavailable')
    const scope = Object.freeze({ kind: 'seed-dependency-transfer' as const })
    scopes.set(scope, { access: captured, revoked: false, ...(originalPublication === 'original-publication' ? { publications: new Map() } : {}) }); return scope
  }
  function metadataOutcome(result: ImmutableMetadataOutcome): void {
    if (result.kind !== 'confirmed') throw new TransferBlocked(result.kind === 'conflict' ? 'conflict' : result.kind === 'absent' || result.kind === 'not-issued' ? 'unavailable' : 'unknown')
  }
  function invoke(scope: SeedDependencyTransferScope, input: BootstrapDependencyRequest, caller: (() => boolean) | undefined): Promise<BootstrapDependencyOutcome> {
    let registration: Registration, request: BootstrapDependencyRequest
    try {
      const held = scopes.get(scope); if (!held) throw new TransferBlocked('unavailable')
      registration = held; request = captureRequest(input, held.access.binding)
      const encoded = canonicalJsonData(request)
      if (held.request !== undefined && held.request !== encoded) throw new TransferBlocked('conflict')
      held.request ??= encoded
      if (caller !== undefined && typeof caller !== 'function') throw new TransferBlocked('conflict')
    } catch (cause) { return Promise.resolve({ kind: 'blocked', reason: cause instanceof TransferBlocked ? cause.reason : 'conflict' }) }
    return deps.mutate(async () => {
      const { access } = registration, binding = access.binding, passive = caller === undefined
      let targetSourceId: string
      const check = () => {
        if (!deps.available(binding.targetSessionId) || !deps.available(binding.targetDocumentId)) throw new TransferBlocked('unavailable')
        if (registration.revoked) throw new TransferBlocked('policy')
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
      try {
        check()
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
          const value = await wait(deps.membership.operation(ref))
          // A zero-length verified range checks the retained manifest, index
          // header/root and physical file sizes without reading body bytes.
          await wait(readVerifiedArtifactBytes(deps.root, deps.directory(ref.id), ref, 0, 0))
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
          }, use.count))
        }
        // All original metadata, catalog EOF and source witnesses are verified
        // before the first target mutation. Existing final/pending bytes also
        // participate before issuing any missing publication.
        const unfinished: Publication[] = []
        for (const publication of publications.values()) {
          const { path, value } = publication
          if (!registration.publications) {
            const result = await wait(confirmAtomicJson(deps.root, path, value))
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
              try { await wait(mkdir(directory)) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; check() }
              await wait(ownedPath(deps.root, directory))
            }
            await renew(relations)
            check(); metadataOutcome(await wait(registration.publications ? registration.publications.get(path)!.original.issue(() => { check(); return true }) : continueAtomicJson(deps.root, path, value, () => { check(); return true })))
            await renew(relations)
          }
        }
        // A surviving source is irrelevant to passive confirmation. Only exact
        // target publications, original operations and target policy gate it.
        for (const { path, value } of publications.values()) metadataOutcome(await wait(registration.publications ? registration.publications.get(path)!.original.confirm() : confirmAtomicJson(deps.root, path, value)))
        for (const value of operations.values()) {
          if (canonicalJsonData(await wait(deps.membership.operation(value.ref!))) !== canonicalJsonData(value)) throw new TransferBlocked('conflict')
          await wait(readVerifiedArtifactBytes(deps.root, deps.directory(value.id), value.ref!, 0, 0))
        }
        for (const value of operations.values()) targetCompatible(value)
        // No source callbacks in PASSIVE. NEW must renew all direct and via
        // relations after the last publication/integrity await before success.
        await renew(sourceRelations.values())
        check(); return { kind: 'confirmed', closureDigest: closure.finish() }
      } catch (cause) {
        return { kind: 'blocked', reason: cause instanceof TransferBlocked ? cause.reason : (cause as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'unknown' }
      }
    })
  }
  return { registerSeedDependencyTransfer,
    async closeTransfers() { for (const original of publicationIO) await original.close() },
    confirmSeedDependencies: (scope: SeedDependencyTransferScope, request: BootstrapDependencyRequest, current: () => boolean): Promise<BootstrapDependencyOutcome> => typeof current === 'function' ? invoke(scope, request, current) : Promise.resolve({ kind: 'blocked', reason: 'conflict' }),
    reconcileSeedDependencies: (scope: SeedDependencyTransferScope, request: BootstrapDependencyRequest) => invoke(scope, request, undefined) }
}
