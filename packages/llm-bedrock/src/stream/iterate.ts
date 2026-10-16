import type { ConverseStreamCommandOutput } from "@aws-sdk/client-bedrock-runtime"
import { describeTransportError, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
import type { BedrockConfig } from "../types.ts"
import { resolveBedrockRegion } from "../region.ts"
import { createBedrockFold } from "./fold.ts"
import type { ConverseInputWitness } from '../request/validate-native.ts'

/** The SDK already decodes members; for-await owns its iterator lifecycle. */
export async function* iterateConverseStream(output: ConverseStreamCommandOutput, config: BedrockConfig, request: LLMRequest, witness?: ConverseInputWitness): AsyncIterable<LLMStreamEvent> {
  const fold = createBedrockFold(config, request, witness)
  try {
    for await (const member of output.stream ?? []) {
      const events = fold.handleMember(member)
      for (const ev of events) {
        yield ev
        if (ev.type === "error") return // error is terminal — no `end`
      }
    }
  } catch (err) {
    // M72 Ⅰ: the read loop was the last unguarded one — the four SSE
    // adapters got this catch in Task 4, and without it a failure AFTER the
    // 200 (a dropped connection, an SDK-level stream error) escaped as a raw
    // throw, bypassing both the diagnosis below and the seam's error channel.
    // Abort is NOT a provider failure: a cancelled read keeps today's
    // behaviour (a throw out of the generator).
    if (request.signal?.aborted === true) throw err
    yield { type: "error", error: await describeTransportError("bedrock", resolveBedrockRegion(config.region, process.env), err, { remediation: "none" }) }
    return
  }
  yield fold.end()
}
