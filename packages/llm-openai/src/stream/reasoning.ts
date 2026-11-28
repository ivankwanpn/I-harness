import { isDeepStrictEqual } from "node:util"

type Item = Record<string, unknown>
type Key = string | number
const record = (value: unknown): value is Item => !!value && typeof value === "object" && !Array.isArray(value)
const opaque = (item: Item) => typeof item.encrypted_content === "string" && item.encrypted_content.length > 0
const textParts = (value: unknown, type: string) => Array.isArray(value) && value.every(part => record(part) && part.type === type && typeof part.text === "string")
const allowedFields = new Set(["type", "id", "summary", "content", "status", "encrypted_content"])

function completeItem(item: Item, deepSeek: boolean): boolean {
  if (item.status !== undefined && item.status !== "completed" || Object.keys(item).some(key => !allowedFields.has(key))) return false
  if (item.encrypted_content != null && !opaque(item)) return false
  if (item.content !== undefined && !textParts(item.content, "reasoning_text")) return false
  if (!textParts(item.summary, "summary_text") && !(deepSeek && item.summary === undefined && Array.isArray(item.content) && item.content.length)) return false
  return opaque(item) || [item.content, item.summary].some(parts => Array.isArray(parts) && parts.some(part => part.text.length > 0))
}

/** Item IDs are local to this response. The output position binds an item to
 * the original assistant order, even when block completion arrives out of order. */
export function createResponsesReasoning(xai: boolean, deepSeek: boolean, replayableRoute: () => boolean) {
  const items = new Map<Key, Item>()
  const observed = new Map<Key, { position?: number; ambiguous?: true }>()
  const ambiguousPositions = new Set<number>()
  const keyFor = (item: Item, position: number | undefined): Key | undefined =>
    typeof item.id === "string" && item.id.trim() ? item.id
      : xai && item.id === undefined && Array.isArray(item.summary) && opaque(item) ? position : undefined

  return {
    items,
    matches(index: number, item: Item): boolean {
      const key = keyFor(item, index), prior = key === undefined ? undefined : observed.get(key)
      return key !== undefined && prior !== undefined && !prior.ambiguous && !ambiguousPositions.has(index)
        && (prior.position === undefined || prior.position === index) && isDeepStrictEqual(items.get(key), item)
    },
    observe(item: Item, index: unknown, occupied: boolean): number | "repeat" | undefined {
      const position = typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : undefined
      const key = keyFor(item, position)
      if (key === undefined) {
        if (position !== undefined) ambiguousPositions.add(position)
        return
      }
      const prior = observed.get(key)
      if (prior && !prior.ambiguous && prior.position === position && isDeepStrictEqual(items.get(key), item)) return "repeat"
      if (prior || occupied) {
        if (prior) { prior.ambiguous = true; if (prior.position !== undefined) ambiguousPositions.add(prior.position) }
        if (position !== undefined) ambiguousPositions.add(position)
        return
      }
      const ordinal = items.size
      observed.set(key, { position })
      items.set(key, item)
      return ordinal
    },
    terminal(output: unknown[], occupied: (index: number) => boolean, recordPosition: (index: number, ordinal: number) => void) {
      const candidates = new Map<Key, { item: Item; index: number } | null>()
      for (const [index, item] of output.entries()) {
        if (!record(item) || item.type !== "reasoning") continue
        const key = keyFor(item, index)
        if (key === undefined) continue
        if (candidates.has(key)) {
          const first = candidates.get(key)
          if (first) ambiguousPositions.add(first.index)
          ambiguousPositions.add(index)
          candidates.set(key, null)
        } else candidates.set(key, { item, index })
      }
      if (!candidates.size || !replayableRoute()) return
      for (const [key, candidate] of candidates) {
        if (!candidate) continue
        const { item, index } = candidate
        if (ambiguousPositions.has(index) || !completeItem(item, deepSeek)) continue
        const previous = items.get(key), prior = observed.get(key)
        if (previous && prior) {
          if (prior.ambiguous || (prior.position === undefined ? occupied(index) : prior.position !== index)) continue
          if (!opaque(item) || previous.encrypted_content != null) continue
          const { encrypted_content: _old, ...early } = previous, { encrypted_content, ...late } = item
          if (!isDeepStrictEqual(early, late)) continue
          items.set(key, { ...previous, encrypted_content })
        } else {
          if (occupied(index)) continue
          const ordinal = items.size
          recordPosition(index, ordinal)
          observed.set(key, { position: index })
          items.set(key, item)
        }
      }
    },
  }
}
