import type { HistoryRange } from "@i-harness/sdk"
import { mergeReasoningChunks } from "./reasoning-progress.ts"

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

function retainEvent(event: WireEvent): WireEvent {
  if (event.type !== "agent/input/admitted" || event.images === undefined) return event
  const { images: _images, ...rest } = event
  return rest
}

function settleLive(live: WireEvent[], incoming: readonly WireEvent[]): WireEvent[] {
  const completed = new Set(incoming.flatMap((event) => event.type === "reasoning" && event.streamId ? [event.streamId] : []))
  return live.filter((event) => event.type !== "reasoning/chunk" || !completed.has(event.streamId)).slice(-MAX_RETAINED_LIVE)
}

/** Transient block positions are measured against the durable sequence so a
 * delayed UI frame still places reasoning before later tool or message rows. */
export function timelineEvents(state: EventWindow): WireEvent[] {
  if (state.live.length === 0) return state.events
  const position = (event: WireEvent) => event.type === "reasoning/chunk" ? event.atSeq : event.seq ?? Number.POSITIVE_INFINITY
  return [...state.live, ...state.events].sort((a, b) => position(a) - position(b))
}

export function applyHistory(state: EventWindow, page: HistoryRange): EventWindow {
  return {
    cursor: Math.max(state.cursor, page.nextSeq),
    events: capEvents(mergeBySeq(state.events, page.events.map(retainEvent))),
    live: settleLive(state.live, page.events),
    connection: "online",
  }
}

export function applyNotification(state: EventWindow, event: WireEvent): EventWindow {
  event = retainEvent(event)
  if (event.type === "reasoning/chunk") {
    // The canonical notification may reach React before its buffered chunks.
    if (state.events.some((item) => item.type === "reasoning" && item.streamId === event.streamId)) return state
    let combined = event
    const live: WireEvent[] = []
    let insertAt: number | undefined
    for (const item of state.live) {
      const merged = item.type === "reasoning/chunk" ? mergeReasoningChunks(combined, item) : undefined
      if (merged) { combined = merged; insertAt ??= live.length }
      else live.push(item)
    }
    live.splice(insertAt ?? live.length, 0, combined)
    return { ...state, live: live.slice(-MAX_RETAINED_LIVE) }
  }
  if (event.seq === undefined) {
    const live = [...state.live, event]
    return { ...state, live: live.length > MAX_RETAINED_LIVE ? live.slice(live.length - MAX_RETAINED_LIVE) : live }
  }
  const live = settleLive(state.live, [event])
  const last = state.events[state.events.length - 1]
  // Streaming appends are the hot path: a strictly newer seq needs neither a
  // rebuild nor a sort, only the new array React needs to re-render.
  if (last?.seq === undefined || event.seq > last.seq) {
    return { ...state, live, events: capEvents([...state.events, event]) }
  }
  return { ...state, live, events: capEvents(mergeBySeq(state.events, [event])) }
}

export function markDisconnected(state: EventWindow): EventWindow {
  return { ...state, connection: "offline" }
}
