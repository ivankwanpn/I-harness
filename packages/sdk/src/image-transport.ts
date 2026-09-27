import type { ImageInput, Session, SessionEvent } from "@i-harness/core-session"

type Admission = { position: number; event: Extract<SessionEvent, { type: "agent/input/admitted" }> }
type AdmissionIndex = { events: SessionEvent[]; processed: number; lastEvent?: SessionEvent; byId: Map<string, Admission[]> }
const indexes = new WeakMap<Session, AdmissionIndex>()

/** Build once per live/cold session and extend only for new append-only events.
 * History pages therefore do not each scan the same long prefix. Buckets keep
 * repeated input IDs in source order so lookup chooses the latest EARLIER one. */
function indexFor(session: Session): AdmissionIndex {
  let index = indexes.get(session)
  if (!index || index.events !== session.events || index.processed > session.events.length
    || (index.processed > 0 && session.events[index.processed - 1] !== index.lastEvent)) {
    index = { events: session.events, processed: 0, byId: new Map() }
    indexes.set(session, index)
  }
  for (let position = index.processed; position < session.events.length; position += 1) {
    const event = session.events[position]!
    if (event.type !== "agent/input/admitted") continue
    const admissions = index.byId.get(event.inputId) ?? []
    admissions.push({ position, event })
    index.byId.set(event.inputId, admissions)
  }
  index.processed = session.events.length
  index.lastEvent = session.events.at(-1)
  return index
}

function earlierImages(index: AdmissionIndex, inputId: string, before: number): ImageInput[] {
  const admissions = index.byId.get(inputId) ?? []
  let low = 0, high = admissions.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (admissions[middle]!.position < before) low = middle + 1
    else high = middle
  }
  const images = admissions[low - 1]?.event.images
  if (!images?.length) throw new Error(`image admission not found for user/message: ${inputId}`)
  return images
}

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
    const index = indexFor(session)
    for (const [position, inputId] of needed) hydrated.set(position, earlierImages(index, inputId, position))
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
