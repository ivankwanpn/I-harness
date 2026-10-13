import { reportStreamActivity, describeHttpError, describeTransportError, projectImagesForProvider, type LLMRequest, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"
import type { OpenAICompatibleConfig } from "./types.ts"
import { createRequestBody } from "./request/body.ts"
import { mergeConfiguredHeaders } from "./request/headers.ts"
import { createChatFold } from "./stream/fold.ts"
import { decodeChatStream } from "./stream/decode.ts"

export function createOpenAICompatibleClient(config: OpenAICompatibleConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.openai.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      // M14 negative capability: text-only routes never see image bytes.
      const messages = await projectImagesForProvider(request.messages, config.inputModalities?.includes("image") ?? false, request.signal)
      const body = createRequestBody(config, request, messages)
      // M62: a TRANSPORT failure (fetch rejects before any HTTP response) used
      // to escape as Node's bare "fetch failed", which cannot distinguish DNS /
      // TCP / TLS / proxy. Surface the cause chain instead.
      let response: Response
      try {
        response = await (config.fetch ?? globalThis.fetch)(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: mergeConfiguredHeaders(config.headers, { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` }),
          body: JSON.stringify(body),
          // M61: the caller's abort signal reaches the transport — cancel must
          // kill a parked request, not wait for the first event.
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        })
      } catch (error) {
        yield { type: "error", error: await describeTransportError("openai-compatible", `${baseUrl}/v1/chat/completions`, error) }
        return
      }
      if (!response.ok || !response.body) {
        yield { type: "error", error: await describeHttpError("openai-compatible", response, request) }
        return
      }
      reportStreamActivity(request, "response-start")
      const fold = createChatFold(config, request)
      yield* decodeChatStream(response.body, fold, request)
    },
  }
}
