import { decodeModelSse, SSEParseError, parseSseBlock, parseSseFrames, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
import type { createResponseFold } from "./fold.ts"

const doneFrame = Object.freeze({ type: "[DONE]" })

function parseEvent(data: string): Record<string, unknown> {
  if (data.trim() === "[DONE]") return doneFrame
  try { return JSON.parse(data) as Record<string, unknown> }
  catch { throw new SSEParseError(data) }
}
export function parseSSE(text: string): Record<string, unknown>[] {
  return parseSseFrames(text).map(frame => parseEvent(frame.data))
}
export function decodeResponseStream(body: ReadableStream<Uint8Array>, fold: ReturnType<typeof createResponseFold>, request: Pick<LLMRequest, "signal">): AsyncIterable<LLMStreamEvent> {
  return decodeModelSse(body, request, block => {
    const frame = parseSseBlock(block)
    if (!frame) return []
    const event = parseEvent(frame.data)
    return event === doneFrame ? fold.done() : fold.handleEvent(event)
  }, () => [fold.finish()], () => fold.terminal)
}
