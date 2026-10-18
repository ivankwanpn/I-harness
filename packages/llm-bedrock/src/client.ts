import { observeTextOutput } from './request/text-output.ts'
import { invalidPreparedRequest, preparedModelClient, snapshotModelData, projectImagesForProvider, type ModelClient } from "@i-harness/llm-seam"
import type { BedrockConfig, BedrockRuntimeFace } from "./types.ts"
import { buildConverseBody } from "./request/body.ts"

import { describeContext, outputFacts, capBody } from "./context.ts"
import { bedrockValidator } from './request/validate.ts'
import { assertNativeProducerWitnesses } from '@i-harness/llm-seam'
import { createBedrockSdkTerminal } from './sdk-terminal.ts'

export function createBedrockClient(config: BedrockConfig, runtime?: BedrockRuntimeFace): ModelClient {
  const terminal = createBedrockSdkTerminal(config, runtime), runtimeRegion = terminal.region
  return preparedModelClient(async originalRequest => {
    assertNativeProducerWitnesses(originalRequest.messages, 'bedrock')
    const request = snapshotModelData(originalRequest)
    const capturedConfig = snapshotModelData(config, ["region", "profile", "runtimeOptions"])
    // Region is a transport/diagnostic setting, not model-visible input.
    // Keep injected construction lazy and never reread default-runtime setup.
    Object.defineProperty(capturedConfig, "region", { get: () => runtimeRegion ?? config.region })
    request.signal?.throwIfAborted()
    // M14 negative capability: text-only routes never see image bytes.
    const vision = capturedConfig.inputModalities?.includes("image") ?? false
    const messages = await projectImagesForProvider(request.messages, vision, request.signal)
    const mapped = buildConverseBody(capturedConfig, request, messages, runtime === undefined)
    if (mapped.error !== undefined) {
      throw invalidPreparedRequest(mapped.error.message)
    }
    const body = mapped.body
    request.signal?.throwIfAborted()
    return terminal.prepare({
      textOutput: observeTextOutput,
      body: body, request, kind: "sdk-command-estimate", describe: body => describeContext(body, capturedConfig),
      validate: bedrockValidator(capturedConfig, runtime === undefined, messages),
      output: (body, request) => outputFacts(body, request),
      cap: (body, cap) => capBody(body, cap, request, capturedConfig),
    }, capturedConfig)
  })
}
