import type { ConversationSourceRef } from "./types.ts"
import type { SessionEvent } from "../events/types.ts"
import { imageDescriptor, type ImageInput } from "../images.ts"
import { renderPruneSubstitute, type PruneRecord } from "../projection/pruning.ts"

export type ConversationPayloadCapture = (value: unknown, source: ConversationSourceRef) => unknown

/** Payload slots are read by descriptor before caller-owned validation. */
export function readConversationPayload<T, K extends keyof T>(event: T, key: K, source: ConversationSourceRef, capture?: ConversationPayloadCapture): T[K] {
  if (!capture) return event[key]
  const descriptor = Object.getOwnPropertyDescriptor(event, key)
  if (!descriptor) return undefined as T[K]
  if (!("value" in descriptor) || !descriptor.enumerable) {
    // Let the same validator reject a descriptor without executing its getter.
    capture(Object.defineProperty({}, "payload", descriptor), source)
    throw new Error("CONTEXT_SNAPSHOT_UNSUPPORTED")
  }
  return (descriptor.value === undefined ? undefined : capture(descriptor.value, source)) as T[K]
}

/** Outcome metadata never invokes accessors on unknown result graphs. */
export function outcomeField(output: unknown, key: string): unknown {
  if (!output || typeof output !== "object") return undefined
  const descriptor = Object.getOwnPropertyDescriptor(output, key)
  return descriptor && "value" in descriptor ? descriptor.value : undefined
}

/** Preflight exactly the retained result components before any JSON serializer. */
export function projectToolResult(event: Extract<SessionEvent, { type: "tool/result" }>, record: PruneRecord | undefined, source: ConversationSourceRef, imageSource: ConversationSourceRef, capture?: ConversationPayloadCapture): { content: string; images?: ImageInput[] } {
  const output = record === undefined ? readConversationPayload(event, "output", source, capture) : undefined
  // A pruned view retains its preview and images, not excluded raw output.
  const out = record === undefined ? output : readConversationPayload(event, "output", source, capture ? value => value : undefined)
  const images = out && typeof out === "object" ? readConversationPayload(out as { images?: ImageInput[] }, "images", imageSource, capture) : undefined
  const content = record === undefined ? toolResultText(output) : renderPruneSubstitute(capture ? capture(record, source) as PruneRecord : record)
  return { content, ...(Array.isArray(images) && images.length ? { images } : {}) }
}

/** Images travel in a companion message, never as base64 in result text. */
function toolResultText(output: unknown): string {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return JSON.stringify(output) ?? String(output)
  const record = output as Record<string, unknown>
  const images = record["images"]
  if (!Array.isArray(images) || images.length === 0) return JSON.stringify(output) ?? String(output)
  const { images: _images, ...rest } = record
  const hasRest = Object.keys(rest).length > 0
  const restText = hasRest ? (JSON.stringify(rest) ?? String(rest)) : ""
  const descriptor = imageDescriptor(images as ImageInput[])
  return hasRest ? restText + descriptor : descriptor.trimStart()
}
