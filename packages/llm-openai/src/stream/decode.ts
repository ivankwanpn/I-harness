import { readSseBlocks, SSEParseError, parseSseFrames, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
import type { createResponseFold } from "./fold.ts"

const doneFrame = Object.freeze({ type: "[DONE]" })

export function parseSSE(text: string): Record<string, unknown>[] {
  return parseSseFrames(text).map(({ data }) => {
    if (data.trim() === "[DONE]") return doneFrame
    try {
      return JSON.parse(data) as Record<string, unknown>
    } catch (err) {
      throw new SSEParseError(data)
    }
  })
}
/** Decode bytes and own the reader lifetime, including early iterator return. */
export async function* decodeResponseStream(body: ReadableStream<Uint8Array>, fold: ReturnType<typeof createResponseFold>, codexSubscription: boolean, request: Pick<LLMRequest, "signal">): AsyncIterable<LLMStreamEvent> {
  const reader = body.getReader()
  const emitEvents = function* (events: LLMStreamEvent[]): Generator<LLMStreamEvent, boolean, unknown> {
    for (const ev of events) {
      if (ev.type === "error") {
        yield ev
        return true
      }
      yield ev
    }
    return false
  }
  try {
    for await (const chunk of readSseBlocks(reader)) {
      for (const event of parseSSE(chunk)) {
        if (event === doneFrame) fold.done()
        else if (yield* emitEvents(fold.handleEvent(event))) return
      }
      if (fold.terminal) break
    }
  } catch (err) {
    // M72 Ⅰ: a corrupt chunk is a provider failure → the seam's error channel.
    // Abort is NOT: an aborted signal keeps today's behaviour (a throw).
    if (request.signal?.aborted === true) throw err
    yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
    return
  } finally {
    if (codexSubscription || fold.terminal) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  yield fold.finish()
}
