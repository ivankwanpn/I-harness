import { decodeModelSse, SSEParseError, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
import type { createChatFold } from "./fold.ts"

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
export function decodeChatStream(body: ReadableStream<Uint8Array>, fold: ReturnType<typeof createChatFold>, request: LLMRequest): AsyncIterable<LLMStreamEvent> {
  let receivedDone = false
  return decodeModelSse(body, request, block => {
    const [event] = parseSSE(block)
    if (event === doneFrame) receivedDone = true
    return event && !receivedDone ? fold.handleFrame(event) : []
  }, () => fold.finish(receivedDone), () => receivedDone)
}
