import { rewindCuts, type Session } from "@i-harness/core-session"
import type { CodeModeStoreEntries } from "./types.ts"

/** Seed prefixes are inherited data authority, including repeated forks.
 * Fresh owner events never import another session's writes. Compaction only
 * changes inference visibility, so only rewind windows remove committed data. */
export function replayCodeModeStore(session: Session, sessionId?: string): CodeModeStoreEntries {
  const cuts = rewindCuts(session)
  const visible = (seq: number | undefined) => seq === undefined || !cuts.some(cut => seq >= cut.cutFrom && seq < cut.markerSeq)
  const owned = (event: { sessionId?: string; seq?: number }) => event.sessionId === sessionId ||
    (session.header?.parentSession !== undefined && event.seq !== undefined && event.seq < (session.header.seedLength ?? 0))
  const terminal = new Map<string, { state: string; seq?: number }>()
  const key = (event: { cellId: string; sessionId?: string }) => JSON.stringify([event.sessionId ?? null, event.cellId])
  for (const event of session.events) {
    if (event.type === "code/cell" && owned(event) && visible(event.seq)) terminal.set(key(event), { state: event.state, seq: event.seq })
  }
  const values = new Map<string, CodeModeStoreEntries[number][1]>()
  for (const event of session.events) {
    if (event.type !== "code/store" || !owned(event) || !visible(event.seq)) continue
    const closed = terminal.get(key(event))
    if (closed?.state !== "completed" || event.seq !== undefined && closed.seq !== undefined && closed.seq <= event.seq) continue
    if (event.version !== 1) throw new Error("Unsupported Code Mode store version")
    if (!Array.isArray(event.writes)) throw new Error("Invalid Code Mode store entries")
    for (const entry of event.writes) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") throw new Error("Invalid Code Mode store entry")
      values.set(entry[0], entry[1] as CodeModeStoreEntries[number][1])
    }
  }
  return [...values]
}
