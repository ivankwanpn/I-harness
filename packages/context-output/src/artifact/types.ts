import type { ManagedArtifactRef, ResultCodec, ResultCompleteness } from '@i-harness/core-session'
export interface ResultArtifactScope { readonly operationId: string }
export interface ArtifactOwner { operationId: string; sessionId: string; callId: string; documentId?: string; source?: { sourceId: string; path?: string; revision?: string; readonly?: boolean } }
export type ArtifactSettlement = { kind: 'committed'; ref: ManagedArtifactRef }
  | { kind: 'refused'; reason: 'quota' | 'encoding' | 'storage-refused' | 'capture-canceled'; observedEncodedBytes: number }
  | { kind: 'recovery-required'; operationId: string }
export interface ResultArtifactSink {
  write(bytes: Uint8Array): Promise<void>
  reconcileWrite(): Promise<'ready' | 'recovery-required'>
  finish(completeness: ResultCompleteness): Promise<ArtifactSettlement>
  reconcile(): Promise<ArtifactSettlement>
}
export interface ManagedArtifactPage {
  ref: ManagedArtifactRef; offset: number; nextOffset: number | null; eof: boolean
  data: { kind: 'text'; text: string } | { kind: 'bytes'; base64: string }
}
export interface ArtifactManifest {
  version: 1; codec: ResultCodec; encodedBytes: number; contentDigest: string; completeness: ResultCompleteness
  chunkBytes: 65536; leaves: number; paddedLeaves: number; treeRoot: string
}
export interface ArtifactOperation {
  version: 1; owner: ArtifactOwner; codec: ResultCodec; id: string
  phase: 'capturing' | 'staged' | 'committed' | 'refused'; encodedBytes: number
  manifest?: ArtifactManifest; ref?: ManagedArtifactRef
  reason?: 'quota' | 'encoding' | 'storage-refused' | 'capture-canceled'
}
