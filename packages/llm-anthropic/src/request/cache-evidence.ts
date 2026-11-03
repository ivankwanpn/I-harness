import { semanticProjectionDigest } from "@i-harness/token-meter"
import { snapshotModelData } from "@i-harness/llm-seam"

/** Private records created only by cache insertion, never read from requests. */
export interface CacheEdit {
  readonly path: readonly (string | number)[]
  readonly inserted: unknown
  readonly original?: string
}
export interface CacheEvidence {
  readonly adapter: "anthropic-messages"
  readonly revision: "anthropic-cache-v1"
  readonly edits: readonly CacheEdit[]
}
export function describeCachedBody(body: Record<string, unknown>, evidence: CacheEvidence) {
  const semantic = snapshotModelData(body)
  let metadataBytes = 0
  for (const edit of evidence.edits) {
    let parent: unknown = semantic
    for (const key of edit.path.slice(0, -1)) parent = parent && typeof parent === "object" ? (parent as Record<string, unknown>)[key] : undefined
    if (!parent || typeof parent !== "object") continue
    const key = edit.path.at(-1)!, record = parent as Record<string, unknown>
    if (semanticProjectionDigest("unit", record[key]) !== semanticProjectionDigest("unit", edit.inserted)) continue
    if (edit.original !== undefined) {
      // A produced string wrapper contains precisely one generated marker.
      const marker = (edit.inserted as { cache_control: unknown }[])[0]!.cache_control
      metadataBytes += Buffer.byteLength(JSON.stringify(marker))
      Object.defineProperty(record, key, { value: edit.original, enumerable: true, writable: true, configurable: true })
    }
    else { metadataBytes += Buffer.byteLength(JSON.stringify(edit.inserted)); delete record[key] }
  }
  return { semantic, metadataBytes }
}
