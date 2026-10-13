import { reportStreamActivity, describeHttpError, describeTransportError, projectImagesForProvider, type LLMRequest, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"
import type { AnthropicConfig } from "./types.ts"
import { createRequestBody } from "./request/body.ts"
import { fingerprintPrefix } from "./request/messages.ts"
import { mergeConfiguredHeaders } from "./request/headers.ts"
import { createAnthropicFold } from "./stream/fold.ts"
import { decodeAnthropicStream } from "./stream/decode.ts"

export function createAnthropicClient(config: AnthropicConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      // M14 negative capability: text-only routes never see image bytes.
      const vision = config.inputModalities?.includes("image") ?? false
      const messages = await projectImagesForProvider(request.messages, vision, request.signal)
      const prepared = createRequestBody(config, request, messages)
      if ("error" in prepared) {
        yield { type: "error", error: prepared.error }
        return
      }
      const { body, payload } = prepared
      // M62: a TRANSPORT failure (fetch rejects before any HTTP response) used
      // to escape as Node's bare "fetch failed", which cannot distinguish DNS /
      // TCP / TLS / proxy. Surface the cause chain instead.
      let response: Response
      try {
        response = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: mergeConfiguredHeaders(config.headers, { "Content-Type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }),
          body: JSON.stringify(payload),
          // M61: the caller's abort signal reaches the transport — cancel must
          // kill a parked request, not wait for the first event.
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        })
      } catch (error) {
        yield { type: "error", error: await describeTransportError("anthropic", `${baseUrl}/v1/messages`, error) }
        return
      }
      if (!response.ok || !response.body) {
        yield { type: "error", error: await describeHttpError("anthropic", response, request) }
        return
      }
      reportStreamActivity(request, "response-start")
      const fold = createAnthropicFold(config, () => fingerprintPrefix(body.system, body.tools, body.messages), () => reportStreamActivity(request, "tool-arguments"))
      yield* decodeAnthropicStream(response.body, fold, request)
    },
  }
}
