import type { HistoryRange } from "@i-harness/sdk"
import { mergeReasoningChunks, mergeTextFragments } from "./reasoning-progress.ts"

export type WireEvent = HistoryRange["events"][number]
export type AssistantPreview = Extract<WireEvent, { type: "assistant/chunk" }> & { stepStartSeq: number; offset: number }

export interface EventWindow {
  /** Next unread seq — the replay checkpoint, never the last displayed seq. */
  cursor: number
  events: WireEvent[]
  /** Events with no seq: display-only, never a checkpoint. */
  live: WireEvent[]
  assistantPreview?: AssistantPreview
  assistantBoundary?: number
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

export function isAssistantPreview(event: WireEvent): event is AssistantPreview {
  return event.type === "assistant/chunk" && event.seq === undefined &&
    event.stepStartSeq !== undefined && Number.isSafeInteger(event.stepStartSeq) && event.stepStartSeq >= 0 &&
    event.offset !== undefined && Number.isSafeInteger(event.offset) && event.offset >= 0 &&
    typeof event.text === "string" && event.text.length > 0
}

function assistantBoundary(event: WireEvent): number {
  switch (event.type) {
    case "assistant/message":
    case "step/start":
    case "step/end":
    case "step/failed":
    case "turn/start":
    case "turn/end":
      return event.seq ?? -1
    default:
      return -1
  }
}

export function updateAssistantPreview(current: AssistantPreview | undefined, event: WireEvent): AssistantPreview | undefined {
  if (!isAssistantPreview(event)) return current && assistantBoundary(event) > current.stepStartSeq ? undefined : current
  if (!current || event.stepStartSeq > current.stepStartSeq) return event
  if (event.stepStartSeq < current.stepStartSeq) return current
  return mergeTextFragments(current, event) ?? current
}

function settleLive(state: EventWindow, incoming: readonly WireEvent[]): Pick<EventWindow, "live" | "assistantPreview" | "assistantBoundary"> {
  const completed = new Set(incoming.flatMap((event) => event.type === "reasoning" && event.streamId ? [event.streamId] : []))
  const boundary = incoming.reduce((latest, event) => Math.max(latest, assistantBoundary(event)), state.assistantBoundary ?? -1)
  const preview = state.assistantPreview
  // Preserve the reasoning input array when ordinary bookkeeping settles.
  const live = completed.size === 0 ? state.live :
    state.live.filter((event) => event.type !== "reasoning/chunk" || !completed.has(event.streamId))
  return { live, assistantPreview: preview && boundary <= preview.stepStartSeq ? preview : undefined, assistantBoundary: boundary }
}

/** Transient block positions are measured against the durable sequence so a
 * delayed UI frame still places reasoning before later tool or message rows. */
export function timelineEvents(state: Pick<EventWindow, "events" | "live">): WireEvent[] {
  if (state.live.length === 0) return state.events
  const position = (event: WireEvent) => event.type === "reasoning/chunk" ? event.atSeq : event.seq ?? Number.POSITIVE_INFINITY
  return [...state.live, ...state.events].sort((a, b) => position(a) - position(b))
}

export function applyHistory(state: EventWindow, page: HistoryRange): EventWindow {
  return {
    cursor: Math.max(state.cursor, page.nextSeq),
    events: capEvents(mergeBySeq(state.events, page.events.filter(event => (event as { type: string }).type !== "model/activity").map(retainEvent))),
    ...settleLive(state, page.events),
    connection: "online",
  }
}

export function applyNotification(state: EventWindow, event: WireEvent): EventWindow {
  if ((event as { type: string }).type === "model/activity") return state
  event = retainEvent(event)
  if (isAssistantPreview(event)) {
    if (state.connection === "offline" || (state.assistantBoundary ?? -1) > event.stepStartSeq) return state
    const assistantPreview = updateAssistantPreview(state.assistantPreview, event)
    return assistantPreview === state.assistantPreview ? state : { ...state, assistantPreview }
  }
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
  const live = settleLive(state, [event])
  const last = state.events[state.events.length - 1]
  // Streaming appends are the hot path: a strictly newer seq needs neither a
  // rebuild nor a sort, only the new array React needs to re-render.
  if (last?.seq === undefined || event.seq > last.seq) {
    return { ...state, ...live, events: capEvents([...state.events, event]) }
  }
  return { ...state, ...live, events: capEvents(mergeBySeq(state.events, [event])) }
}

export function markDisconnected(state: EventWindow): EventWindow {
  return { ...state, connection: "offline", assistantPreview: undefined, live: [] }
}

/** Historical paging has its own bounds; it never changes next-unread cursor. */
export interface HistoryViewport { events: WireEvent[]; startSeq: number; endSeq: number; hasBefore: boolean; hasAfter: boolean }
export const HISTORY_PAGE_SIZE = 200
export const MAX_HISTORY_VIEW_EVENTS = 2000
export function historyViewport(page: HistoryRange, startSeq: number): HistoryViewport {
  return { events: page.events.filter(event => (event as { type: string }).type !== "model/activity").map(retainEvent), startSeq, endSeq: page.nextSeq, hasBefore: startSeq > 0, hasAfter: page.events.length === HISTORY_PAGE_SIZE }
}
export function pageHistoryViewport(state: HistoryViewport, page: HistoryRange, startSeq: number, direction: "before" | "after"): HistoryViewport {
  const merged = mergeBySeq(state.events, page.events.filter(event => (event as { type: string }).type !== "model/activity").map(retainEvent))
  const events = direction === "before" ? merged.slice(0, MAX_HISTORY_VIEW_EVENTS) : merged.slice(-MAX_HISTORY_VIEW_EVENTS)
  const first = events[0]?.seq ?? startSeq
  const last = events.at(-1)?.seq
  return { events, startSeq: first, endSeq: last === undefined ? startSeq : last + 1, hasBefore: first > 0, hasAfter: direction === "after" ? page.events.length === HISTORY_PAGE_SIZE : state.hasAfter || merged.length > events.length }
}
