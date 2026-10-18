import { observeTextOutput } from './request/text-output.ts'
import { invalidPreparedRequest, preparedModelClient, snapshotModelData, createPreparedHttpPayload, reportStreamActivity, projectImagesForProvider, type ModelClient } from "@i-harness/llm-seam"
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
    return createPreparedHttpPayload({
      textOutput: observeTextOutput,
      body: payload, request, describe: body => describeContext(body, capturedConfig, cacheEvidence),
      validate: anthropicValidator(capturedConfig, messages, cacheEvidence),
      output: (body, request) => outputFacts(body, request, capturedConfig),
      cap: (body, cap) => capBody(body, cap, request, capturedConfig),
      transport: { label: 'anthropic',
        prepare(actualBody, _serialized, control) {
        // Bind signed responses to the lowered input that this handle sends.
        // Only producer-proven cache additions leave the native prefix.
        const { semantic } = describeCachedBody(actualBody, cacheEvidence)
        const prefix = fingerprintPrefix(semantic.system, semantic.tools, semantic.messages)
        const inputWitness = anthropicWitness(actualBody, capturedConfig)
        return { url: `${baseUrl}/v1/messages`, identity: capturedConfig.executionIdentity, state: { prefix, inputWitness }, init: {
            headers: mergeConfiguredHeaders(capturedConfig.headers, { "Content-Type": "application/json", "x-api-key": capturedConfig.apiKey, "anthropic-version": "2023-06-01" }),
            signal: control.signal,
        } }
        },
        async *read(response, _actualBody, control, { prefix, inputWitness }) {
          const request = { ...capturedRequest, ...control }
          const fold = createAnthropicFold(capturedConfig, () => prefix, () => reportStreamActivity(request, "tool-arguments"), inputWitness)
          yield* decodeAnthropicStream(response.body!, fold, request)
        },
      },
    })
  })
}
