import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isStrictFactData, validManagedArtifactRef, type ManagedArtifactRef, type ResultDependency } from '@i-harness/core-session'
import { identity } from '../config.ts'
import { atomicJson, boundedJson, ownedPath } from './io.ts'
import { sha, validateManifest } from './manifest.ts'
import { readPin, type ArtifactPin } from './pins.ts'
import { requireSpace } from './quota.ts'
import type { ArtifactOperation, ArtifactOwner } from './types.ts'

export type MembershipSettlement = 'ready' | 'quota' | 'recovery-required'
export interface DependencyRegistration {
  owner: ArtifactOwner; current(): boolean; entries: readonly ResultDependency[]
  disposition?: MembershipSettlement; admitted: Set<number>
}
interface Membership {
  version: 1; kind: 'result-dependency'; workspaceId: string; documentId: string; sessionId: string
  memberRef: ManagedArtifactRef; catalogRef: ManagedArtifactRef; catalogOperationId: string; sourceId: string; ordinal: number
}
const keys = ['version', 'kind', 'workspaceId', 'documentId', 'sessionId', 'memberRef', 'catalogRef', 'catalogOperationId', 'sourceId', 'ordinal']
export function sameArtifactRef(a: ManagedArtifactRef, b: ManagedArtifactRef): boolean {
  return a.id === b.id && a.revision === b.revision && a.codec === b.codec && a.encodedBytes === b.encodedBytes && a.contentDigest === b.contentDigest && a.completeness === b.completeness && a.version === b.version
}
export function dependencyEntries(entries: readonly ResultDependency[]): readonly ResultDependency[] {
  if (!Array.isArray(entries) || !isStrictFactData(entries) || !entries.length) throw new Error('Original dependency entries unavailable')
  const ids = new Set<string>()
  for (const entry of entries) {
    identity(entry.sourceId, 'sourceId')
    if (ids.has(entry.sourceId) || entry.kind !== 'exec-frames' || Object.keys(entry).some(key => !['kind', 'sourceId', 'retention'].includes(key))) throw new Error('Original dependency entries conflict')
    ids.add(entry.sourceId)
    const retention = entry.retention
    if (retention.kind === 'artifact') {
      if (Object.keys(retention).some(key => !['kind', 'ref'].includes(key)) || !validManagedArtifactRef(retention.ref) || retention.ref.codec !== 'exec-frames-v1') throw new Error('Original dependency reference unavailable')
    } else if (retention.kind !== 'unavailable' || Object.keys(retention).some(key => !['kind', 'reason', 'observedEncodedBytes'].includes(key)) || !['quota', 'encoding', 'storage-refused', 'unsupported-owner', 'capture-canceled'].includes(retention.reason)
      || retention.observedEncodedBytes !== undefined && (!Number.isSafeInteger(retention.observedEncodedBytes) || retention.observedEncodedBytes < 0)) throw new Error('Original dependency refusal unavailable')
  }
  const frozen = structuredClone(entries)
  for (const entry of frozen) { if (entry.retention.kind === 'artifact') Object.freeze(entry.retention.ref); Object.freeze(entry.retention); Object.freeze(entry) }
  return Object.freeze(frozen)
}
function validMembership(value: unknown): value is Membership {
  if (!isStrictFactData(value) || !value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Membership
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key)) || record.version !== 1 || record.kind !== 'result-dependency'
    || !validManagedArtifactRef(record.memberRef) || record.memberRef.codec !== 'exec-frames-v1' || !validManagedArtifactRef(record.catalogRef) || record.catalogRef.codec !== 'json-utf8-v1'
    || record.memberRef.id === record.catalogRef.id || !Number.isSafeInteger(record.ordinal) || record.ordinal < 0) return false
  try { for (const key of ['workspaceId', 'documentId', 'sessionId', 'catalogOperationId', 'sourceId'] as const) identity(record[key], key) } catch { return false }
  return Buffer.byteLength(JSON.stringify(record)) <= 8192
}

/** All methods run only inside the original workspace mutation fence. The
 * private scope supplies semantics; these companions never grant a pin. */
