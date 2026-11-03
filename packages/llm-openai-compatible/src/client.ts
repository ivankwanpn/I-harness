import { observeTextOutput } from './request/text-output.ts'
import { preparedModelClient, snapshotModelData, createPreparedHttpPayload, projectImagesForProvider, type ModelClient } from "@i-harness/llm-seam"
import type { OpenAICompatibleConfig } from "./types.ts"
import { createRequestBody } from "./request/body.ts"
import { mergeConfiguredHeaders } from "./request/headers.ts"
import { createChatFold } from "./stream/fold.ts"
import { decodeChatStream } from "./stream/decode.ts"

import { describeContext, outputFacts } from "./context.ts"
import { chatValidator } from './request/validate.ts'

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
    return createPreparedHttpPayload({
      textOutput: observeTextOutput,
      validate: chatValidator(capturedConfig),
      body: body, request, describe: body => describeContext(body, capturedConfig),
      output: (body, request) => outputFacts(body, request, capturedConfig),
      cap: (body, cap) => {
        const field = capturedConfig.maxTokensField ?? "max_tokens"
        delete body[field]
        const value = cap ?? capturedConfig.options?.[field]
        if (value !== undefined) body[field] = value
        return body
      },
      transport: {
        label: 'openai-compatible', fetchOverride: capturedConfig.fetch,
        prepare(_actualBody, _serialized, control) {
          return { url: `${baseUrl}/v1/chat/completions`, identity: capturedConfig.executionIdentity, state: undefined, init: {
            headers: mergeConfiguredHeaders(capturedConfig.headers, { "Content-Type": "application/json", Authorization: `Bearer ${capturedConfig.apiKey}` }),
            signal: control.signal,
          } }
        },
        async *read(response, _actualBody, control) {
          const request = { ...capturedRequest, ...control }, fold = createChatFold(capturedConfig, request)
          yield* decodeChatStream(response.body!, fold, request)
        },
      },
    })
  })
}
