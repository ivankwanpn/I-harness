import type { HistoryRange } from "@i-harness/sdk"

type WireEvent = HistoryRange["events"][number]
export type AssistantPreview = Extract<WireEvent, { type: "assistant/chunk" }> & { stepStartSeq: number; offset: number }

/** Join adjacent or overlapping pieces without repeating text. A gap remains
 * separate until its missing piece arrives; no provider text is fabricated. */
export function mergeTextFragments<T extends { offset: number; text: string }>(previous: T, incoming: T): T | undefined {
  const previousEnd = previous.offset + previous.text.length
  const incomingEnd = incoming.offset + incoming.text.length
  if (incoming.offset > previousEnd || previous.offset > incomingEnd) return undefined
  if (incoming.offset >= previous.offset && incomingEnd <= previousEnd) return previous
  const prefix = incoming.offset < previous.offset ? incoming.text.slice(0, previous.offset - incoming.offset) : ""
  const suffix = incomingEnd > previousEnd ? incoming.text.slice(Math.max(0, previousEnd - incoming.offset)) : ""
  return { ...previous, offset: Math.min(previous.offset, incoming.offset), text: prefix + previous.text + suffix }
}

export function isAssistantPreview(event: WireEvent): event is AssistantPreview {
  return event.type === "assistant/chunk" && event.seq === undefined &&
    event.stepStartSeq !== undefined && Number.isSafeInteger(event.stepStartSeq) && event.stepStartSeq >= 0 &&
    event.offset !== undefined && Number.isSafeInteger(event.offset) && event.offset >= 0 &&
    typeof event.text === "string" && event.text.length > 0
}

export function assistantBoundary(event: WireEvent): number {
  switch (event.type) {
    case "assistant/message":
    case "step/start":
    case "step/end":
    case "step/failed":
    case "turn/start":
    case "turn/end":
      return event.seq ?? -1
    default:
      return -1
  }
}

export function updateAssistantPreview(current: AssistantPreview | undefined, event: WireEvent): AssistantPreview | undefined {
  if (!isAssistantPreview(event)) return current && assistantBoundary(event) > current.stepStartSeq ? undefined : current
  if (!current || event.stepStartSeq > current.stepStartSeq) return event
  if (event.stepStartSeq < current.stepStartSeq) return current
  return mergeTextFragments(current, event) ?? current
}

/** Each workspace runtime owns the prefixes of its unfinished assistant replies. */
export function createAssistantPreviews() {
  const active = new Map<string, AssistantPreview>()
  return {
    get: (sessionId: string) => active.get(sessionId),
    finish: (sessionId: string) => { active.delete(sessionId) },
    observe(sessionId: string, event: WireEvent) {
      const previous = active.get(sessionId)
      const next = updateAssistantPreview(previous, event)
      if (next === previous) return
      if (next?.offset === 0) active.set(sessionId, next)
      else active.delete(sessionId)
    },
  }
}
