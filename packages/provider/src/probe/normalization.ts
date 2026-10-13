import type { ModelDescriptor } from "../types.ts"
import { positiveInteger } from "../values.ts"
import { ModelProbeFailedError } from "./errors.ts"

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** Capacity extraction (opencode-style model rows): top-level
 * contextWindow/maxTokens win per field; the `limit.{context,output}` pair is
 * atomic — a missing/invalid half drops BOTH (a half-pair never surfaces). */
function capacityOf(raw: Record<string, unknown>): { contextWindow?: number; maxTokens?: number } {
  const contextWindow = positiveInteger(raw.contextWindow)
  const maxTokens = positiveInteger(raw.maxTokens)
  const limit = isRecordLike(raw.limit) ? raw.limit : undefined
  const limitContext = limit !== undefined ? positiveInteger(limit.context) : undefined
  const limitOutput = limit !== undefined ? positiveInteger(limit.output) : undefined
  const pair = limitContext !== undefined && limitOutput !== undefined
    ? { contextWindow: limitContext, maxTokens: limitOutput }
    : undefined
  return {
    ...(contextWindow !== undefined ? { contextWindow } : pair !== undefined ? { contextWindow: pair.contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : pair !== undefined ? { maxTokens: pair.maxTokens } : {}),
  }
}

/** One normalized model row: id from id|slug|model|name (first present wins —
 * name doubles as the last-resort id); display name from
 * display_name|displayName|label|name. */
function toDescriptor(raw: Record<string, unknown>): ModelDescriptor | undefined {
  const id = nonEmptyString(raw.id) ?? nonEmptyString(raw.slug)
    ?? nonEmptyString(raw.model) ?? nonEmptyString(raw.name)
  if (id === undefined) return undefined
  const name = nonEmptyString(raw.display_name) ?? nonEmptyString(raw.displayName)
    ?? nonEmptyString(raw.label) ?? nonEmptyString(raw.name)
  return { id, ...(name !== undefined ? { name } : {}), ...capacityOf(raw) }
}

/** Array-form rows: an entry with no resolvable id is a hardened check — the
 * branded error never escapes as a bare TypeError (fix round 1). */
function normalizeRows(items: unknown[]): ModelDescriptor[] {
  return items.map((item): ModelDescriptor => {
    if (typeof item === "string" && item !== "") return { id: item }
    if (isRecordLike(item)) {
      const descriptor = toDescriptor(item)
      if (descriptor !== undefined) return descriptor
    }
    throw new ModelProbeFailedError("model probe failed: model entry missing id")
  })
}

/** Record-map form: id from the key, metadata from the value (string value =
 * display name; null/scalar = id-only row — lenient). */
function normalizeMap(map: Record<string, unknown>): ModelDescriptor[] {
  return Object.entries(map).map(([id, value]): ModelDescriptor => {
    if (value === null) return { id }
    if (typeof value === "string") return value !== "" ? { id, name: value } : { id }
    if (isRecordLike(value)) {
      const name = nonEmptyString(value.display_name) ?? nonEmptyString(value.displayName)
        ?? nonEmptyString(value.label) ?? nonEmptyString(value.name)
      return { id, ...(name !== undefined ? { name } : {}), ...capacityOf(value) }
    }
    return { id }
  })
}

/**
 * Response normalization matrix (opencode/cc-switch shapes accepted): array of
 * rows | {data|models|items:[...]} | {data|models|items:{id:row}} | bare
 * {id:row|name} record map. Returns undefined for an unsupported shape so the
 * probe can brand it.
 */
export function normalizeModelList(body: unknown): ModelDescriptor[] | undefined {
  if (Array.isArray(body)) return normalizeRows(body)
  if (!isRecordLike(body)) return undefined
  for (const key of ["data", "models", "items"] as const) {
    if (!(key in body)) continue
    const container = body[key]
    if (Array.isArray(container)) return normalizeRows(container)
    if (isRecordLike(container)) return normalizeMap(container)
    return undefined // container present but scalar/null → unsupported shape
  }
  if (Object.values(body).every((v) => v === null || typeof v === "string" || isRecordLike(v))) {
    return normalizeMap(body)
  }
  return undefined
}
