import { decodeModelSse, SSEParseError, parseSseFrames, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
import type { GeminiConfig } from "../types.ts"
import { createGeminiFold } from "./fold.ts"

export function parseSSE(text: string): Record<string, unknown>[] {
  const frames = parseSseFrames(text)
  // Google's SDK also handles a bare JSON error after the stream opened.
  // Inspect the assembled block so splitting UTF-8/JSON across reads is safe.
  if (!frames.length && text.trimStart().startsWith('{')) {
    const value = parseObject(text)
    return Object.hasOwn(value,'error') ? [value] : []
  }
  return frames.map(({ data, event }) => {
    if (event === 'error') {
      try {
        const value = parseObject(data)
        return { ...value, error: Object.hasOwn(value,'error') ? value.error ?? {} : value }
      } catch { return {error:{}} }
    }
    if (data.trim() === "[DONE]") return { type: "[DONE]" }
    return parseObject(data)
  })
}

function parseObject(data: string): Record<string,unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(data) } catch { throw new SSEParseError(data) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SSEParseError(data)
  return parsed as Record<string,unknown>
}

/** Own byte/SSE buffers and reader cleanup; release precedes the end event. */
export function decodeGeminiStream(body: ReadableStream<Uint8Array>, request: LLMRequest, config: GeminiConfig): AsyncIterable<LLMStreamEvent> {
  const fold = createGeminiFold(request, config)
  return decodeModelSse(body, request, block => {
    const [event] = parseSSE(block)
    return event ? fold.handleChunk(event) : []
  }, function* () {
    if (!(yield* fold.finalizeCalls())) yield fold.finish()
  })
}
