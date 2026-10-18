import type { LLMMessage } from "../projection/types.ts"
import type { DeepMutable } from '../managed/types.ts'
type ReadonlyData<T> = T extends readonly (infer E)[] ? readonly ReadonlyData<E>[] : T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T
type ReadonlyMessage = ReadonlyData<LLMMessage>

/** Copy message/container objects without freezing arbitrary legacy arguments.
 * Non-plain unknown values remain opaque; R1C owns validated immutable capture.
 */
export function copyConversationMessage(message: ReadonlyMessage): LLMMessage {
  return copyConversationData(message) as LLMMessage
}

/** Fresh containers for validated conversation/request data. Legacy non-plain
 * values remain opaque, as on the renderer's original compatibility path. */
export function copyConversationData<T>(input: T): DeepMutable<T> {
  const seen = new WeakMap<object, unknown>()
  let result: unknown
  const stack: { value: unknown; put: (value: unknown) => void }[] = [{ value: input, put: value => { result = value } }]
  while (stack.length) {
    const { value, put } = stack.pop()!
    if (value === null || typeof value !== "object") { put(value); continue }
    const previous = seen.get(value)
    if (previous) { put(previous); continue }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) { put(value); continue }
    const copy: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {}
    seen.set(value, copy); put(copy)
    for (const [key, child] of Object.entries(value).reverse()) stack.push({ value: child, put: owned => Object.defineProperty(copy, key, { value: owned, enumerable: true, configurable: true, writable: true }) })
  }
  return result as DeepMutable<T>
}

/** Selection is item based: every item's already ordered full bundle is emitted. */
export function renderConversation(projection: { readonly items: readonly { readonly messages: readonly ReadonlyMessage[] }[] }): LLMMessage[] {
  return projection.items.flatMap(item => item.messages.map(copyConversationMessage))
}