export function createDependencyMembership(root: string, workspaceId: string, directory: (id: string) => string, quota: () => number) {
  const companion = (member: ManagedArtifactRef, documentId: string, catalog: ManagedArtifactRef) => resolve(directory(member.id), 'pin-memberships', sha(documentId), sha(JSON.stringify([catalog.id, catalog.revision])) + '.json')
  async function operation(ref: ManagedArtifactRef): Promise<ArtifactOperation> {
    if (!validManagedArtifactRef(ref)) throw new Error('Dependency reference unavailable')
    const path = resolve(directory(ref.id), 'operation.json')
    await ownedPath(root, path)
    const value = await boundedJson(path) as ArtifactOperation
    if (value.phase !== 'committed' || value.id !== ref.id || !value.ref || !sameArtifactRef(value.ref, ref) || !value.manifest) throw new Error('Dependency operation stale or unavailable')
    validateManifest(value.manifest, ref)
    return value
  }
  function pinMatches(pin: ArtifactPin | undefined, owner: ArtifactOwner, ref: ManagedArtifactRef, documentId: string, sessionId: string): pin is ArtifactPin {
    return !!pin && pin.documentId === documentId && pin.sessionId === sessionId && pin.revision === ref.revision && pin.operationId === owner.operationId
  }
  async function load(path: string): Promise<Membership | undefined> {
    try { await ownedPath(root, path); const value = await boundedJson(path, 8192); if (!validMembership(value)) throw new Error('Dependency membership corrupt'); return value }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause }
  }
  async function settle(registration: DependencyRegistration, catalogRef: ManagedArtifactRef): Promise<MembershipSettlement> {
    const assertCurrent = () => { if (!registration.current()) throw new Error('Original dependency catalog source unavailable') }
    try {
      assertCurrent()
      if (registration.disposition === 'ready' || registration.disposition === 'quota') return registration.disposition
      if (catalogRef.codec !== 'json-utf8-v1') throw new Error('Original catalog codec unavailable')
      const catalog = await operation(catalogRef), owner = registration.owner, documentId = owner.documentId ?? owner.sessionId
      if (JSON.stringify(catalog.owner) !== JSON.stringify(owner) || !pinMatches(await readPin(root, directory(catalogRef.id), owner.sessionId, catalogRef.revision), catalog.owner, catalogRef, documentId, owner.sessionId)) throw new Error('Original dependency catalog pin unavailable')
      for (const [ordinal, entry] of registration.entries.entries()) {
        if (entry.retention.kind !== 'artifact') continue
        assertCurrent()
        const memberRef = entry.retention.ref, member = await operation(memberRef)
        if (!pinMatches(await readPin(root, directory(memberRef.id), owner.sessionId, memberRef.revision), member.owner, memberRef, documentId, owner.sessionId)) throw new Error('Original dependency member pin unavailable')
        const record: Membership = { version: 1, kind: 'result-dependency', workspaceId, documentId, sessionId: owner.sessionId, memberRef, catalogRef, catalogOperationId: owner.operationId, sourceId: entry.sourceId, ordinal }
        if (!validMembership(record)) throw new Error('Original dependency membership unavailable')
        const path = companion(memberRef, documentId, catalogRef), existing = await load(path)
        if (existing) { if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Immutable dependency membership conflict'); continue }
        if (!registration.admitted.has(ordinal)) { await requireSpace(root, quota(), Buffer.byteLength(JSON.stringify(record)) + 131072); registration.admitted.add(ordinal) }
        for (const pathPart of [resolve(directory(memberRef.id), 'pin-memberships'), resolve(directory(memberRef.id), 'pin-memberships', sha(documentId))]) {
          try { await mkdir(pathPart) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
          await ownedPath(root, pathPart)
        }
        assertCurrent()
        // atomicJson may resume its exact pending transaction, but must never
        // overwrite foreign bytes at the immutable published key.
        const temporary = path + '.' + sha(Buffer.from(JSON.stringify(record))) + '.pending'
        try { await ownedPath(root, temporary) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
        await atomicJson(path, record)
        assertCurrent()
        if (JSON.stringify(await load(path)) !== JSON.stringify(record)) throw new Error('Original dependency membership acknowledgement unavailable')
      }
      assertCurrent(); return registration.disposition = 'ready'
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ARTIFACT_QUOTA') return registration.disposition = 'quota'
      return 'recovery-required'
    }
  }
  async function witness(sessionId: string, member: ArtifactOperation, memberPin: ArtifactPin, viaCatalog: ManagedArtifactRef): Promise<{ owner: ArtifactOwner; ref: ManagedArtifactRef }> {
    const ref = member.ref!
    if (ref.codec !== 'exec-frames-v1' || !validManagedArtifactRef(viaCatalog) || viaCatalog.codec !== 'json-utf8-v1' || ref.id === viaCatalog.id
      || memberPin.operationId !== member.owner.operationId || memberPin.sessionId !== sessionId || memberPin.revision !== ref.revision) throw new Error('Dependency witness unavailable or unauthorized')
    const record = await load(companion(ref, memberPin.documentId, viaCatalog))
    if (!record || record.workspaceId !== workspaceId || record.documentId !== memberPin.documentId || record.sessionId !== sessionId || !sameArtifactRef(record.memberRef, ref) || !sameArtifactRef(record.catalogRef, viaCatalog)) throw new Error('Dependency membership unavailable or unauthorized')
    const catalog = await operation(viaCatalog)
    if (catalog.owner.operationId !== record.catalogOperationId || catalog.owner.sessionId !== sessionId || (catalog.owner.documentId ?? sessionId) !== record.documentId
      || !pinMatches(await readPin(root, directory(viaCatalog.id), sessionId, viaCatalog.revision), catalog.owner, viaCatalog, record.documentId, sessionId)) throw new Error('Dependency catalog pin unavailable or unauthorized')
    return { owner: structuredClone(catalog.owner), ref: structuredClone(viaCatalog) }
  }
  return { settle, witness }
}
