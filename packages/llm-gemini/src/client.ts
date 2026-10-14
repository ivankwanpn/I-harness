import { preparedModelClient, snapshotModelData, createPreparedPayload, reportStreamActivity, describeHttpError, describeTransportError, projectImagesForProvider, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"
import type { GeminiConfig } from "./types.ts"
import { toGeminiContents } from "./request/messages.ts"
import { createRequestBody } from "./request/body.ts"
import { mergeConfiguredHeaders } from "./request/headers.ts"
import { decodeGeminiStream } from "./stream/decode.ts"

import { describeContext, outputFacts } from "./context.ts"

export function createGeminiClient(config: GeminiConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com"
  return preparedModelClient(async originalRequest => {
    const request = snapshotModelData(originalRequest)
    const capturedConfig = snapshotModelData(config, ["baseUrl"])
    request.signal?.throwIfAborted()
    // M14 negative capability: text-only routes never see image bytes.
    const vision = capturedConfig.inputModalities?.includes("image") ?? false
    const messages = await projectImagesForProvider(request.messages, vision, request.signal)
    const contents = toGeminiContents(messages, capturedConfig)
    const body = createRequestBody(request, capturedConfig, contents)
    request.signal?.throwIfAborted()
    const capturedRequest = request
    const facts = describeContext(body, capturedConfig)
    return createPreparedPayload({
      body: body, request, ...facts,
      output: (body, request) => outputFacts(body, request, capturedConfig),
      cap: (body, cap) => {
        const generation = { ...(body.generationConfig as Record<string, unknown> ?? {}) }
        delete generation.maxOutputTokens
        const raw = capturedConfig.options?.generationConfig as Record<string, unknown> | undefined
        const value = cap ?? raw?.maxOutputTokens
        if (value !== undefined) generation.maxOutputTokens = value
        if (Object.keys(generation).length) body.generationConfig = generation
        else delete body.generationConfig
        return body
      },
      async *execute(_actualBody, serialized, control): AsyncIterable<LLMStreamEvent> {
        const request = { ...capturedRequest, ...control }
        // M62: a TRANSPORT failure (fetch rejects before any HTTP response) used
        // to escape as Node's bare "fetch failed", which cannot distinguish DNS /
        // TCP / TLS / proxy. Surface the cause chain instead.
        const geminiUrl = `${baseUrl}/v1beta/models/${encodeURIComponent(capturedConfig.model)}:streamGenerateContent?alt=sse`
        let response: Response
        try {
          response = await fetch(geminiUrl, {
            method: "POST",
            headers: mergeConfiguredHeaders(capturedConfig.headers, { "Content-Type": "application/json", "x-goog-api-key": capturedConfig.apiKey }),
            body: serialized,
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
        yield* decodeGeminiStream(response.body, request, capturedConfig)
      },
    })
  })
}
