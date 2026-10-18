import { SSEParseError, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
import type { createResponseFold } from "./fold.ts"

export function parseSSE(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))!
      const data = dataLine.slice(5).trim()
      if (data === "[DONE]") return { type: "[DONE]" }
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
  const decoder = new TextDecoder()
  let buffer = ""
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
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // split on SSE boundaries; each data: line is one event
      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""
      for (const chunk of chunks) {
        if (fold.receivedDone) break
        for (const event of parseSSE(chunk)) {
          if (fold.receivedDone) break
          if (yield* emitEvents(fold.handleEvent(event))) return
        }
      }
      if (fold.receivedDone) break
    }
    // flush any residual partial chunk left in the buffer
    if (buffer.trim() !== "") {
      for (const event of parseSSE(buffer)) {
        if (fold.receivedDone) break
        if (yield* emitEvents(fold.handleEvent(event))) return
      }
    }
  } catch (err) {
    // M72 Ⅰ: a corrupt chunk is a provider failure → the seam's error channel.
    // Abort is NOT: an aborted signal keeps today's behaviour (a throw).
    if (request.signal?.aborted === true) throw err
    yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
    return
  } finally {
    if (codexSubscription) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  yield fold.finish()
}
