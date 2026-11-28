import type { HistoryRange, HistoryTurn } from "@i-harness/sdk"

/** seq is the display position after paging. For legacy rows keep their exact
 * stored seq (null means absent) for raw record inspection. */
export type WireEvent = HistoryRange["events"][number] & { historyTurn?: HistoryTurn; historySourceSeq?: number | null }
type LegacyAdmission = Omit<Extract<WireEvent, { type: "agent/input/admitted" }>, "images"> & {
  images: NonNullable<Extract<WireEvent, { type: "user/message" }>["images"]>
}
export type IncomingWireEvent = WireEvent | LegacyAdmission
export type IncomingHistoryPage = Omit<HistoryRange, "events"> & { events: IncomingWireEvent[] }

function isDisplayEvent(event: IncomingWireEvent): event is WireEvent {
  return event.type !== "agent/input/admitted" || !("images" in event)
}

/** Earlier gateways repeated image bytes on the queue admission. Keep only
 * the promoted message's copy in desktop history and live event windows. */
export function displayEvent(event: IncomingWireEvent): WireEvent {
  if (isDisplayEvent(event)) return event
  const { images: _images, ...admission } = event
  return admission
}

export function displayEvents(events: IncomingWireEvent[]): WireEvent[] {
  return events.every(isDisplayEvent) ? events : events.map(displayEvent)
}

/** Keep the small page boundary records with their rows when windows merge,
 * crop or enter the preview cache. The underlying durable events are untouched. */
export function historyEvents(page: IncomingHistoryPage, requestedStart?: number): WireEvent[] {
  const turns = page.turns
  const base = page.nextSeq - page.events.length
  const consistent = Number.isSafeInteger(page.nextSeq) && base >= 0 && (page.startSeq === undefined || page.startSeq === base)
  const positional = consistent && (page.startSeq === base || requestedStart === base ||
    page.events.every((row, index) => row.seq === undefined || row.seq === base + index))
  // Only a returned history range supplies physical positions. The live IPC
  // path never enters here. Transient stream records have no journal address.
  const needsPositions = positional && page.events.some((row, index) => row.seq !== base + index) &&
    !page.events.some(row => row.seq === undefined && (row.type === "reasoning/chunk" || row.type === "model/activity" ||
      (row.type === "assistant/chunk" && (row.stepStartSeq !== undefined || row.offset !== undefined))))
  if (!turns?.length && !needsPositions) return displayEvents(page.events)
  let i = 0
  return page.events.map((incoming, index) => {
    let event = displayEvent(incoming)
    if (needsPositions && event.seq !== base + index) {
      event = { ...event, seq: base + index, historySourceSeq: event.seq ?? null }
    }
    if (!turns?.length || event.seq === undefined) return event
    while (i + 1 < turns.length && turns[i + 1]!.startSeq <= event.seq) i++
    const turn = turns[i]!
    if (turn.startSeq > event.seq || (turn.endSeq !== undefined && turn.endSeq < event.seq)) return event
    return { ...event, historyTurn: turn }
  })
}
