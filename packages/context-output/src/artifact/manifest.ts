import { createHash } from 'node:crypto'
import type { ArtifactManifest } from './types.ts'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import { validManagedArtifactRef } from '@i-harness/core-session'

export const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export function manifestBytes(manifest: ArtifactManifest): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, codec: manifest.codec, encodedBytes: manifest.encodedBytes, contentDigest: manifest.contentDigest,
    completeness: manifest.completeness, chunkBytes: 65536, leaves: manifest.leaves, paddedLeaves: manifest.paddedLeaves, treeRoot: manifest.treeRoot }))
}
export function artifactRef(id: string, manifest: ArtifactManifest): ManagedArtifactRef {
  return { version: 1, id, revision: sha(manifestBytes(manifest)), codec: manifest.codec, encodedBytes: manifest.encodedBytes, contentDigest: manifest.contentDigest, completeness: manifest.completeness }
}
export function validateManifest(value: unknown, ref: ManagedArtifactRef): ArtifactManifest {
  if (!validManagedArtifactRef(ref) || !value || typeof value !== 'object') throw new Error('Artifact reference unavailable')
  const manifest = value as ArtifactManifest
  const expected = artifactRef(ref.id, manifest)
  if (Object.keys(manifest).join(',') !== 'version,codec,encodedBytes,contentDigest,completeness,chunkBytes,leaves,paddedLeaves,treeRoot'
    || manifest.version !== 1 || manifest.chunkBytes !== 65536 || !/^[a-f0-9]{64}$/.test(manifest.treeRoot)
    || manifestBytes(manifest).length > 4096 || expected.revision !== ref.revision || expected.codec !== ref.codec || expected.encodedBytes !== ref.encodedBytes
    || expected.contentDigest !== ref.contentDigest || expected.completeness !== ref.completeness) throw new Error('Artifact manifest corrupt or stale')
  return manifest
}
