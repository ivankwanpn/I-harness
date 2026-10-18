import type { SessionEventView } from '../managed/types.ts'

/** Payload access only; structural grouping belongs to the history index. */
export interface ConversationEventArchive {
  readonly length: number
  get(index: number): SessionEventView
}

function checkIndex(index: number, length: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new RangeError('Conversation archive index out of bounds')
}

export function eventArchive(events: readonly SessionEventView[]): ConversationEventArchive {
  const length = events.length
  return Object.freeze({ length, get(index: number) { checkIndex(index, length); return events[index]! } })
}

export function extendedEventArchive(base: ConversationEventArchive, suffix: readonly SessionEventView[]): ConversationEventArchive {
  const baseCount = base.length, length = baseCount + suffix.length
  return Object.freeze({ length, get(index: number) {
    checkIndex(index, length)
    return index < baseCount ? base.get(index) : suffix[index - baseCount]!
  } })
}
