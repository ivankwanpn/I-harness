import { timelineEvents, type EventWindow } from "./event-window.ts"
import { projectTimeline, type TimelineRow } from "./project.ts"

type Inputs = Pick<EventWindow, "events" | "live">
interface Projection { rows: TimelineRow[]; reasoningText?: ReadonlyMap<string, string> }

/** The row's position, turn and disclosure stay stable when its single live
 * fragment grows. A gap, new stream, settlement or replay gets the full fold. */
export function createLiveTimelineProjection() {
  let cached: (Inputs & { rows: TimelineRow[] }) | undefined
  return (input: Inputs): Projection => {
    if (cached && input.events === cached.events && input.live.length === cached.live.length) {
      if (input.live === cached.live) return { rows: cached.rows }
      const texts = new Map<string, string>()
      const sameLayout = input.live.every((event, index) => {
        const original = cached!.live[index]!
        if (event.type !== "reasoning/chunk") return original === event
        const id = "reasoning:" + event.streamId
        if (original.type !== "reasoning/chunk" || texts.has(id) || event.streamId !== original.streamId ||
          event.offset !== original.offset || event.atSeq !== original.atSeq || event.blockId !== original.blockId ||
          Boolean(event.text.trim()) !== Boolean(original.text.trim())) return false
        texts.set(id, event.text)
        return true
      })
      if (sameLayout) return { rows: cached.rows, reasoningText: texts }
    }
    const rows = projectTimeline(timelineEvents(input))
    cached = { ...input, rows }
    return { rows }
  }
}
