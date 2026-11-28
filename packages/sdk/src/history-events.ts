import { copyConversationData, validateImages, type DeepReadonly, type ImageInput, type SessionEvent } from '@i-harness/core-session'

type Admission = Extract<SessionEvent, { type: 'agent/input/admitted' }>
type UserMessage = Extract<SessionEvent, { type: 'user/message' }>

/** The SDK displays image bytes on the promoted message, including when its
 * admission is outside the requested page. Pending admissions omit image bytes. */
export type SessionDisplayEvent =
  | Exclude<SessionEvent, Admission | UserMessage>
  | (Omit<Admission, 'images'> & { images?: never })
  | (Omit<UserMessage, 'imageInputId'> & { imageInputId?: never })
  | (Omit<UserMessage, 'imageInputId' | 'images'> & { imageInputId: string; images: ImageInput[] })

const imageFields = ['mediaType', 'dataBase64', 'name', 'width', 'height', 'attachmentId'] as const

/** Rebuild image references for conversation projection from a complete,
 * ordered display history. This only restores promoted image data. It cannot
 * recover redacted pending/cancelled images, a session header or journal frames. */
export function restorePromotedHistoryImages(displayEvents: readonly DeepReadonly<SessionDisplayEvent>[]): SessionEvent[] {
  const events: SessionEvent[] = copyConversationData(displayEvents)
  const admissions = new Map<string, Admission>()
  for (const [index, event] of events.entries()) {
    if (event.type === 'agent/input/admitted') {
      if (event.images !== undefined) throw new TypeError('Expected a display admission without image bytes')
      admissions.set(event.inputId, event)
      continue
    }
    if (event.type !== 'user/message' || event.imageInputId === undefined) continue
    const admission = admissions.get(event.imageInputId)
    if (!admission || !event.images?.length) throw new TypeError('Restoring a displayed image requires its earlier admission and promoted bytes')
    const { images, ...reference } = event
    validateImages(images, 'user/message')
    if (admission.images && (admission.images.length !== images.length ||
      !admission.images.every((image, i) => imageFields.every(key => image[key] === images[i]![key])))) {
      throw new TypeError('Conflicting promoted images for the same admission')
    }
    admission.images = images
    events[index] = reference
  }
  return events
}
