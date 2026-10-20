import { mkdir, readdir, rm, lstat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { acquireSessionLock, lockPathFor } from '@i-harness/fs-lock'
import { validManagedArtifactRef, type ManagedArtifactRef, type ResultCodec, type ResultDependency } from '@i-harness/core-session'
import { identity } from '../config.ts'
import type { ContextAccess, ContextOutputOptions } from '../types.ts'
import type { ArtifactOperation, ArtifactOwner, ManagedArtifactPage, ResultArtifactScope, ResultArtifactSink } from './types.ts'
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

export function createArtifactOwnership(options: ContextOutputOptions, quota: () => number) {
  const root = resolve(options.root, 'context-output', sha(options.workspaceId)), managed = resolve(root, 'managed-v1')
  const scopes = new WeakMap<ResultArtifactScope, { owner: ArtifactOwner; current: () => boolean; codec?: ResultCodec; initialization?: { operation: ArtifactOperation; target: string }; confirmation?: OwnerConfirmation; dependencies?: DependencyRegistration }>()
  const deletedDocuments = new Set<string>()
  let closed = false
  const sinks = new WeakMap<ResultArtifactScope, ResultArtifactSink>()
  const writers = new Set<OwnedArtifactSink>()
  let serial: Promise<unknown> = Promise.resolve()
  const directory = (id: string) => { if (!/^ctxv1_[a-f0-9]{64}$/.test(id)) throw new Error('Artifact reference unavailable'); return resolve(managed, id) }
  const membership = createDependencyMembership(root, options.workspaceId, directory, quota)
  const mutate = <T>(work: () => Promise<T>): Promise<T> => {
    const next = serial.then(async () => {
      const lease = await acquireSessionLock({ lockPath: lockPathFor(options.root, `context-output:${options.workspaceId}`) })
      try { return await work() } finally { await lease.release() }
    })
    serial = next.catch(() => {}); return next
  }
  function registerResultScope(owner: ArtifactOwner, current: () => boolean): ResultArtifactScope {
    if (closed || deletedDocuments.has(owner.sessionId) || deletedDocuments.has(owner.documentId ?? owner.sessionId)) throw new Error('Artifact source closed or deleted')
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
    if (!registered || closed || deletedDocuments.has(registered.owner.sessionId) || deletedDocuments.has(registered.owner.documentId ?? registered.owner.sessionId) || !registered.current() || !['json-utf8-v1', 'text-utf8-v1', 'exec-frames-v1'].includes(codec)) throw new Error('Artifact source unavailable')
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
        lifetime: () => deletedDocuments.has(registered.owner.sessionId) || deletedDocuments.has(registered.owner.documentId ?? registered.owner.sessionId) ? 'deleted' : !closed && registered.current() ? 'current' : 'unavailable',
        cancelPublication: async () => { await releaseDocumentPin(root, target, registered.owner.documentId ?? registered.owner.sessionId) },
        closed: () => { writers.delete(sink) } }, true)
      sinks.set(scope, sink)
      writers.add(sink)
      return sink
    })
  }
  async function authorized(access: ContextAccess, ref: ManagedArtifactRef, viaCatalog?: ManagedArtifactRef): Promise<ArtifactOperation> {
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
    if (!pin) throw new Error('Artifact reference unavailable or unauthorized')
    const witness = viaCatalog === undefined ? undefined : await membership.witness(access.sessionId, operation, pin, viaCatalog)
    if (witness && (!options.authorizeResult || !await options.authorizeResult(access, { workspaceId: options.workspaceId, owner: witness.owner, ref: witness.ref }))) throw new Error('Dependency catalog unavailable or unauthorized')
    const visibleVia = witness?.ref
    if ((operation.owner.source || visibleVia) && (!options.authorizeResult || !await options.authorizeResult(access, { workspaceId: options.workspaceId, owner: structuredClone(operation.owner), ref: structuredClone(ref), ...(visibleVia ? { visibleVia } : {}) }))) throw new Error('Artifact reference unavailable or unauthorized')
    access.signal?.throwIfAborted()
    return operation
  }
  async function readResult(access: ContextAccess, query: { ref: ManagedArtifactRef; offset?: number; maxBytes?: number; viaCatalog?: ManagedArtifactRef }): Promise<ManagedArtifactPage> {
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
    await mutate(() => confirmArtifactOwner(root, directory(expectedId), registered.owner, registered.confirmation!, quota(), current))
  }
  return { registerResultScope, registerResultDependencyScope, settleResultDependencyMembership, beginResult, readResult, readExecResult, confirmResultOwner, mutate, protectedCount, grantResults, releaseDocuments,
    checkQuota: () => mutate(() => requireSpace(root, quota(), 0)),
    reconcileResult: (operationId: string, id: string) => mutate(async () => {
      if (closed) throw new Error('Artifact owner closed')
      const target = directory(id), operation = await boundedJson(resolve(target, 'operation.json')) as ArtifactOperation
      if (operation.owner.operationId !== operationId) throw new Error('Artifact operation mismatch')
      return reconcileArtifact(target)
    }),
    close: async () => { closed = true; await serial; for (const writer of writers) await writer.suspend(); writers.clear() },
  }
}
