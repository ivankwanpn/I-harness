import type { ImageInput, Session, SessionEvent } from "@i-harness/core-session"

/** Give SDK readers the displayed image without sending its recovery copy.
 * The durable admission still owns the bytes; this produces fresh wire events
 * and never mutates session.events. Pages may start after the admission. */
export function transportSessionEvents(session: Session, events: readonly SessionEvent[]): SessionEvent[] {
  const needed = new Map<number, string>()
  for (const event of events) {
    if (event.type !== "user/message" || event.imageInputId === undefined) continue
    const position = event.seq ?? session.events.indexOf(event)
    if (!Number.isSafeInteger(position) || position < 0 || session.events[position] !== event) {
      throw new Error("image admission: user/message position is unavailable")
    }
    needed.set(position, event.imageInputId)
  }
  const hydrated = new Map<number, ImageInput[]>()
  if (needed.size > 0) {
    const admissions = new Map<string, ImageInput[]>()
    let last = 0
    for (const position of needed.keys()) last = Math.max(last, position)
    for (let index = 0; index <= last; index += 1) {
      const event = session.events[index]!
      if (event.type === "agent/input/admitted") {
        if (event.images?.length) admissions.set(event.inputId, event.images)
        else admissions.delete(event.inputId)
      }
      const inputId = needed.get(index)
      if (inputId !== undefined) {
        const images = admissions.get(inputId)
        if (!images?.length) throw new Error(`image admission not found for user/message: ${inputId}`)
        hydrated.set(index, images)
      }
    }
  }
  return events.map((event) => {
    if (event.type === "agent/input/admitted" && event.images !== undefined) {
      const { images: _images, ...rest } = event
      return rest
    }
    if (event.type === "user/message" && event.imageInputId !== undefined) {
      const position = event.seq ?? session.events.indexOf(event)
      return { ...event, images: hydrated.get(position)! }
    }
    return event
  })
}
