import type { HistoryRange } from "@i-harness/sdk"

export type WireEvent = HistoryRange["events"][number]

export interface EventWindow {
  /** Next unread seq — the replay checkpoint, never the last displayed seq. */
  cursor: number
  events: WireEvent[]
  /** Events with no seq: display-only, never a checkpoint. */
  live: WireEvent[]
  connection: "online" | "offline"
}

export function emptyEventWindow(): EventWindow {
  return { cursor: 0, events: [], live: [], connection: "online" }
}

function mergeBySeq(current: WireEvent[], incoming: WireEvent[]): WireEvent[] {
  const bySeq = new Map<number, WireEvent>()
  for (const event of current) if (event.seq !== undefined) bySeq.set(event.seq, event)
  // A replayed durable copy replaces the live copy of the same seq.
  for (const event of incoming) if (event.seq !== undefined) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq! - b.seq!)
}

export function applyHistory(state: EventWindow, page: HistoryRange): EventWindow {
  return {
    cursor: Math.max(state.cursor, page.nextSeq),
    events: mergeBySeq(state.events, page.events),
    live: [...state.live],
    connection: "online",
  }
}

export function applyNotification(state: EventWindow, event: WireEvent): EventWindow {
  if (event.seq === undefined) return { ...state, live: [...state.live, event] }
  return { ...state, events: mergeBySeq(state.events, [event]) }
}

export function markDisconnected(state: EventWindow): EventWindow {
  return { ...state, connection: "offline" }
}
