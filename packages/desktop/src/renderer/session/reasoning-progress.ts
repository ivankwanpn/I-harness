import { mergeTextFragments } from "../../shared/assistant-preview.ts"
import type { HistoryRange } from "@i-harness/sdk"

export type ReasoningChunk = Extract<HistoryRange["events"][number], { type: "reasoning/chunk" }>

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
