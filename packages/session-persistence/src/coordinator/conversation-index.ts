import { CURRENT_FORMAT_VERSION, createConversationValidationIndex, type ConversationValidationIndex, type SessionEvent } from "@i-harness/core-session"
import { SessionFormatUnsupportedError } from "../format/registry.ts"
import { preflightBatchShape } from "../format/validation.ts"
import { ensureWritableFormatUnlocked } from "./writable-format.ts"
import type { PersistenceBackend } from "./types.ts"

/** Derived facts live under the coordinator's existing operation gate. No raw log cache. */
export function createConversationIndexes(backend: Pick<PersistenceBackend, "read" | "id" | "upgradeSessionFormat">) {
  const indexes = new Map<string, ConversationValidationIndex>()
  return {
    invalidate(id: string) { indexes.delete(id) },
    clear() { indexes.clear() },
    async stage(id: string, events: SessionEvent[]) {
      let index = indexes.get(id)
      const loaded = await ensureWritableFormatUnlocked(backend, id)
      let suffix = events
      if (!index || index.formatVersion !== CURRENT_FORMAT_VERSION || index.eventCount !== loaded.events.length) {
        index = createConversationValidationIndex(loaded.events, { formatVersion: CURRENT_FORMAT_VERSION, header: loaded.meta })
        indexes.set(id, index)
        // A retained write-behind batch may already be durable after an uncertain
        // append. Compare actual persisted records once on reload; never cache bodies.
        let overlap = 0
        const bySeq = new Map(loaded.events.filter(event => event.seq !== undefined).map(event => [event.seq, event]))
        for (const event of events) {
          const existing = event.seq === undefined ? undefined : bySeq.get(event.seq)
          if (!existing) break
          if (JSON.stringify(existing) !== JSON.stringify(event)) throw new SessionFormatUnsupportedError("append conflicts with durable prefix")
          overlap++
        }
        suffix = events.slice(overlap)
      }
      preflightBatchShape(CURRENT_FORMAT_VERSION, suffix)
      try {
        const staged = index.stage(suffix, { readCurrentEvent: position => loaded.events[position] })
        return { events: suffix, commit: () => staged.commit() }
      } catch (cause) { throw new SessionFormatUnsupportedError("unsupported conversation suffix", { cause }) }
    },
  }
}
