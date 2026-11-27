import type { HistoryRange } from "@i-harness/sdk"
import { assistantBoundary, isAssistantPreview, updateAssistantPreview, type AssistantPreview } from "../../shared/assistant-preview.ts"
import { historyEvents, type WireEvent } from "./history-events.ts"
import { mergeReasoningChunks } from "./reasoning-progress.ts"
import { hasResultImages, isToolImage, record } from "./tool-presentation.ts"

export { isAssistantPreview, updateAssistantPreview, type AssistantPreview } from "../../shared/assistant-preview.ts"
export type { WireEvent } from "./history-events.ts"

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
export const RECENT_HISTORY_LIMIT = 500
const MAX_CACHED_SESSIONS = 4

function hasCodeOutputMedia(value: unknown): boolean {
  const content = record(value)
  return (content?.type === "image" && isToolImage(content.image))
    || (content?.type === "audio" && typeof content.audioUrl === "string" && content.audioUrl.startsWith("data:audio/"))
}

function requiresNativeHistory(event: WireEvent): boolean {
  if (event.type === "user/message") return event.images !== undefined && (!Array.isArray(event.images) || event.images.length > 0)
  if (event.type === "conversation/seed-group") {
    // The bootstrap codec checks that these addresses exactly cover the
    // inherited image parts. The rest of the seed need not be inspected.
    const items = event.group?.items
    return !Array.isArray(items) || items.some(item => {
      if (item?.kind === "input") return !Array.isArray(item.input?.media) || item.input.media.length > 0
      if (item?.kind === "exchange") return !Array.isArray(item.results)
        || item.results.some((result: { media?: unknown } | null) => !Array.isArray(result?.media) || result.media.length > 0)
      return item?.kind !== "summary"
    })
  }
  if (event.type !== "tool/result" && event.type !== "code/result" && event.type !== "code/output") return false
  const envelope = event.envelope
  if (envelope !== undefined) {
    if (!Array.isArray(envelope?.media) || envelope.media.length > 0) return true
    const retention = envelope.retention
    if (retention?.kind === "inline") return hasResultImages(retention.value)
      || (event.type === "code/output" && hasCodeOutputMedia(retention.value))
    return retention?.kind !== "artifact" && retention?.kind !== "unavailable"
  }
  if (event.type !== "code/output") return hasResultImages(event.output)
  return hasCodeOutputMedia(event.content)
}

/** Reopening a conversation paints its last native page while the host
 * refreshes it. Browsing more conversations must not retain every full log. */
export function createHistoryPreviewCache() {
  const windows = new Map<string, EventWindow>()
  return {
    get(key: string) {
      const value = windows.get(key)
      if (value) {
        windows.delete(key)
        windows.set(key, value)
      }
      return value
    },
    set(key: string, window: EventWindow) {
      windows.delete(key)
      const events = window.events.length > RECENT_HISTORY_LIMIT ? window.events.slice(-RECENT_HISTORY_LIMIT) : window.events
      // Inline media remains available in native history and the active
      // window. Avoid holding its encoded bytes in the reopen cache.
      if (events.some(requiresNativeHistory)) return
      windows.set(key, { ...window, events, live: [], assistantPreview: undefined })
      if (windows.size > MAX_CACHED_SESSIONS) windows.delete(windows.keys().next().value!)
    },
  }
}

export function emptyEventWindow(): EventWindow {
  return { cursor: 0, events: [], live: [], connection: "online" }
}

function orderedBySeq(events: WireEvent[]): WireEvent[] {
  if (events.every((event, index) => event.seq !== undefined && (!index || event.seq > events[index - 1]!.seq!))) return events
  const bySeq = new Map<number, WireEvent>()
  for (const event of events) if (event.seq !== undefined) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((a, b) => a.seq! - b.seq!)
}

/** The retained log is ordered and unique. Only merge the part touched by a
 * page, and always prefer the durable replay over a live copy at the same seq. */
function mergeBySeq(current: WireEvent[], incoming: WireEvent[]): WireEvent[] {
  const page = orderedBySeq(incoming)
  if (!page.length) return current
  if (!current.length) return page
  const first = page[0]!.seq!
  if (first > current[current.length - 1]!.seq!) return current.concat(page)
  let low = 0
  let high = current.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (current[middle]!.seq! < first) low = middle + 1
    else high = middle
  }
  const merged = current.slice(0, low)
  let index = low
  for (const event of page) {
    while (index < current.length && current[index]!.seq! < event.seq!) merged.push(current[index++]!)
    if (current[index]?.seq === event.seq) index++
    merged.push(event)
  }
  return index < current.length ? merged.concat(current.slice(index)) : merged
}

function capEvents(events: WireEvent[]): WireEvent[] {
  return events.length > MAX_RETAINED_EVENTS ? events.slice(events.length - MAX_RETAINED_EVENTS) : events
}

function retainEvent(event: WireEvent): WireEvent {
  if (event.type !== "agent/input/admitted" || event.images === undefined) return event
  const { images: _images, ...rest } = event
  return rest
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
  // A background session can advance beyond the entire cached page. Keep
  // subsequent live arrivals, and let the older-page cursor lead into the gap.
  const previous = page.startSeq !== undefined && page.startSeq > state.cursor
    ? state.events.filter(event => event.seq! >= page.startSeq!)
    : state.events
  return {
    cursor: Math.max(state.cursor, page.nextSeq),
    events: capEvents(mergeBySeq(previous, historyEvents(page).filter(event => (event as { type: string }).type !== "model/activity").map(retainEvent))),
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
    const owner = event.type === "turn/start" ? { startSeq: event.seq } : last?.type !== "turn/end" ? last?.historyTurn : undefined
    const row = owner && (owner.endSeq === undefined || event.seq <= owner.endSeq) ? { ...event, historyTurn: owner } : event
    return { ...state, ...live, events: capEvents([...state.events, row]) }
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
  return { events: historyEvents(page).filter(event => (event as { type: string }).type !== "model/activity").map(retainEvent), startSeq, endSeq: page.nextSeq, hasBefore: startSeq > 0, hasAfter: page.events.length === HISTORY_PAGE_SIZE }
}
export function pageHistoryViewport(state: HistoryViewport, page: HistoryRange, startSeq: number, direction: "before" | "after"): HistoryViewport {
  const merged = mergeBySeq(orderedBySeq(state.events), historyEvents(page).filter(event => (event as { type: string }).type !== "model/activity").map(retainEvent))
  const events = direction === "before" ? merged.slice(0, MAX_HISTORY_VIEW_EVENTS) : merged.slice(-MAX_HISTORY_VIEW_EVENTS)
  const first = events[0]?.seq ?? startSeq
  const last = events.at(-1)?.seq
  return { events, startSeq: first, endSeq: last === undefined ? startSeq : last + 1, hasBefore: first > 0, hasAfter: direction === "after" ? page.events.length === HISTORY_PAGE_SIZE : state.hasAfter || merged.length > events.length }
}
