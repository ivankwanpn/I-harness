import { reportStreamActivity, describeHttpError, describeTransportError, projectImagesForProvider, type LLMRequest, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"
import type { GeminiConfig } from "./types.ts"
import { toGeminiContents } from "./request/messages.ts"
import { createRequestBody } from "./request/body.ts"
import { mergeConfiguredHeaders } from "./request/headers.ts"
import { decodeGeminiStream } from "./stream/decode.ts"

export function createGeminiClient(config: GeminiConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      // M14 negative capability: text-only routes never see image bytes.
      const vision = config.inputModalities?.includes("image") ?? false
      const messages = await projectImagesForProvider(request.messages, vision, request.signal)
      const contents = toGeminiContents(messages, config)
      const body = createRequestBody(request, config, contents)
      // M62: a TRANSPORT failure (fetch rejects before any HTTP response) used
      // to escape as Node's bare "fetch failed", which cannot distinguish DNS /
      // TCP / TLS / proxy. Surface the cause chain instead.
      const geminiUrl = `${baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`
      let response: Response
      try {
        response = await fetch(geminiUrl, {
          method: "POST",
          headers: mergeConfiguredHeaders(config.headers, { "Content-Type": "application/json", "x-goog-api-key": config.apiKey }),
          body: JSON.stringify(body),
          // M61: the caller's abort signal reaches the transport — cancel must
          // kill a parked request, not wait for the first event.
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        })
      } catch (error) {
        yield { type: "error", error: await describeTransportError("gemini", geminiUrl, error) }
        return
      }
      if (!response.ok || !response.body) {
        yield { type: "error", error: await describeHttpError("gemini", response, request) }
        return
      }
      reportStreamActivity(request, "response-start")
      yield* decodeGeminiStream(response.body, request, config)
    },
  }
}
