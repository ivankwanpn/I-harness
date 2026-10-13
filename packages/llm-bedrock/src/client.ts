import { reportStreamActivity, describeTransportError, projectImagesForProvider, type LLMRequest, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"
import { BedrockRuntimeClient, ConverseStreamCommand, type ConverseStreamCommandOutput } from "@aws-sdk/client-bedrock-runtime"
import type { BedrockConfig, BedrockRuntimeFace } from "./types.ts"
import { resolveBedrockRegion } from "./region.ts"
import { buildConverseBody } from "./request/body.ts"
import { iterateConverseStream } from "./stream/iterate.ts"

export function createBedrockClient(config: BedrockConfig, runtime?: BedrockRuntimeFace): ModelClient {
  // One runtime client per adapter (credential chain resolved once at
  // construction); a test-injected fake skips both the chain and the network.
  const client = runtime ?? new BedrockRuntimeClient({
    region: resolveBedrockRegion(config.region, process.env),
    ...(config.profile !== undefined ? { profile: config.profile } : {}),
  })
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      // M14 negative capability: text-only routes never see image bytes.
      const vision = config.inputModalities?.includes("image") ?? false
      const messages = await projectImagesForProvider(request.messages, vision, request.signal)
      const mapped = buildConverseBody(config, request, messages)
      if (mapped.error !== undefined) {
        yield { type: "error", error: mapped.error }
        return
      }
      const body = mapped.body
      // M61: the AWS SDK takes the abort at the REQUEST level — cancel must
      // kill a parked Converse call, not wait for the first event.
      let output: ConverseStreamCommandOutput
      try {
        output = await client.send(
          new ConverseStreamCommand(body),
          request.signal !== undefined ? { abortSignal: request.signal } : {},
        )
      } catch (err) {
        // M72 Ⅰ: M61's cancel and every request-level failure (auth, throttling,
        // network) used to escape as a raw SDK throw, bypassing the seam's error
        // channel the other four adapters use. Abort is NOT a provider failure:
        // it keeps today's behaviour (a throw out of the generator).
        if (request.signal?.aborted === true) throw err
        yield { type: "error", error: await describeTransportError("bedrock", resolveBedrockRegion(config.region, process.env), err, { remediation: "none" }) }
        return
      }
      reportStreamActivity(request, "response-start")
      yield* iterateConverseStream(output, config, request)
    },
  }
}
