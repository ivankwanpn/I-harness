import type { SessionView } from '../managed/types.ts'
import { createSemanticSourceConversationIndex } from '../conversation/validation.ts'
import type { ManagedArtifactRef } from './types.ts'

/** References follow validated manifest/group associations in the existing
 * structural owner. Archived replacements remain readable; rewound branches do not. */
export function semanticSeedResultRefs(view: SessionView): readonly ManagedArtifactRef[] {
  return createSemanticSourceConversationIndex(view.events, view.formatVersion, view.header).semanticSeedResultRefs()
}
export function sameManagedArtifactRef(left: ManagedArtifactRef, right: ManagedArtifactRef): boolean {
  return left.version === right.version && left.id === right.id && left.revision === right.revision
    && left.codec === right.codec && left.encodedBytes === right.encodedBytes
    && left.contentDigest === right.contentDigest && left.completeness === right.completeness
}
