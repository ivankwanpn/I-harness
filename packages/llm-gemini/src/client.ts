import { observeTextOutput } from './request/text-output.ts'
import { preparedModelClient, snapshotModelData, createPreparedHttpPayload, projectImagesForProvider, type ModelClient } from "@i-harness/llm-seam"
import type { GeminiConfig } from "./types.ts"
import { toGeminiContents } from "./request/messages.ts"
import { createRequestBody } from "./request/body.ts"
import { mergeConfiguredHeaders } from "./request/headers.ts"
import { decodeGeminiStream } from "./stream/decode.ts"

import { describeContext, outputFacts } from "./context.ts"
import { geminiValidator } from './request/validate.ts'
import { field } from './request/protojson.ts'
import { assertNativeProducerWitnesses } from '@i-harness/llm-seam'

export function createGeminiClient(config: GeminiConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com"
  return preparedModelClient(async originalRequest => {
    assertNativeProducerWitnesses(originalRequest.messages, 'gemini')
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
    return createPreparedHttpPayload({
      textOutput: observeTextOutput,
      body: body, request, describe: body => describeContext(body, capturedConfig),
      validate: geminiValidator(capturedConfig, contents, messages),
      output: (body, request) => outputFacts(body, request, capturedConfig),
      cap: (body, cap) => {
        if (cap === undefined && request.maxOutputTokens === undefined) return body
        const generation = { ...(field(body, 'generationConfig') as Record<string, unknown> ?? {}) }
        delete generation.maxOutputTokens
        delete generation.max_output_tokens
        const raw = field(capturedConfig.options, 'generationConfig') as Record<string, unknown> | undefined
        const value = cap ?? field(raw, 'maxOutputTokens')
        delete body.generation_config
        if (value !== undefined) generation.maxOutputTokens = value
        if (Object.keys(generation).length) body.generationConfig = generation
        else delete body.generationConfig
        return body
      },
      transport: { label: 'gemini',
        prepare(_actualBody, _serialized, control) {
        const geminiUrl = `${baseUrl}/v1beta/models/${encodeURIComponent(capturedConfig.model)}:streamGenerateContent?alt=sse`
        return { url: geminiUrl, identity: capturedConfig.executionIdentity, state: undefined, init: {
            headers: mergeConfiguredHeaders(capturedConfig.headers, { "Content-Type": "application/json", "x-goog-api-key": capturedConfig.apiKey }),
            signal: control.signal,
        } }
        },
        async *read(response, _actualBody, control) {
          yield* decodeGeminiStream(response.body!, { ...capturedRequest, ...control }, capturedConfig)
        },
      },
    })
  })
}
