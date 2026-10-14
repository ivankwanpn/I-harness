import { preparedModelClient, snapshotModelData, createPreparedPayload, reportStreamActivity, projectImagesForProvider, describeHttpError, describeTransportError, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"
import { systemFetch } from "@i-harness/http-transport"
import { createSubscriptionAffinity } from "./affinity.ts"
import type { OpenAIConfig } from "./types.ts"
import { createRequestBody } from "./request/body.ts"
import { mergeConfiguredHeaders } from "./request/headers.ts"
import { createResponseFold } from "./stream/fold.ts"
import { decodeResponseStream } from "./stream/decode.ts"

import { describeContext, outputFacts } from "./context.ts"

export function createOpenAIClient(config: OpenAIConfig): ModelClient {
  const codexSubscription = config.codexSubscription === true
  if (codexSubscription && config.baseUrl !== undefined && !/^https:\/\/chatgpt\.com\/backend-api\/codex\/?$/.test(config.baseUrl)) {
    throw new Error("Codex subscription credentials require the official Codex Responses endpoint")
  }
  if (codexSubscription && Object.keys(config.headers ?? {}).length > 0) {
    throw new Error("Codex subscription requests do not support configurable headers")
  }
  const endpoint = codexSubscription ? "https://chatgpt.com/backend-api/codex/responses" : `${config.baseUrl ?? "https://api.openai.com"}/v1/responses`
  const affinity = codexSubscription ? createSubscriptionAffinity() : undefined
  return preparedModelClient(async originalRequest => {
    const request = snapshotModelData(originalRequest)
    const capturedConfig = snapshotModelData(config)
    request.signal?.throwIfAborted()
    const scope = request.requestScope
    // A raw JS caller can mutate despite readonly types. Keep this attempt's
    // identity consistent across image projection and asynchronous auth.
    const scopeIdentity = scope === undefined ? undefined : { ...scope }
    // M14 negative capability: text-only routes never see image bytes.
    const vision = capturedConfig.inputModalities?.includes("image") ?? false
    const messages = await projectImagesForProvider(request.messages, vision, request.signal)
    const { body, cacheMode } = createRequestBody(capturedConfig, request, messages, codexSubscription,
      affinity && scopeIdentity ? () => affinity.cacheKey(scopeIdentity) : undefined)
    request.signal?.throwIfAborted()
    const capturedRequest = request
    const facts = describeContext(body, capturedConfig, codexSubscription)
    return createPreparedPayload({
      body: body, request, ...facts,
      output: (body, request) => outputFacts(body, request, capturedConfig, codexSubscription),
      cap: (body, cap) => {
        if (codexSubscription) return body
        delete body.max_output_tokens
        const value = cap ?? capturedConfig.options?.max_output_tokens
        if (value !== undefined) body.max_output_tokens = value
        return body
      },
      async *execute(_actualBody, serialized, control): AsyncIterable<LLMStreamEvent> {
        const request = { ...capturedRequest, ...control }
        let accessToken: string
        let accountId: string | undefined
        try {
          request.signal?.throwIfAborted()
          if (codexSubscription && !capturedConfig.resolveCodexAuth) throw new Error("Codex subscription account credentials are unavailable")
          if (codexSubscription) {
            const auth = await capturedConfig.resolveCodexAuth!(request.signal)
            if (!auth || typeof auth.accessToken !== "string" || !auth.accessToken.trim() || typeof auth.accountId !== "string" || !auth.accountId.trim()) throw new Error("Codex account credentials are unavailable")
            accessToken = auth.accessToken
            accountId = auth.accountId
          } else accessToken = capturedConfig.apiKey
          request.signal?.throwIfAborted()
        } catch (error) {
          if (request.signal?.aborted) throw error
          yield { type: "error", error: error instanceof Error ? error : new Error("Unable to resolve account credentials") }
          return
        }
        // M62: a TRANSPORT failure (fetch rejects before any HTTP response) used
        // to escape as Node's bare "fetch failed", which cannot distinguish DNS /
        // TCP / TLS / proxy. Surface the cause chain instead.
        let response: Response
        const routing = affinity?.prepare(scope, accountId!, body.prompt_cache_key, cacheMode === "off", scopeIdentity)
        try {
          response = await (codexSubscription ? systemFetch : fetch)(endpoint, {
            method: "POST",
            headers: mergeConfiguredHeaders(capturedConfig.headers, { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, ...(codexSubscription ? { "ChatGPT-Account-Id": accountId!, originator: "i-harness", "User-Agent": "I-harness", Accept: "text/event-stream", ...routing!.headers } : {}) }),
            ...(codexSubscription ? { redirect: "error" as const } : {}),
            body: serialized,
            // M61: the caller's abort signal reaches the transport — cancel must
            // kill a parked request, not wait for the first event.
            ...(request.signal !== undefined ? { signal: request.signal } : {}),
          })
        } catch (error) {
          yield { type: "error", error: await describeTransportError("openai", endpoint, error) }
          return
        }
        if (!response.ok || !response.body) {
          yield { type: "error", error: await describeHttpError("openai", response, request) }
          return
        }
        routing?.capture(response, request.signal)
        reportStreamActivity(request, "response-start")
        const fold = createResponseFold(capturedConfig, codexSubscription, () => reportStreamActivity(request, "tool-arguments"))
        yield* decodeResponseStream(response.body, fold, codexSubscription, request)
      },
    })
  })
}
