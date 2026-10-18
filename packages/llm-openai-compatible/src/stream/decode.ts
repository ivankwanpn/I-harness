import { SSEParseError, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
import { emit, type createChatFold } from "./fold.ts"

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

/** Own one response reader, UTF-8 decoder and residual frame buffer. */
export async function* decodeChatStream(body: ReadableStream<Uint8Array>, fold: ReturnType<typeof createChatFold>, request: LLMRequest): AsyncIterable<LLMStreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let receivedDone = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""
      for (const chunk of chunks) {
        if (receivedDone) break
        for (const event of parseSSE(chunk)) {
          if (receivedDone) break
          const frame = fold.handleFrame(event)
          if (frame.done) {
            receivedDone = true
            break
          }
          if (yield* emit(frame.events)) return
          if (yield* fold.flushParsedToolCalls()) return
        }
      }
      if (receivedDone) break
    }
    // flush residual buffer
    if (buffer.trim() !== "") {
      for (const event of parseSSE(buffer)) {
        if (receivedDone) break
        const frame = fold.handleFrame(event)
        if (frame.done) {
          receivedDone = true
          break
        }
        if (yield* emit(frame.events)) return
        if (yield* fold.flushParsedToolCalls()) return
      }
    }
    if (yield* fold.finishToolCalls()) return
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
