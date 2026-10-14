import { preparedModelClient, snapshotModelData, createPreparedPayload, reportStreamActivity, describeHttpError, describeTransportError, projectImagesForProvider, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"
import type { OpenAICompatibleConfig } from "./types.ts"
import { createRequestBody } from "./request/body.ts"
import { mergeConfiguredHeaders } from "./request/headers.ts"
import { createChatFold } from "./stream/fold.ts"
import { decodeChatStream } from "./stream/decode.ts"

import { describeContext, outputFacts } from "./context.ts"

export function createOpenAICompatibleClient(config: OpenAICompatibleConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.openai.com"
  return preparedModelClient(async originalRequest => {
    const request = snapshotModelData(originalRequest)
    const capturedConfig = snapshotModelData(config)
    request.signal?.throwIfAborted()
    // M14 negative capability: text-only routes never see image bytes.
    const messages = await projectImagesForProvider(request.messages, capturedConfig.inputModalities?.includes("image") ?? false, request.signal)
    const body = createRequestBody(capturedConfig, request, messages)
    request.signal?.throwIfAborted()
    const capturedRequest = request
    const facts = describeContext(body, capturedConfig)
    return createPreparedPayload({
      body: body, request, ...facts,
      output: (body, request) => outputFacts(body, request, capturedConfig),
      cap: (body, cap) => {
        const field = capturedConfig.maxTokensField ?? "max_tokens"
        delete body[field]
        const value = cap ?? capturedConfig.options?.[field]
        if (value !== undefined) body[field] = value
        return body
      },
      async *execute(_actualBody, serialized, control): AsyncIterable<LLMStreamEvent> {
        const request = { ...capturedRequest, ...control }
        // M62: a TRANSPORT failure (fetch rejects before any HTTP response) used
        // to escape as Node's bare "fetch failed", which cannot distinguish DNS /
        // TCP / TLS / proxy. Surface the cause chain instead.
        let response: Response
        try {
          response = await (capturedConfig.fetch ?? globalThis.fetch)(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: mergeConfiguredHeaders(capturedConfig.headers, { "Content-Type": "application/json", Authorization: `Bearer ${capturedConfig.apiKey}` }),
            body: serialized,
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
        const fold = createChatFold(capturedConfig, request)
        yield* decodeChatStream(response.body, fold, request)
      },
    })
  })
}
