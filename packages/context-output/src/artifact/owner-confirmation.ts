import { resolve } from 'node:path'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import { boundedJson, ownedPath } from './io.ts'
import { validateManifest } from './manifest.ts'
import { publishPin, readPin } from './pins.ts'
import { requireSpace } from './quota.ts'
import type { ArtifactOperation, ArtifactOwner } from './types.ts'

export interface OwnerConfirmation { ref: ManagedArtifactRef; admitted: boolean }

/** Same original operation, fixed original session document, no read grant. */
export async function confirmArtifactOwner(root: string, directory: string, owner: ArtifactOwner, pending: OwnerConfirmation, quota: number, current: () => boolean): Promise<void> {
  const assertHeld = () => { if (!current()) throw new Error('Original artifact source closed or deleted') }
  assertHeld()
  await ownedPath(root, resolve(directory, 'operation.json'))
  const operation = await boundedJson(resolve(directory, 'operation.json')) as ArtifactOperation, ref = pending.ref
  if (operation.phase !== 'committed' || operation.id !== ref.id || JSON.stringify(operation.owner) !== JSON.stringify(owner) || !operation.ref || !operation.manifest
    || operation.ref.revision !== ref.revision || operation.ref.codec !== ref.codec || operation.ref.contentDigest !== ref.contentDigest
    || operation.ref.encodedBytes !== ref.encodedBytes || operation.ref.completeness !== ref.completeness) throw new Error('Original artifact operation/reference identity conflict')
  validateManifest(operation.manifest, ref)
  assertHeld()
  const existing = await readPin(root, directory, owner.sessionId, ref.revision)
  assertHeld()
  if (existing?.documentId === owner.sessionId && existing.operationId === owner.operationId) return
  if ((owner.documentId ?? owner.sessionId) === owner.sessionId) throw new Error('Original artifact owner pin unavailable')
  if (!pending.admitted) { await requireSpace(root, quota, 262144); assertHeld(); pending.admitted = true }
  await publishPin(directory, { version: 1, documentId: owner.sessionId, sessionId: owner.sessionId, state: 'pending', operationId: owner.operationId, revision: ref.revision })
  assertHeld()
  const confirmed = await readPin(root, directory, owner.sessionId, ref.revision)
  assertHeld()
  if (confirmed?.documentId !== owner.sessionId || confirmed.operationId !== owner.operationId) throw new Error('Original artifact owner confirmation requires recovery')
}
