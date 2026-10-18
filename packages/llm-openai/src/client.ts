import { observeTextOutput } from './request/text-output.ts'
import { preparedModelClient, snapshotModelData, createPreparedHttpPayload, reportStreamActivity, projectImagesForProvider, type ModelClient } from "@i-harness/llm-seam"
import { createSubscriptionAffinity } from "./affinity.ts"
import type { OpenAIConfig } from "./types.ts"
import { createRequestBody } from "./request/body.ts"
import { mergeConfiguredHeaders } from "./request/headers.ts"
import { createResponseFold } from "./stream/fold.ts"
import { decodeResponseStream } from "./stream/decode.ts"

import { describeContext, outputFacts } from "./context.ts"
import { responsesValidator } from './request/validate.ts'

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
    const { body, cacheMode, generatedAffinity } = createRequestBody(capturedConfig, request, messages, codexSubscription,
      affinity && scopeIdentity ? () => affinity.cacheKey(scopeIdentity) : undefined)
    request.signal?.throwIfAborted()
    const capturedRequest = request
    return createPreparedHttpPayload({
      textOutput: observeTextOutput,
      validate: responsesValidator(capturedConfig, codexSubscription),
      body: body, request, describe: body => describeContext(body, capturedConfig, codexSubscription, generatedAffinity),
      output: (body, request) => outputFacts(body, request, capturedConfig, codexSubscription),
      cap: (body, cap) => {
        if (codexSubscription) return body
        delete body.max_output_tokens
        const value = cap ?? capturedConfig.options?.max_output_tokens
        if (value !== undefined) body.max_output_tokens = value
        return body
      },
      transport: { label: 'openai', ...(codexSubscription ? { proxy: 'system' as const } : {}),
      async prepare(_actualBody, _serialized, control) {
        const request = { ...capturedRequest, ...control }
        let accessToken: string
        let accountId: string | undefined
        let executionIdentity = capturedConfig.executionIdentity
        try {
          request.signal?.throwIfAborted()
          if (codexSubscription && !capturedConfig.resolveCodexAuth) throw new Error("Codex subscription account credentials are unavailable")
          if (codexSubscription) {
            const auth = await capturedConfig.resolveCodexAuth!(request.signal)
            if (!auth || typeof auth.accessToken !== "string" || !auth.accessToken.trim() || typeof auth.accountId !== "string" || !auth.accountId.trim()) throw new Error("Codex account credentials are unavailable")
            accessToken = auth.accessToken
            accountId = auth.accountId
            executionIdentity = auth.authEpoch && capturedConfig.executionIdentity ? { ...capturedConfig.executionIdentity, authEpoch: auth.authEpoch } : undefined
          } else accessToken = capturedConfig.apiKey
          request.signal?.throwIfAborted()
        } catch (error) {
          if (request.signal?.aborted) throw error
          throw Object.assign(error instanceof Error ? error : new Error("Unable to resolve account credentials"), { code: "AUTH" })
        }
        const routing = affinity?.prepare(scope, accountId!, body.prompt_cache_key, cacheMode === "off", scopeIdentity)
        return { url: endpoint, identity: executionIdentity, state: routing, init: {
            method: "POST",
            headers: mergeConfiguredHeaders(capturedConfig.headers, { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, ...(codexSubscription ? { "ChatGPT-Account-Id": accountId!, originator: "i-harness", "User-Agent": "I-harness", Accept: "text/event-stream", ...routing!.headers } : {}) }),
            ...(codexSubscription ? { redirect: "error" as const } : {}),
            // M61: the caller's abort signal reaches the transport — cancel must
            // kill a parked request, not wait for the first event.
            ...(request.signal !== undefined ? { signal: request.signal } : {}),
        } }
      },
      async *read(response, _actualBody, control, routing) {
        const request = { ...capturedRequest, ...control }
        routing?.capture(response, request.signal)
        const fold = createResponseFold(capturedConfig, codexSubscription, () => reportStreamActivity(request, "tool-arguments"))
        yield* decodeResponseStream(response.body!, fold, codexSubscription, request)
      },
      },
    })
  })
}
