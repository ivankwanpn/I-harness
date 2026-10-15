import { CURRENT_FORMAT_VERSION } from "./types.ts"
import type { Session, SessionEvent } from "./types.ts"
import { appendHooks, subscribers, conversationIndexes } from "./state.ts"
import { createConversationIndex } from "../conversation/validation.ts"
import { validateConversationEventShape } from "./conversation.ts"
import { validateImages } from "../images.ts"
import type { ImageInput, ImageSummary } from "../images.ts"
import { isContextEventType, validContextEvent } from "./context.ts"

export function createSession(onAppend?: (ev: SessionEvent) => void): Session {
  const session: Session = { formatVersion: CURRENT_FORMAT_VERSION, events: [] }
  if (onAppend) appendHooks.set(session, onAppend)
  return session
}

export function append(session: Session, event: SessionEvent): void {
  if (isContextEventType(event.type) && (session.formatVersion < 2 || !validContextEvent({ ...event, seq: session.events.length }))) throw new Error("invalid operational context event or session format")
  if (event.type === "model/activity") throw new Error("model/activity must be published as a transient event")
  if (event.type === "reasoning/chunk") throw new Error("reasoning/chunk must be published as a transient event")
  if (event.type === "assistant/message" && (event as { source?: string }).source !== undefined) {
    throw new Error("assistant/message must originate from the log, not an external source")
  }
  let imageSummaries: ImageSummary[] | undefined
  if (event.type === "user/message" && event.imageInputId !== undefined) {
    if (typeof event.imageInputId !== "string" || event.imageInputId.length === 0 || event.images !== undefined) {
      throw new Error("image reference: user/message needs one non-empty imageInputId and no inline images")
    }
    const admission = session.events.findLast((prior) => prior.type === "agent/input/admitted" && prior.inputId === event.imageInputId)
    if (admission?.type !== "agent/input/admitted" || !admission.images?.length) {
      throw new Error(`image admission not found for user/message: ${event.imageInputId}`)
    }
    imageSummaries = admission.images.map(({ mediaType, name, width, height, dataBase64 }) => ({
      mediaType,
      ...(name !== undefined ? { name } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      bytes: dataBase64.length * 3 / 4 - (dataBase64.match(/=+$/)?.[0].length ?? 0),
    }))
  }
  // M14 image intake (fail-loud): images first attach to an event here, so this
  // is the boundary that validates them. deriveMessages stays a pure projection.
  const maybeImages = (event as { images?: unknown }).images
  const maybeOutputImages = event.type === "tool/result"
    ? (event as { output?: { images?: unknown } }).output?.images
    : undefined
  if (maybeImages !== undefined) {
    if (!Array.isArray(maybeImages)) throw new Error("image attachment: images must be an array")
    validateImages(maybeImages as ImageInput[], event.type)
  }
  if (maybeOutputImages !== undefined) {
    if (!Array.isArray(maybeOutputImages)) throw new Error("image attachment: images must be an array")
    validateImages(maybeOutputImages as ImageInput[], event.type)
  }
  const ev = { ...event, ...(imageSummaries !== undefined ? { imageSummaries } : {}), seq: session.events.length }
  validateConversationEventShape(ev, session.formatVersion)
  let cached = conversationIndexes.get(session)
  if (!cached || cached.formatVersion !== session.formatVersion || cached.events !== session.events || cached.index.eventCount !== session.events.length) {
    cached = { formatVersion: session.formatVersion, events: session.events, index: createConversationIndex(session.events, index => session.events[index], session.formatVersion) }
    conversationIndexes.set(session, cached)
  }
  const staged = cached.index.stage([ev])
  session.events.push(ev)
  staged.commit()
  appendHooks.get(session)?.(ev)
  subscribers.get(session)?.forEach((l) => l(ev))
}
