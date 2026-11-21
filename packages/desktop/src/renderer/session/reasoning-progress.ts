import type { HistoryRange } from "@i-harness/sdk"

export type ReasoningChunk = Extract<HistoryRange["events"][number], { type: "reasoning/chunk" }>

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

export function mergeReasoningChunks(previous: ReasoningChunk, incoming: ReasoningChunk): ReasoningChunk | undefined {
  return previous.streamId === incoming.streamId ? mergeTextFragments(previous, incoming) : undefined
}

/** Update the collapsed preview only when a paragraph boundary arrives. */
export function reasoningPreview(text: string): string | undefined {
  const paragraphs = text.split(/\r?\n(?:[ \t]*\r?\n)+/)
  paragraphs.pop()
  const paragraph = paragraphs.findLast(block => block.trim())
  const firstLine = paragraph?.trim().split(/\r?\n/, 1)[0]?.replace(/^#{1,6}\s+/, "").trim()
  return firstLine ? firstLine.slice(0, 240) : undefined
}
