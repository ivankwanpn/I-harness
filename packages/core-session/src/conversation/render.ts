import type { LLMMessage } from "../projection/types.ts"
import type { ConversationProjection } from "./types.ts"

/** Copy message/container objects without freezing arbitrary legacy arguments.
 * Non-plain unknown values remain opaque; R1C owns validated immutable capture.
 */
export function copyConversationMessage(message: LLMMessage): LLMMessage {
  return copyContainers(message, new WeakMap())
}

function copyContainers<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (value === null || typeof value !== "object") return value
  const previous = seen.get(value)
  if (previous) return previous as T
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value
  const copy: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {}
  seen.set(value, copy)
  for (const [key, child] of Object.entries(value)) Object.defineProperty(copy, key, { value: copyContainers(child, seen), enumerable: true, configurable: true, writable: true })
  return copy as T
}

/** Selection is item based: every item's already ordered full bundle is emitted. */
export function renderConversation(projection: ConversationProjection): LLMMessage[] {
  return projection.items.flatMap(item => item.messages.map(copyConversationMessage))
}
