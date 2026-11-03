import { canonicalJsonData, type ManagedArtifactRef, type ResultDependency, type SeedArtifact } from '@i-harness/core-session'
import { sha } from './manifest.ts'
import type { ArtifactOwner } from './types.ts'
import type { SeedDependencyTransferBinding } from './transfer-codec.ts'

const hash = (part: string, value: unknown) => sha(`ih.bootstrap.dependencies.closure.${part}.v1\0` + canonicalJsonData(value))
export const canonicalCompare = (a: unknown, b: unknown) => Buffer.compare(Buffer.from(canonicalJsonData(a)), Buffer.from(canonicalJsonData(b)))
/** An ordered fold of immutable observations only; counts retain alias and
 * unavailable occurrences, independently of physical publication deduplication. */
export function createTransferClosure(workspaceId: string, binding: SeedDependencyTransferBinding) {
  let previous = hash('start', { version: 1, workspaceId, ...binding }), rootCount = 0, catalogCount = 0, entryCount = 0, retainedMembershipCount = 0
  return {
    root(artifact: SeedArtifact, owner: ArtifactOwner) {
      previous = hash('root', { previous, ref: artifact.ref, owner, uses: [...artifact.uses].sort(canonicalCompare) }); rootCount++
    },
    catalog() { catalogCount++ },
    entry(catalogRef: ManagedArtifactRef, catalogOwner: ArtifactOwner, ordinal: number, entry: ResultDependency, memberOwner?: ArtifactOwner) {
      previous = hash('entry', { previous, catalogRef, catalogOwner, catalogOperationId: catalogOwner.operationId, ordinal, entry,
        ...(memberOwner ? { memberOperationId: memberOwner.operationId, memberOwner } : {}) })
      entryCount++; if (memberOwner) retainedMembershipCount++
    },
    finish() { return hash('end', { previous, rootCount, catalogCount, entryCount, retainedMembershipCount }) },
  }
}
