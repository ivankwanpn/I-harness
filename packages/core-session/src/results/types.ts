import type { ImageInput } from '../images.ts'

export interface JsonObject { readonly [key: string]: JsonValue }
export interface JsonArray extends ReadonlyArray<JsonValue> {}
export type JsonValue = null | boolean | number | string | JsonArray | JsonObject
export type ResultOutcome = 'succeeded' | 'failed' | 'canceled' | 'unknown'
export interface ResultExecution { outcome: ResultOutcome; dispatch: 'not-dispatched' | 'dispatched' | 'unknown' }
export type ResultCodec = 'json-utf8-v1' | 'text-utf8-v1' | 'exec-frames-v1' | 'code-output-manifest-v1'
export type ResultCompleteness = 'complete' | 'source-limited' | 'capture-canceled' | 'producer-incomplete'
export interface ManagedArtifactRef {
  version: 1; id: string; revision: string; codec: ResultCodec; encodedBytes: number
  contentDigest: string; completeness: ResultCompleteness
}
export type ResultRetention =
  | { kind: 'inline'; value: JsonValue; encodedBytes: number }
  | { kind: 'artifact'; ref: ManagedArtifactRef }
  | { kind: 'unavailable'; reason: 'quota' | 'encoding' | 'storage-refused' | 'unsupported-owner' | 'capture-canceled'; observedEncodedBytes?: number }
export interface ResultEnvelope {
  version: 1; execution: ResultExecution; preview: string; media: readonly ImageInput[]; retention: ResultRetention
  dependencies?: ResultDependencies
}
export type ResultDependency = { kind: 'exec-frames'; sourceId: string; retention: Extract<ResultRetention, { kind: 'artifact' | 'unavailable' }> }
export interface ResultDependencyCatalog { version: 1; kind: 'result-dependencies'; entries: readonly ResultDependency[] }
export type ResultDependencies = { kind: 'artifact-set'; ref: ManagedArtifactRef; count: number }
  | { kind: 'unavailable'; reason: Extract<ResultRetention, { kind: 'unavailable' }>['reason']; count: number }
/** Auxiliary child/job row identity; pending never certifies retained bytes. */
export type RetainedResultRevision = { version: 1; revision: string; kind: 'pending' }
  | { version: 1; revision: string; kind: 'retained'; envelope: ResultEnvelope }
/** Avoid recursively remapping the already immutable recursive JsonValue. */
export type ResultEnvelopeView = Readonly<Omit<ResultEnvelope, 'execution' | 'media' | 'retention'>> & {
  readonly execution: Readonly<ResultExecution>
  readonly media: readonly Readonly<ImageInput>[]
  readonly retention: Readonly<Exclude<ResultRetention, { kind: 'artifact' }>> | { readonly kind: 'artifact'; readonly ref: Readonly<ManagedArtifactRef> }
}
export type ResultFactPayload = { output: unknown; isError?: true; envelope?: never } | { envelope: ResultEnvelope; output?: never; isError?: never }
