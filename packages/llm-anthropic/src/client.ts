import { invalidPreparedRequest, preparedModelClient, snapshotModelData, createPreparedPayload, reportStreamActivity, describeHttpError, describeTransportError, projectImagesForProvider, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"
import type { AnthropicConfig } from "./types.ts"
import { createRequestBody } from "./request/body.ts"
import { fingerprintPrefix } from "./request/messages.ts"
import { describeCachedBody } from "./request/cache-evidence.ts"
import { mergeConfiguredHeaders } from "./request/headers.ts"
import { createAnthropicFold } from "./stream/fold.ts"
import { decodeAnthropicStream } from "./stream/decode.ts"

import { describeContext, outputFacts, capBody } from "./context.ts"
import { anthropicValidator } from './request/validate.ts'
import { anthropicWitness } from './request/validate-native.ts'
import { assertNativeProducerWitnesses } from '@i-harness/llm-seam'

export function createAnthropicClient(config: AnthropicConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com"
  return preparedModelClient(async originalRequest => {
    assertNativeProducerWitnesses(originalRequest.messages, 'anthropic-messages')
    const request = snapshotModelData(originalRequest)
    const capturedConfig = snapshotModelData(config)
    request.signal?.throwIfAborted()
    // M14 negative capability: text-only routes never see image bytes.
    const vision = capturedConfig.inputModalities?.includes("image") ?? false
    const messages = await projectImagesForProvider(request.messages, vision, request.signal)
    const prepared = createRequestBody(capturedConfig, request, messages)
    if ("error" in prepared) {
      throw invalidPreparedRequest(prepared.error.message)
    }
    const { payload, cacheEvidence } = prepared
    request.signal?.throwIfAborted()
    const capturedRequest = request
    return createPreparedPayload({
      body: payload, request, describe: body => describeContext(body, capturedConfig, cacheEvidence),
      validate: anthropicValidator(capturedConfig, messages, cacheEvidence),
      output: (body, request) => outputFacts(body, request, capturedConfig),
      cap: (body, cap) => capBody(body, cap, request, capturedConfig),
      async *execute(actualBody, serialized, control, execution): AsyncIterable<LLMStreamEvent> {
        const request = { ...capturedRequest, ...control }
        // Bind signed responses to the lowered input that this handle sends.
        // Only producer-proven cache additions leave the native prefix.
        const { semantic } = describeCachedBody(actualBody, cacheEvidence)
        const prefix = fingerprintPrefix(semantic.system, semantic.tools, semantic.messages)
        const inputWitness = anthropicWitness(actualBody, capturedConfig)
        // M62: a TRANSPORT failure (fetch rejects before any HTTP response) used
        // to escape as Node's bare "fetch failed", which cannot distinguish DNS /
        // TCP / TLS / proxy. Surface the cause chain instead.
        let response: Response
        execution.confirm(capturedConfig.executionIdentity)
        try {
          response = await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: mergeConfiguredHeaders(capturedConfig.headers, { "Content-Type": "application/json", "x-api-key": capturedConfig.apiKey, "anthropic-version": "2023-06-01" }),
            body: serialized,
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
        const fold = createAnthropicFold(capturedConfig, () => prefix, () => reportStreamActivity(request, "tool-arguments"), inputWitness)
        yield* decodeAnthropicStream(response.body, fold, request)
      },
    })
  })
}
