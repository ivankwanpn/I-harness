import { SSEParseError, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
import type { GeminiConfig } from "../types.ts"
import { createGeminiFold } from "./fold.ts"

export function parseSSE(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))!
      const data = dataLine.slice(5).trim()
      try {
        return JSON.parse(data) as Record<string, unknown>
      } catch (err) {
        throw new SSEParseError(data)
      }
    })
}

const emit = function* (events: LLMStreamEvent[]): Generator<LLMStreamEvent, boolean, unknown> {
  for (const ev of events) {
    if (ev.type === "error") {
      yield ev
      return true
    }
    yield ev
  }
  return false
}

/** Own byte/SSE buffers and reader cleanup; release precedes the end event. */
export async function* decodeGeminiStream(body: ReadableStream<Uint8Array>, request: LLMRequest, config: GeminiConfig): AsyncIterable<LLMStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const fold = createGeminiFold(request, config)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""
      for (const chunk of chunks) {
        for (const event of parseSSE(chunk)) {
          if (yield* emit(fold.handleChunk(event))) return
        }
      }
    }
    if (buffer.trim() !== "") {
      for (const event of parseSSE(buffer)) {
        if (yield* emit(fold.handleChunk(event))) return
      }
    }
    if (yield* fold.finalizeCalls()) return
  } catch (err) {
    // M72 Ⅰ: a corrupt chunk is a provider failure → the seam's error channel.
    // Abort is NOT: an aborted signal keeps today's behaviour (a throw).
    if (request.signal?.aborted === true) throw err
    yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
    return
  } finally {
    reader.releaseLock()
  }
  yield fold.finish()
}
