import { resolve } from 'node:path'
import { atomicJson, boundedJson } from './io.ts'
import { validateManifest } from './manifest.ts'
import { publishPin } from './pins.ts'
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
export async function reconcileArtifact(directory: string): Promise<ArtifactSettlement> {
  const operation = await boundedJson(resolve(directory, 'operation.json')) as ArtifactOperation
  if (operation.phase === 'refused' && operation.reason) return { kind: 'refused', reason: operation.reason, observedEncodedBytes: operation.encodedBytes }
  if (operation.phase !== 'staged' && operation.phase !== 'committed') return { kind: 'recovery-required', operationId: operation.owner.operationId }
  // A cold committed receipt is evidence, not permission to recreate a pin
  // that a later confirmed document deletion removed.
  if (operation.phase === 'committed' && operation.ref) return { kind: 'committed', ref: structuredClone(operation.ref) }
  return { kind: 'recovery-required', operationId: operation.owner.operationId }
}
