import { resolve } from 'node:path'
import { atomicJson, boundedJson, ownedPath } from './io.ts'
import { sha, validateManifest } from './manifest.ts'
import { publishPin } from './pins.ts'
import { dimensions } from './index.ts'
import { identity } from '../config.ts'
import { validManagedArtifactRef } from '@i-harness/core-session'
import type { ArtifactOperation, ArtifactSettlement } from './types.ts'

/** Publish immutable content metadata and conservative document pin before ref. */
export function createArtifactPublication(directory: string, operation: ArtifactOperation, assertCurrent: () => void) {
  let step = 0, pending: (() => Promise<void>) | undefined
  return async (): Promise<ArtifactSettlement> => {
    if (!operation.ref || !operation.manifest) return { kind: 'recovery-required', operationId: operation.owner.operationId }
    validateManifest(operation.manifest, operation.ref)
    // A failed original metadata transaction is resumed before consulting a
    // later lifetime change. No new step may pass that uncertainty.
    while (step < 3) {
      if (!pending) {
        assertCurrent()
        if (step === 0) pending = () => atomicJson(resolve(directory, 'manifest.json'), operation.manifest)
        else if (step === 1) pending = () => publishPin(directory, { version: 1, documentId: operation.owner.documentId ?? operation.owner.sessionId, sessionId: operation.owner.sessionId, state: 'pending', operationId: operation.owner.operationId, revision: operation.ref!.revision })
        else {
          const committed = { ...operation, phase: 'committed' as const }
          pending = () => atomicJson(resolve(directory, 'operation.json'), committed)
        }
      }
      await pending()
      pending = undefined; step++
    }
    operation.phase = 'committed'
    return { kind: 'committed', ref: structuredClone(operation.ref) }
  }
}
/** Cold storage evidence only. Never resumes a producer or the live publication cursor. */
export async function reconcileArtifact(root: string, directory: string, workspaceId: string, operationId: string, id: string): Promise<ArtifactSettlement> {
  identity(operationId, 'operationId')
  if (Buffer.byteLength(operationId) > 128) throw new Error('Artifact operation mismatch')
  const path = resolve(directory, 'operation.json')
  await ownedPath(root, path)
  // The disposition and ref come from this checked snapshot, not a second read.
  const operation = await boundedJson(path) as ArtifactOperation
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) || operation.version !== 1
    || !operation.owner || typeof operation.owner !== 'object' || Array.isArray(operation.owner)
    || operation.id !== id || !['capturing', 'staged', 'committed', 'refused'].includes(operation.phase)
    || !['text-utf8-v1', 'json-utf8-v1', 'exec-frames-v1'].includes(operation.codec)
    || !Number.isSafeInteger(operation.encodedBytes) || operation.encodedBytes < 0) throw new Error('Artifact operation corrupt')
  const owner = operation.owner
  for (const key of ['operationId', 'sessionId', 'callId'] as const) identity(owner[key], key)
  if (owner.documentId !== undefined) identity(owner.documentId, 'documentId')
  if (owner.source !== undefined) {
    if (!owner.source || typeof owner.source !== 'object' || Array.isArray(owner.source)) throw new Error('Artifact operation source corrupt')
    identity(owner.source.sourceId, 'sourceId')
    if (owner.source.path !== undefined && typeof owner.source.path !== 'string' || owner.source.revision !== undefined && typeof owner.source.revision !== 'string'
      || owner.source.readonly !== undefined && typeof owner.source.readonly !== 'boolean') throw new Error('Artifact operation source corrupt')
  }
  const expectedId = `ctxv1_${sha(JSON.stringify([workspaceId, owner.sessionId, owner.callId, owner.operationId]))}`
  if (owner.operationId !== operationId || expectedId !== id) throw new Error('Artifact operation mismatch')
  if (operation.phase === 'refused') {
    if (!operation.reason || !['quota', 'encoding', 'storage-refused', 'capture-canceled'].includes(operation.reason)) throw new Error('Artifact refusal corrupt')
    return { kind: 'refused', reason: operation.reason, observedEncodedBytes: operation.encodedBytes }
  }
  // A cold committed receipt is evidence, not permission to recreate a pin
  // that a later confirmed document deletion removed.
  if (operation.phase === 'committed') {
    const ref = operation.ref
    if (!validManagedArtifactRef(ref) || ref.id !== id || ref.codec !== operation.codec || ref.encodedBytes !== operation.encodedBytes || !operation.manifest) throw new Error('Artifact commitment corrupt')
    const shape = dimensions(ref.encodedBytes), embedded = validateManifest(operation.manifest, ref)
    const manifestPath = resolve(directory, 'manifest.json')
    await ownedPath(root, manifestPath)
    const manifest = validateManifest(await boundedJson(manifestPath, 4096), ref)
    if (embedded.leaves !== shape.leaves || embedded.paddedLeaves !== shape.paddedLeaves
      || manifest.leaves !== shape.leaves || manifest.paddedLeaves !== shape.paddedLeaves) throw new Error('Artifact manifest corrupt')
    return { kind: 'committed', ref: structuredClone(ref) }
  }
  return { kind: 'recovery-required', operationId: operation.owner.operationId }
}
