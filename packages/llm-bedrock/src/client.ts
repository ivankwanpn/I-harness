import { invalidPreparedRequest, preparedModelClient, snapshotModelData, createPreparedPayload, reportStreamActivity, describeTransportError, projectImagesForProvider, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"
import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamCommandOutput } from "@aws-sdk/client-bedrock-runtime"
import type { BedrockConfig, BedrockRuntimeFace } from "./types.ts"
import { resolveBedrockRegion } from "./region.ts"
import { buildConverseBody } from "./request/body.ts"
import { iterateConverseStream } from "./stream/iterate.ts"

import { describeContext, outputFacts, capBody } from "./context.ts"

export function createBedrockClient(config: BedrockConfig, runtime?: BedrockRuntimeFace): ModelClient {
  const runtimeRegion = runtime === undefined ? resolveBedrockRegion(config.region, process.env) : undefined
  // One runtime client per adapter (credential chain resolved once at
  // construction); a test-injected fake skips both the chain and the network.
  const client = runtime ?? new BedrockRuntimeClient({
    region: runtimeRegion,
    ...(config.profile !== undefined ? { profile: config.profile } : {}),
  })
  return preparedModelClient(async originalRequest => {
    const request = snapshotModelData(originalRequest)
    const capturedConfig = snapshotModelData(config, ["region", "profile"])
    // Region is a transport/diagnostic setting, not model-visible input.
    // Keep injected construction lazy and never reread default-runtime setup.
    Object.defineProperty(capturedConfig, "region", { get: () => runtimeRegion ?? config.region })
    request.signal?.throwIfAborted()
    // M14 negative capability: text-only routes never see image bytes.
    const vision = capturedConfig.inputModalities?.includes("image") ?? false
    const messages = await projectImagesForProvider(request.messages, vision, request.signal)
    const mapped = buildConverseBody(capturedConfig, request, messages)
    if (mapped.error !== undefined) {
      throw invalidPreparedRequest(mapped.error.message)
    }
    const body = mapped.body
    request.signal?.throwIfAborted()
    const capturedRequest = request
    return createPreparedPayload({
      body: body, request, kind: "sdk-command-estimate", describe: body => describeContext(body, capturedConfig),
      output: (body, request) => outputFacts(body, request, capturedConfig),
      cap: (body, cap) => capBody(body, cap, request, capturedConfig),
      async *execute(actualBody, _serialized, control): AsyncIterable<LLMStreamEvent> {
        const request = { ...capturedRequest, ...control }
        // M61: the AWS SDK takes the abort at the REQUEST level — cancel must
        // kill a parked Converse call, not wait for the first event.
        let output: ConverseStreamCommandOutput
        request.validateBeforeTransport?.()
        try {
          output = await client.send(
            new ConverseStreamCommand(actualBody),
            request.signal !== undefined ? { abortSignal: request.signal } : {},
          )
        } catch (err) {
          // M72 Ⅰ: M61's cancel and every request-level failure (auth, throttling,
          // network) used to escape as a raw SDK throw, bypassing the seam's error
          // channel the other four adapters use. Abort is NOT a provider failure:
          // it keeps today's behaviour (a throw out of the generator).
          if (request.signal?.aborted === true) throw err
          yield { type: "error", error: await describeTransportError("bedrock", resolveBedrockRegion(capturedConfig.region, process.env), err, { remediation: "none" }) }
          return
        }
        reportStreamActivity(request, "response-start")
        yield* iterateConverseStream(output, capturedConfig, request)
      },
    })
  })
}
