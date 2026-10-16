import type { SessionEvent } from './types.ts'
import { validateConversationEventShape } from './conversation.ts'
import { validateImages, type ImageInput, type ImageSummary } from '../images.ts'
import { isContextEventType, validContextEvent } from './context.ts'

type IntakeSession = { readonly formatVersion: number; readonly events: readonly { type: string; inputId?: string; images?: readonly ImageInput[] }[] }

/** The existing event intake contract shared by explicit memory append and
 * owned staging. Only the newly allocated event is normalized. */
export function prepareSessionEvent(session: IntakeSession, event: SessionEvent, seq: number, staged: IntakeSession['events'] = []): SessionEvent {
  if (isContextEventType(event.type) && (session.formatVersion < 2 || !validContextEvent({ ...event, seq }))) throw new Error('invalid operational context event or session format')
  if (event.type === 'model/activity') throw new Error('model/activity must be published as a transient event')
  if (event.type === 'reasoning/chunk') throw new Error('reasoning/chunk must be published as a transient event')
  if (event.type === 'assistant/message' && (event as { source?: string }).source !== undefined) throw new Error('assistant/message must originate from the log, not an external source')
  let imageSummaries: ImageSummary[] | undefined
  if (event.type === 'user/message' && event.imageInputId !== undefined) {
    if (typeof event.imageInputId !== 'string' || event.imageInputId.length === 0 || event.images !== undefined) throw new Error('image reference: user/message needs one non-empty imageInputId and no inline images')
    const matches = (prior: IntakeSession['events'][number]) => prior.type === 'agent/input/admitted' && prior.inputId === event.imageInputId
    const admission = staged.findLast(matches) ?? session.events.findLast(matches)
    if (admission?.type !== 'agent/input/admitted' || !admission.images?.length) throw new Error(`image admission not found for user/message: ${event.imageInputId}`)
    imageSummaries = admission.images.map(({ mediaType, name, width, height, dataBase64 }) => ({
      mediaType, ...(name !== undefined ? { name } : {}), ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}),
      bytes: dataBase64.length * 3 / 4 - (dataBase64.match(/=+$/)?.[0].length ?? 0),
    }))
  }
  const maybeImages = (event as { images?: unknown }).images
  const maybeOutputImages = event.type === 'tool/result' ? (event as { output?: { images?: unknown } }).output?.images : undefined
  for (const images of [maybeImages, maybeOutputImages]) if (images !== undefined) {
    if (!Array.isArray(images)) throw new Error('image attachment: images must be an array')
    validateImages(images as ImageInput[], event.type)
  }
  const prepared = { ...event, ...(imageSummaries !== undefined ? { imageSummaries } : {}), seq }
  validateConversationEventShape(prepared, session.formatVersion)
  return prepared
}
