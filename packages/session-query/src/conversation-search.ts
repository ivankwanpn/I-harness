import { setImmediate as yieldToHost } from "node:timers/promises"
import type { SearchHit } from "./index.ts"

export type ConversationSearch = (text: string, sessionIds: readonly string[], limit: number) => Promise<SearchHit[]>
export const SEARCH_PAGE_SIZE = 64
export type SearchDocument = Pick<SearchHit, "seq" | "eventType" | "time"> & { text: string }

/** User-facing conversation search uses literal, case-insensitive substrings.
 * Both stores use the same projected text, whitespace rules and hit order. */
export async function searchConversationDocuments(
  text: string, sessionIds: readonly string[], limit: number,
  documents: (sessionId: string) => AsyncIterable<readonly SearchDocument[]>,
): Promise<SearchHit[]> {
  const words = text.trim().split(/\s+/u)
  if (!words[0] || limit <= 0) return []
  const literal = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
  const match = new RegExp(literal, "iu")
  const hits: SearchHit[] = []
  let lastYield = performance.now()
  for (const sessionId of [...sessionIds].sort()) {
    for await (const page of documents(sessionId)) {
      for (const doc of page) {
        const found = match.exec(doc.text)
        if (!found) continue
        const start = Math.max(0, found.index - 40)
        const end = Math.min(doc.text.length, found.index + found[0].length + 80)
        hits.push({
          sessionId, seq: doc.seq, eventType: doc.eventType,
          ...(doc.time == null ? {} : { time: doc.time }),
          snippet: (start ? "…" : "") + doc.text.slice(start, end) + (end < doc.text.length ? "…" : ""),
          bm25: 0,
        })
        if (hits.length === limit) return hits
      }
      if (performance.now() - lastYield >= 12) {
        await yieldToHost()
        lastYield = performance.now()
      }
    }
  }
  return hits
}
