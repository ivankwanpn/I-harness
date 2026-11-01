import { passiveManagedReleaseInventory } from './release-inventory.ts'
import { mkdir, readdir, rm, lstat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { validManagedArtifactRef, type ManagedArtifactRef, type ResultCodec, type ResultDependency } from '@i-harness/core-session'
import { identity } from '../config.ts'
import type { ContextAccess, ContextOutputOptions } from '../types.ts'
import type { ArtifactOperation, ArtifactOwner, ManagedArtifactPage, ResultArtifactScope, ResultArtifactSink } from './types.ts'
import { readCodeOutputPage } from './code-output-reader.ts'
import { isStrictFactData } from '@i-harness/core-session'
import { sha } from './manifest.ts'
import { atomicJson, boundedJson, ownedPath } from './io.ts'
import { createArtifactWriter, type OwnedArtifactSink } from './writer.ts'
import { reconcileArtifact } from './recovery.ts'
import { readArtifactPage, readVerifiedArtifactBytes } from './reader.ts'
import { readExecFramePage } from './exec-reader.ts'
import { requireSpace } from './quota.ts'
import { publishPin, readPin, releaseDocumentPin } from './pins.ts'
import { confirmArtifactOwner, type OwnerConfirmation } from './owner-confirmation.ts'
import { createDependencyMembership, dependencyEntries, sameArtifactRef, type DependencyRegistration } from './dependency-membership.ts'
import { createSeedDependencyTransfer } from './bootstrap-transfer.ts'
import { TransferBlocked } from './transfer-codec.ts'
import { failuresTogether, type WorkspaceMutationOwner, type WorkspaceMutationCleanup } from '../workspace-mutation.ts'

export function createArtifactOwnership(options: ContextOutputOptions, quota: () => number, mutations: WorkspaceMutationOwner) {
  const root = resolve(options.root, 'context-output', sha(options.workspaceId)), managed = resolve(root, 'managed-v1')
  const scopes = new WeakMap<ResultArtifactScope, { owner: ArtifactOwner; current: () => boolean; codec?: ResultCodec; initialization?: { operation: ArtifactOperation; target: string }; confirmation?: OwnerConfirmation; dependencies?: DependencyRegistration }>()
  const deletedDocuments = new Set<string>()
  let closed = false
  let closing = false
  const sinks = new WeakMap<ResultArtifactScope, ResultArtifactSink>()
  const sinkMethods = new WeakMap<ResultArtifactSink, readonly PropertyDescriptor[]>()
  const confirmed = new WeakMap<ResultArtifactScope, ManagedArtifactRef>()
  const confirming = new WeakMap<ResultArtifactScope, number>()
  const writers = new Set<OwnedArtifactSink>()
  const directory = (id: string) => { if (!/^ctxv1_[a-f0-9]{64}$/.test(id)) throw new Error('Artifact reference unavailable'); return resolve(managed, id) }
  const membership = createDependencyMembership(root, options.workspaceId, directory, quota)
  const mutate = <T>(work: () => Promise<T>, retain?: (cleanup: WorkspaceMutationCleanup) => void): Promise<T> => closing || closed
    ? Promise.reject(new Error('Artifact owner closed')) : mutations.mutate(work, retain)
  function registerResultScope(owner: ArtifactOwner, current: () => boolean): ResultArtifactScope {
    if (closing || closed || deletedDocuments.has(owner.sessionId) || deletedDocuments.has(owner.documentId ?? owner.sessionId)) throw new Error('Artifact source closed or deleted')
    identity(owner.operationId, 'operationId'); identity(owner.sessionId, 'sessionId'); identity(owner.callId, 'callId')
    if (owner.documentId !== undefined) identity(owner.documentId, 'documentId')
    if (Buffer.byteLength(owner.operationId) > 128 || typeof current !== 'function' || current() !== true) throw new Error('Artifact source unavailable')
    if (owner.source) identity(owner.source.sourceId, 'sourceId')
    const scope = Object.freeze({ operationId: owner.operationId })
    scopes.set(scope, { owner: structuredClone(owner), current })
    return scope
  }
  function registerResultDependencyScope(owner: ArtifactOwner, current: () => boolean, entries: readonly ResultDependency[]): ResultArtifactScope {
    const frozen = dependencyEntries(entries), scope = registerResultScope(owner, current), registered = scopes.get(scope)!
    registered.dependencies = { owner: registered.owner, current: () => !closed && !deletedDocuments.has(registered.owner.sessionId) && !deletedDocuments.has(registered.owner.documentId ?? registered.owner.sessionId) && registered.current(), entries: frozen, admitted: new Set() }
    return scope
  }
  async function settleResultDependencyMembership(scope: ResultArtifactScope, ref: ManagedArtifactRef) {
    const registered = scopes.get(scope), original = registered?.initialization?.operation
    if (!registered?.dependencies || registered.codec !== 'json-utf8-v1' || original?.phase !== 'committed' || !original.ref || !validManagedArtifactRef(ref) || !sameArtifactRef(original.ref, ref)) return 'recovery-required' as const
    return mutate(() => membership.settle(registered.dependencies!, ref))
  }
  async function beginResult(scope: ResultArtifactScope, codec: ResultCodec): Promise<ResultArtifactSink> {
    const registered = scopes.get(scope)
    if (!registered || closing || closed || deletedDocuments.has(registered.owner.sessionId) || deletedDocuments.has(registered.owner.documentId ?? registered.owner.sessionId) || !registered.current() || !['json-utf8-v1', 'text-utf8-v1', 'exec-frames-v1', 'code-output-manifest-v1'].includes(codec)) throw new Error('Artifact source unavailable')
    if (registered.codec !== undefined && registered.codec !== codec) throw new Error('Artifact codec is immutable')
    registered.codec = codec
    const existing = sinks.get(scope)
    if (existing) return existing
    return mutate(async () => {
      const cached = sinks.get(scope)
      if (cached) return cached
      const id = `ctxv1_${sha(JSON.stringify([options.workspaceId, registered.owner.sessionId, registered.owner.callId, registered.owner.operationId]))}`
      const target = directory(id)
      await requireSpace(root, quota(), 196608)
      await mkdir(managed, { recursive: true })
      // An old operation is reconciled, never opened as a fresh producer.
      let old: ArtifactOperation | undefined
      try { old = await boundedJson(resolve(target, 'operation.json')) as ArtifactOperation }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
      if (!registered.initialization) {
        if (old) throw new Error('Artifact operation already exists; reconcile original operation')
        try { await lstat(target); throw new Error('Artifact initialization belongs to another operation') }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
        registered.initialization = { operation: { version: 1, owner: registered.owner, codec, id, phase: 'capturing', encodedBytes: 0 }, target }
      }
      const { operation } = registered.initialization
      if (old && JSON.stringify(old) !== JSON.stringify(operation)) throw new Error('Original artifact initialization conflict')
      await mkdir(target, { recursive: true })
      await atomicJson(resolve(target, 'operation.json'), operation)
      let sink: OwnedArtifactSink
      sink = await createArtifactWriter({ directory: target, operation, mutate, reserve: growth => requireSpace(root, quota(), growth),
        recoveryAllowed: () => !closing && !closed,
        lifetime: () => deletedDocuments.has(registered.owner.sessionId) || deletedDocuments.has(registered.owner.documentId ?? registered.owner.sessionId) ? 'deleted' : !closed && registered.current() ? 'current' : 'unavailable',
        cancelPublication: async () => { await releaseDocumentPin(root, target, registered.owner.documentId ?? registered.owner.sessionId) },
        closed: () => { writers.delete(sink) } }, true)
      sinks.set(scope, sink)
      sinkMethods.set(sink, ['write','reconcileWrite','finish','refuse'].map(name=>Object.getOwnPropertyDescriptor(sink,name)!))
      writers.add(sink)
      return sink
    })
  }
  async function authorized(access: ContextAccess, ref: ManagedArtifactRef, viaCatalog?: ManagedArtifactRef, verifyOriginalCatalog = false): Promise<ArtifactOperation> {
    identity(access.sessionId, 'sessionId')
    if (closed || deletedDocuments.has(access.sessionId)) throw new Error('Artifact access closed or deleted/unavailable')
    if (!validManagedArtifactRef(ref)) throw new Error('Artifact reference unavailable')
    access.signal?.throwIfAborted()
    const target = directory(ref.id)
    await ownedPath(root, resolve(target, 'operation.json'))
    const operation = await boundedJson(resolve(target, 'operation.json')) as ArtifactOperation
    // Compare only host-committed identity. Supplied ref shape grants nothing.
    if (operation.phase !== 'committed' || !operation.ref || operation.ref.revision !== ref.revision || operation.ref.codec !== ref.codec
      || operation.ref.encodedBytes !== ref.encodedBytes || operation.ref.contentDigest !== ref.contentDigest || operation.ref.completeness !== ref.completeness) throw new Error('Artifact reference stale or unavailable')
    const pin = await readPin(root, target, access.sessionId, ref.revision)
    if (!pin || pin.operationId !== operation.owner.operationId) throw new Error('Artifact reference unavailable or unauthorized')
    const witness = viaCatalog === undefined ? undefined : await membership.witness(access.sessionId, operation, pin, viaCatalog, verifyOriginalCatalog)
    if (witness && (!options.authorizeResult || !await options.authorizeResult(access, { workspaceId: options.workspaceId, owner: witness.owner, ref: witness.ref }))) throw new TransferBlocked('policy', 'Dependency catalog unavailable or unauthorized')
    const visibleVia = witness?.ref
    if ((operation.owner.source || visibleVia) && (!options.authorizeResult || !await options.authorizeResult(access, { workspaceId: options.workspaceId, owner: structuredClone(operation.owner), ref: structuredClone(ref), ...(visibleVia ? { visibleVia } : {}) }))) throw new TransferBlocked('policy', 'Artifact reference unavailable or unauthorized')
    access.signal?.throwIfAborted()
    return operation
  }
  async function readResult(access: ContextAccess, query: { ref: ManagedArtifactRef; offset?: number; maxBytes?: number; viaCatalog?: ManagedArtifactRef }): Promise<ManagedArtifactPage> {
    if(query.ref.codec==='code-output-manifest-v1')throw new Error('Code manifest requires authorized logical reader')
    return mutate(async () => {
      const ref = structuredClone(query.ref), viaCatalog = query.viaCatalog === undefined ? undefined : structuredClone(query.viaCatalog)
      await authorized(access, ref, viaCatalog)
      const page = await readArtifactPage(root, directory(ref.id), ref, query.offset ?? 0, Math.min(query.maxBytes ?? 32768, 32768))
      await authorized(access, ref, viaCatalog)
      return page
    })
  }
  async function protectedCount(): Promise<number> {
    try { return (await readdir(managed)).filter(id => /^ctxv1_[a-f0-9]{64}$/.test(id)).length }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw cause }
  }
  async function readCodeOutputResult(access:ContextAccess,query:{ref:ManagedArtifactRef;cursor?:import('@i-harness/core-session').CodeOutputCursor;maxBytes?:number}) {
    if(!isStrictFactData(query)||Reflect.ownKeys(query).some(key=>!['ref','cursor','maxBytes'].includes(key as string)||!Object.getOwnPropertyDescriptor(query,key)?.enumerable))throw new Error('Invalid Code output read query')
    return mutate(async()=>{
      const captured=structuredClone(query),ref=captured.ref
      const original=await authorized(access,ref)
      const page=await readCodeOutputPage(ref,captured,async(offset,length)=>{
        await authorized(access,ref)
        const bytes=await readVerifiedArtifactBytes(root,directory(ref.id),ref,offset,length)
        await authorized(access,ref)
        return bytes
      })
      if(page.header.sessionId!==original.owner.sessionId||page.header.cellId!==original.owner.callId||page.header.sourceId!==original.owner.operationId)throw new Error('Foreign Code manifest owner binding')
      await authorized(access,ref)
      return page
    })
  }
  async function readExecResult(access: ContextAccess, query: { ref: ManagedArtifactRef; cursor?: import('@i-harness/core-session').ExecFrameCursor; maxBytes?: number; textView?: boolean; viaCatalog?: ManagedArtifactRef }) {
    return mutate(async () => {
      const ref = structuredClone(query.ref), viaCatalog = query.viaCatalog === undefined ? undefined : structuredClone(query.viaCatalog)
      await authorized(access, ref, viaCatalog)
      const page = await readExecFramePage(ref, { ...query, maxBytes: Math.min(query.maxBytes ?? 32768, 32768) }, (offset, length) => readVerifiedArtifactBytes(root, directory(ref.id), ref, offset, length))
      await authorized(access, ref, viaCatalog)
      return page
    })
  }
  async function grantResults(access: ContextAccess, ids: readonly string[], targetSessionId: string) {
    identity(targetSessionId, 'targetSessionId')
    await mutate(async () => {
      for (const id of ids) {
        const target = directory(id), operation = await boundedJson(resolve(target, 'operation.json')) as ArtifactOperation
        if (!operation.ref) throw new Error('Artifact reference unavailable')
        await authorized(access, operation.ref)
        await requireSpace(root, quota(), 262144)
        await publishPin(target, { version: 1, documentId: targetSessionId, sessionId: targetSessionId, operationId: operation.owner.operationId, revision: operation.ref.revision, state: 'pending' })
      }
    })
  }
  async function releaseDocuments(documents: readonly string[]) {
    for (const document of documents) identity(document, 'documentId')
    for (const document of documents) deletedDocuments.add(document)
    await mutate(async () => {
      let names: string[]
      try { names = await readdir(managed) } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause }
      for (const id of names) {
        const target = directory(id)
        for (const document of documents) if (await releaseDocumentPin(root, target, document)) {
          const operation = await boundedJson(resolve(target, 'operation.json')) as ArtifactOperation
          if (operation.phase !== 'committed') continue
          // Checked owned absolute target; never follow an arbitrary payload path.
          if (!resolve(target).startsWith(resolve(managed) + sep)) throw new Error('Artifact deletion target unavailable')
          await ownedPath(root, target)
          await rm(target, { recursive: true, force: true })
          break
        }
      }
    })
  }
  async function confirmResultOwner(scope: ResultArtifactScope, ref: ManagedArtifactRef): Promise<void> {
    const registered = scopes.get(scope)
    if (!registered) throw new Error('Original artifact source scope unavailable')
    if (!validManagedArtifactRef(ref)) throw new Error('Original artifact reference identity unavailable')
    const original = registered.initialization?.operation
    const originalRef = original?.ref
    if (original?.phase !== 'committed' || !originalRef || originalRef.id !== ref.id || originalRef.revision !== ref.revision
      || originalRef.codec !== ref.codec || originalRef.encodedBytes !== ref.encodedBytes || originalRef.contentDigest !== ref.contentDigest || originalRef.completeness !== ref.completeness) throw new Error('Original artifact operation/reference identity unavailable')
    const expectedId = `ctxv1_${sha(JSON.stringify([options.workspaceId, registered.owner.sessionId, registered.owner.callId, registered.owner.operationId]))}`
    if (ref.id !== expectedId || registered.confirmation && registered.confirmation.ref.revision !== ref.revision) throw new Error('Original artifact reference identity conflict')
    registered.confirmation ??= { ref: structuredClone(ref), admitted: false }
    const current = () => !closed && !deletedDocuments.has(registered.owner.sessionId) && !deletedDocuments.has(registered.owner.documentId ?? registered.owner.sessionId) && registered.current()
    confirming.set(scope,(confirming.get(scope)??0)+1);confirmed.delete(scope)
    try{
      await mutate(() => confirmArtifactOwner(root, directory(expectedId), registered.owner, registered.confirmation!, quota(), current))
      if (!current()) throw new Error('Original artifact source unavailable after confirmation')
      if(confirming.get(scope)===1)confirmed.set(scope, structuredClone(originalRef))
    }finally{confirming.set(scope,(confirming.get(scope)??1)-1)}
  }
  function assertOriginalManifestScope(scope: ResultArtifactScope) {
    const registered=scopes.get(scope)
    const check=()=>{if(!registered||scopes.get(scope)!==registered||closing||closed||deletedDocuments.has(registered.owner.sessionId)||deletedDocuments.has(registered.owner.documentId??registered.owner.sessionId))throw new Error('Original manifest scope unavailable')}
    check(); const current=registered!.current(); check(); if(current!==true)throw new Error('Original manifest scope unavailable')
  }
  function captureConfirmedCodeManifest(scope: ResultArtifactScope, sink: ResultArtifactSink, expected: {operationId:string;sessionId:string;callId:string;source:{sourceId:string};ref:ManagedArtifactRef}) {
    const registered = scopes.get(scope)
    if (!registered || sinks.get(scope) !== sink) throw new Error('Original scope and sink required')
    const methods = sinkMethods.get(sink)
    const assertOriginal=()=>{
      if(scopes.get(scope)!==registered||sinks.get(scope)!==sink||!methods)throw new Error('Original scope and sink required')
      for(const [i,name] of ['write','reconcileWrite','finish','refuse'].entries()){
        const field=Object.getOwnPropertyDescriptor(sink,name),original=methods[i]!
        if(!field||!('value'in field)||field.value!==original.value||field.enumerable!==original.enumerable||field.configurable!==original.configurable||field.writable!==original.writable)throw new Error('Original sink methods required')
      }
      if(closing||closed||deletedDocuments.has(registered.owner.sessionId)||deletedDocuments.has(registered.owner.documentId??registered.owner.sessionId))throw new Error('Original manifest lifetime unavailable')
    }
    const assertCurrent=()=>{assertOriginal();const held=registered.current();assertOriginal();if(held!==true)throw new Error('Original manifest lifetime unavailable')}
    assertCurrent()
    const ref = confirmed.get(scope), operation = registered.initialization?.operation
    if (!ref || confirming.get(scope) || registered.codec !== 'code-output-manifest-v1' || operation?.phase !== 'committed' || !operation.ref) throw new Error('Original confirmed manifest unavailable')
    if (!isStrictFactData(expected) || !validManagedArtifactRef(expected.ref) || !sameArtifactRef(ref,expected.ref) || !sameArtifactRef(ref,operation.ref) || expected.operationId!==registered.owner.operationId || expected.sessionId!==registered.owner.sessionId || expected.callId!==registered.owner.callId || expected.source?.sourceId!==registered.owner.source?.sourceId || !registered.owner.source) throw new Error('Original manifest identity mismatch')
    assertCurrent()
    return Object.freeze({operationId:registered.owner.operationId,sessionId:registered.owner.sessionId,callId:registered.owner.callId,source:Object.freeze({...registered.owner.source}),ref:Object.freeze({...ref})})
  }
  const transfers = createSeedDependencyTransfer({ root, options, directory, quota, mutate, membership, authorized, available: document => !closed && !deletedDocuments.has(document) })
  return { ...transfers, assertOriginalManifestScope, captureConfirmedCodeManifest, passiveReleaseInventory(turn: import('../workspace-mutation.ts').WorkspaceMutationTurn, documents: readonly string[], io: import('./qualification-io.ts').ArtifactQualificationIO) { mutations.assertTurn(turn); return passiveManagedReleaseInventory(root, options.workspaceId, documents, io, () => mutations.assertTurn(turn)) }, registerResultScope, registerResultDependencyScope, settleResultDependencyMembership, beginResult, readResult, readExecResult, readCodeOutputResult, confirmResultOwner, mutate, protectedCount, grantResults, releaseDocuments,
    checkQuota: () => mutate(() => requireSpace(root, quota(), 0)),
    reconcileResult: (operationId: string, id: string) => mutate(async () => {
      if (closed) throw new Error('Artifact owner closed')
      return reconcileArtifact(root, directory(id), options.workspaceId, operationId, id)
    }),
    close: async () => {
      // Fence new turns immediately, while already issued callbacks retain
      // their original lifecycle until the shared queue drains.
      closing = true
      transfers.closeTransferAdmission()
      await mutations.join()
      closed = true
      const failures: unknown[] = []
      try { await transfers.closeTransfers() } catch (failure) { failures.push(failure) }
      for (const writer of [...writers]) {
        try { await writer.suspend(); writers.delete(writer) } catch (failure) { failures.push(failure) }
      }
      failuresTogether(failures, 'Original artifact writers failed to close')
    },
  }
}
