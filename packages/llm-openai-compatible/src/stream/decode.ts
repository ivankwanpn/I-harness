import { readSseBlocks, SSEParseError, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
import { emit, type createChatFold } from "./fold.ts"

const doneFrame = Object.freeze({ type: "[DONE]" })

export function parseSSE(text: string): Record<string, unknown>[] {
  return text.replace(/\r\n|\r/g, '\n')
    .split("\n\n")
    .flatMap((chunk) => {
      const lines = chunk.split('\n')
      const field = (line: string, name: string) => line === name ? '' : line.slice(name.length + 1).replace(/^ /, '')
      const data = lines.filter(line => line === 'data' || line.startsWith('data:')).map(line => field(line, 'data')).join('\n')
      const eventName = lines.filter(line => line.startsWith('event:')).map(line => field(line, 'event')).at(-1)
      if (!data && eventName !== 'error') return []
      if (data.trim() === "[DONE]" && eventName !== 'error') return [doneFrame]
      try {
        const parsed: unknown = JSON.parse(data)
        // The named SSE error carrier can contain either an error envelope or
        // a flat diagnostic (openai-node Stream.fromSSEResponse).
        if (eventName === 'error') {
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const record = parsed as Record<string, unknown>
            return [{ ...record, error: record.error ?? (Object.hasOwn(record, 'error') ? {} : record) }]
          }
          return [{ error: parsed ?? {} }]
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SSEParseError(data)
        return [parsed as Record<string, unknown>]
      } catch (err) {
        throw new SSEParseError(data)
      }
    })
}

/** Own one response reader, UTF-8 decoder and residual frame buffer. */
export async function* decodeChatStream(body: ReadableStream<Uint8Array>, fold: ReturnType<typeof createChatFold>, request: LLMRequest): AsyncIterable<LLMStreamEvent> {
  const reader = body.getReader()
  let receivedDone = false
  const dispatch = function* (text: string): Generator<LLMStreamEvent, boolean, unknown> {
    for (const event of parseSSE(text)) {
      if (event === doneFrame) { receivedDone = true; return true }
      if (yield* emit(fold.handleFrame(event))) return true
    }
    return false
  }
  try {
    for await (const chunk of readSseBlocks(reader)) {
      if (yield* dispatch(chunk)) {
        if (receivedDone) break
        return
      }
    }
  } catch (err) {
    // M72 Ⅰ: a corrupt chunk is a provider failure → the seam's error channel.
    // Abort is NOT: an aborted signal keeps today's behaviour (a throw).
    if (request.signal?.aborted === true) throw err
    yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
    return
  } finally {
    // Error/DONE/consumer return ends ownership even if upstream keeps the
    // connection open. Cancellation must not wait for producer cooperation.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  yield* fold.finish(receivedDone)
}
