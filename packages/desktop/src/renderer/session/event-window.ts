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

/** One retained session window is bounded; the durable log is the real store. */
export const MAX_RETAINED_EVENTS = 20_000
export const MAX_RETAINED_LIVE = 200

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

function capEvents(events: WireEvent[]): WireEvent[] {
  return events.length > MAX_RETAINED_EVENTS ? events.slice(events.length - MAX_RETAINED_EVENTS) : events
}

export function applyHistory(state: EventWindow, page: HistoryRange): EventWindow {
  return {
    cursor: Math.max(state.cursor, page.nextSeq),
    events: capEvents(mergeBySeq(state.events, page.events)),
    live: state.live.length > MAX_RETAINED_LIVE ? state.live.slice(state.live.length - MAX_RETAINED_LIVE) : [...state.live],
    connection: "online",
  }
}

export function applyNotification(state: EventWindow, event: WireEvent): EventWindow {
  if (event.seq === undefined) {
    const live = [...state.live, event]
    return { ...state, live: live.length > MAX_RETAINED_LIVE ? live.slice(live.length - MAX_RETAINED_LIVE) : live }
  }
  const last = state.events[state.events.length - 1]
  // Streaming appends are the hot path: a strictly newer seq needs neither a
  // rebuild nor a sort, only the new array React needs to re-render.
  if (last?.seq === undefined || event.seq > last.seq) {
    return { ...state, events: capEvents([...state.events, event]) }
  }
  return { ...state, events: capEvents(mergeBySeq(state.events, [event])) }
}

export function markDisconnected(state: EventWindow): EventWindow {
  return { ...state, connection: "offline" }
}
