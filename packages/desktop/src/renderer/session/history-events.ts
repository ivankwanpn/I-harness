import type { HistoryRange, HistoryTurn } from "@i-harness/sdk"

export type WireEvent = HistoryRange["events"][number] & { historyTurn?: HistoryTurn }
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
export function historyEvents(page: IncomingHistoryPage): WireEvent[] {
  const turns = page.turns
  if (!turns?.length) return displayEvents(page.events)
  let i = 0
  return page.events.map(incoming => {
    const event = displayEvent(incoming)
    if (event.seq === undefined) return event
    while (i + 1 < turns.length && turns[i + 1]!.startSeq <= event.seq) i++
    const turn = turns[i]!
    if (turn.startSeq > event.seq || (turn.endSeq !== undefined && turn.endSeq < event.seq)) return event
    return { ...event, historyTurn: turn }
  })
}
