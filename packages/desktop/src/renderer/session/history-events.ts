import type { HistoryRange, HistoryTurn } from "@i-harness/sdk"

export type WireEvent = HistoryRange["events"][number] & { historyTurn?: HistoryTurn }

/** Keep the small page boundary records with their rows when windows merge,
 * crop or enter the preview cache. The underlying durable events are untouched. */
export function historyEvents(page: HistoryRange): WireEvent[] {
  const turns = page.turns
  if (!turns?.length) return page.events
  let i = 0
  return page.events.map(event => {
    if (event.seq === undefined) return event
    while (i + 1 < turns.length && turns[i + 1]!.startSeq <= event.seq) i++
    const turn = turns[i]!
    if (turn.startSeq > event.seq || (turn.endSeq !== undefined && turn.endSeq < event.seq)) return event
    return { ...event, historyTurn: turn }
  })
}
