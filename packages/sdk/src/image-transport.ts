import { copyConversationData, type DeepReadonly, type ImageInput, type SessionView as Session, type SessionEventView as SessionEvent } from "@i-harness/core-session"

type Admission = { position: number; event: Extract<SessionEvent, { type: "agent/input/admitted" }> }
type AdmissionIndex = { events: readonly SessionEvent[]; processed: number; lastEvent?: SessionEvent; byId: Map<string, Admission[]> }
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

function earlierImages(index: AdmissionIndex, inputId: string, before: number): readonly DeepReadonly<ImageInput>[] {
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

/** Keep displayed images on user messages and strip their durable copies. */
function copyWireEvents(events: readonly SessionEvent[], imagesFor: (event: Extract<SessionEvent, { type: "user/message" }>, inputId: string) => readonly DeepReadonly<ImageInput>[]): import('@i-harness/core-session').SessionEvent[] {
  return copyConversationData(events.map(event => {
    if (event.type === "agent/input/admitted" && event.images !== undefined) {
      const { images: _images, ...rest } = event
      return rest
    }
    if (event.type === "user/message" && event.imageInputId !== undefined) {
      return { ...event, images: imagesFor(event, event.imageInputId) }
    }
    return event
  }))
}

/** Read images from the existing in-process session, including earlier pages. */
export function transportSessionEvents(session: Session, events: readonly SessionEvent[]): import('@i-harness/core-session').SessionEvent[] {
  let index: AdmissionIndex | undefined
  return copyWireEvents(events, (event, inputId) => {
    const position = event.seq ?? session.events.indexOf(event)
    if (!Number.isSafeInteger(position) || position < 0 || session.events[position] !== event) {
      throw new Error("image admission: user/message position is unavailable")
    }
    index ??= indexFor(session)
    return earlierImages(index, inputId, position)
  })
}

/** The coordinator has already looked up each image's earlier admission. */
export function transportHistoryPageEvents(events: readonly SessionEvent[], images: ReadonlyMap<number, readonly DeepReadonly<ImageInput>[]>): import('@i-harness/core-session').SessionEvent[] {
  return copyWireEvents(events, (event, inputId) => {
    if (event.seq === undefined || !Number.isSafeInteger(event.seq) || event.seq < 0) {
      throw new Error("image admission: user/message position is unavailable")
    }
    const displayed = images.get(event.seq)
    if (!displayed?.length) throw new Error(`image admission not found for user/message: ${inputId}`)
    return displayed
  })
}
