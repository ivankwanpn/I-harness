import { decodeModelSse, SSEParseError, parseSseFrames, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
import type { createAnthropicFold } from "./fold.ts"

export function parseSSE(text: string): Record<string, unknown>[] {
  return parseSseFrames(text).map(({ data }) => {
    if (data.trim() === "[DONE]") return { type: "[DONE]" }
    try {
      return JSON.parse(data) as Record<string, unknown>
    } catch (err) {
      throw new SSEParseError(data)
    }
  })
}
/** Release the transport as soon as the message's terminal event arrives. */
export function decodeAnthropicStream(body: ReadableStream<Uint8Array>, fold: ReturnType<typeof createAnthropicFold>, request: Pick<LLMRequest, "signal">): AsyncIterable<LLMStreamEvent> {
  return decodeModelSse(body, request, block => {
    const events = parseSSE(block)
    return events.length ? fold.handleEvent(events[0]!) : []
  }, () => [fold.finish()], () => fold.terminal)
}
