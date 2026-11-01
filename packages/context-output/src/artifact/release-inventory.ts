import { readdir, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonicalJsonData, validManagedArtifactRef } from '@i-harness/core-session'
import { boundedJson, ownedPath } from './io.ts'
import { sha, validateManifest } from './manifest.ts'
import { validOwner, validTransferBinding } from './transfer-codec.ts'
import { validMembership, validTransferMembership, sameArtifactRef } from './dependency-membership.ts'
import { physicalIdentity } from './quota.ts'
import type { ArtifactPin } from './pins.ts'
import type { ArtifactOperation } from './types.ts'
import type { ArtifactQualificationIO } from './qualification-io.ts'

export interface ManagedReleaseInventory {
  readonly identity: string
  readonly targets: readonly string[]
  readonly recoveryRequired: boolean
}
const inventories = new WeakMap<ManagedReleaseInventory, readonly unknown[]>()
const absent = (failure: unknown) => (failure as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT'
/** Metadata only. Descriptors outlive pin removal; this function never performs it. */
export async function passiveManagedReleaseInventory(root: string, workspaceId: string, documents: readonly string[], io: ArtifactQualificationIO, check: () => void): Promise<ManagedReleaseInventory> {
  const base = resolve(root, 'managed-v1'), targets = new Set<string>(), witness: unknown[] = [], requested = new Set(documents)
  let recoveryRequired = false
  async function names(path: string): Promise<string[]> {
    check()
    try { await ownedPath(root, path); const info = await lstat(path); check(); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Managed authority directory unavailable'); witness.push([path, physicalIdentity(info)]); return await readdir(path) }
    catch (failure) { if (absent(failure)) { witness.push([path, 'absent']); return [] }; throw failure }
  }
  async function read(path: string): Promise<unknown> {
    check(); await ownedPath(root, path); const value = await boundedJson(path, 65536, undefined, io), info = await lstat(path); check()
    if (!info.isFile() || info.isSymbolicLink() || !physicalIdentity(info)) throw Error('Managed authority identity unavailable')
    witness.push([path, physicalIdentity(info), value]); return value
  }
  const objects = (await names(base)).sort()
  for (const id of objects) {
    if (!/^ctxv1_[a-f0-9]{64}$/.test(id)) throw Error('Managed authority object unavailable')
    const directory = resolve(base, id), children = (await names(directory)).sort()
    for (const child of children) {
      if (/^(?:operation|manifest)\.json\.[a-f0-9]{64}\.pending$/.test(child)) recoveryRequired = true
      else if (!['operation.json', 'manifest.json', 'body', 'index', 'leaves', 'pins', 'access', 'pin-memberships'].includes(child)) throw Error('Unknown managed authority namespace')
    }
    witness.push([id, children])
    const operation = await read(resolve(directory, 'operation.json')) as ArtifactOperation
    if (operation.version !== 1 || operation.id !== id || !validOwner(operation.owner)) throw Error('Managed original operation unavailable')
    if (id !== `ctxv1_${sha(JSON.stringify([workspaceId, operation.owner.sessionId, operation.owner.callId, operation.owner.operationId]))}`) throw Error('Managed operation identity conflict')
    if (operation.phase !== 'committed') recoveryRequired = true
    else {
      if (!validManagedArtifactRef(operation.ref) || !operation.manifest) throw Error('Managed original manifest unavailable')
      validateManifest(operation.manifest, operation.ref)
      validateManifest(await read(resolve(directory, 'manifest.json')), operation.ref)
      if (children.includes('leaves')) recoveryRequired = true
    }
    const pins = new Map<string, ArtifactPin>()
    for (const name of (await names(resolve(directory, 'pins'))).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw Error('Managed pin namespace unavailable')
      const pin = await read(resolve(directory, 'pins', name)) as ArtifactPin
      if (pin.version !== 1 || typeof pin.documentId !== 'string' || !pin.documentId || typeof pin.sessionId !== 'string' || !pin.sessionId
        || sha(pin.documentId) + '.json' !== name || !['pending', 'committed'].includes(pin.state) || pin.operationId !== operation.owner.operationId
        || pin.revision !== operation.ref?.revision || (pin.seedTransfer !== undefined && (pin.state !== 'committed' || !validTransferBinding(pin.seedTransfer) || pin.seedTransfer.targetDocumentId !== pin.documentId || pin.seedTransfer.targetSessionId !== pin.sessionId))) throw Error('Managed pin identity unavailable')
      pins.set(name.slice(0, -5), pin)
      if (requested.has(pin.documentId)) targets.add(pin.sessionId)
    }
    const accessPins = new Set<string>()
    for (const name of (await names(resolve(directory, 'access'))).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw Error('Managed access namespace unavailable')
      const access = await read(resolve(directory, 'access', name)) as { version: number; sessionId: string; revision: string; pinId: string }, pin = pins.get(access.pinId)
      if (access.version !== 1 || !pin || access.sessionId !== pin.sessionId || access.revision !== pin.revision || sha(access.sessionId) + '.json' !== name) throw Error('Managed access identity unavailable')
      accessPins.add(pin.sessionId)
    }
    if ([...pins.values()].some(pin => !accessPins.has(pin.sessionId))) recoveryRequired = true
    for (const documentHash of (await names(resolve(directory, 'pin-memberships'))).sort()) {
      if (!/^[a-f0-9]{64}$/.test(documentHash)) throw Error('Managed companion namespace unavailable')
      for (const name of (await names(resolve(directory, 'pin-memberships', documentHash))).sort()) {
        const member = await read(resolve(directory, 'pin-memberships', documentHash, name))
        if (!validMembership(member) && !validTransferMembership(member)) throw Error('Managed dependency membership unavailable')
        if (member.workspaceId !== workspaceId || member.memberRef.id !== id || !operation.ref || !sameArtifactRef(member.memberRef, operation.ref) || sha(member.documentId) !== documentHash
          || sha(JSON.stringify([member.catalogRef.id, member.catalogRef.revision])) + '.json' !== name) throw Error('Managed companion identity conflict')
        const catalog = await read(resolve(base, member.catalogRef.id, 'operation.json')) as ArtifactOperation
        if (catalog.phase !== 'committed' || catalog.id !== member.catalogRef.id || !validOwner(catalog.owner) || catalog.owner.operationId !== member.catalogOperationId || !catalog.ref || !sameArtifactRef(catalog.ref, member.catalogRef) || !catalog.manifest) throw Error('Managed companion catalog unavailable')
        validateManifest(catalog.manifest, member.catalogRef)
        if (member.version === 2 && (member.memberOperationId !== operation.owner.operationId || canonicalJsonData(member.catalogOwner) !== canonicalJsonData(catalog.owner))) throw Error('Managed transfer original operation conflict')
        if (!pins.has(documentHash)) recoveryRequired = true
        else if (pins.get(documentHash)!.sessionId !== member.sessionId) throw Error('Managed companion pin session conflict')
        if (requested.has(member.documentId)) targets.add(member.sessionId)
      }
    }
    // Exact metadata plus original survivor enumeration is retained for later effects.
    witness.push([id, [...pins], [...pins].filter(([, pin]) => !requested.has(pin.documentId)), pins.size > 0 && [...pins.values()].every(pin => requested.has(pin.documentId))])
  }
  check(); io.assertSettled()
  const inventory = Object.freeze({ identity: sha(canonicalJsonData(witness)), targets: Object.freeze([...targets].sort()), recoveryRequired })
  inventories.set(inventory, witness)
  return inventory
}
