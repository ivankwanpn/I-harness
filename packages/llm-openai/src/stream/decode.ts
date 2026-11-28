import { forwardSseEvents, readSseBlocks, SSEParseError, parseSseBlock, parseSseFrames, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
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
export async function* decodeResponseStream(body: ReadableStream<Uint8Array>, fold: ReturnType<typeof createResponseFold>, request: Pick<LLMRequest, "signal">): AsyncIterable<LLMStreamEvent> {
  try {
    let finalEvents: LLMStreamEvent[] = []
    for await (const block of readSseBlocks(body)) {
      const frame = parseSseBlock(block)
      if (!frame) continue
      const event = parseEvent(frame.data)
      const events = event === doneFrame ? fold.done() : fold.handleEvent(event)
      if (fold.terminal) {
        finalEvents = events
        break
      }
      for (const streamed of forwardSseEvents(events)) yield streamed
    }
    // A consumer may pause on usage or text from the final snapshot.
    // Release the HTTP response before exposing any part of that snapshot.
    for (const event of forwardSseEvents(finalEvents)) {
      if (event.type !== "usage") request.signal?.throwIfAborted()
      yield event
    }
    request.signal?.throwIfAborted()
  } catch (err) {
    // M72 Ⅰ: a corrupt chunk is a provider failure → the seam's error channel.
    // Abort is NOT: an aborted signal keeps today's behaviour (a throw).
    if (request.signal?.aborted === true) throw err
    yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
    return
  }
  yield fold.finish()
}
