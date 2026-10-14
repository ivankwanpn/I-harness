import { ProjectionCounter } from "@i-harness/token-meter"
import type { LLMRequest, ModelClient } from "../index.ts"
import type { PreparedModelRequest, PreparedStreamControl } from "./types.ts"
import { freezePreparedFacts, preparedControls, snapshotModelData, validateOutputCap } from "./wrappers.ts"
/** Compatible custom clients expose neutral-only coverage and unknown cap
 * support: a stream-only client cannot certify its protocol or applied cap. */
export async function prepareModelRequest(client: ModelClient, request: LLMRequest): Promise<PreparedModelRequest> {
  request.signal?.throwIfAborted()
  if (client.prepare)
    return client.prepare(request)
  const captured = snapshotModelData(request), counter = new ProjectionCounter()
  counter.text("system", captured.systemPrompt)
  counter.structured("toolSchemas", captured.tools)
  for (const message of captured.messages)
    counter.unit(message, message.role, () => {
      if (typeof message.content === "string")
        counter.text(message.role === "tool" ? "toolResults" : "visibleText", message.content)
      else
        for (const part of message.content) {
          if (part.type === "text")
            counter.text(message.role === "tool" ? "toolResults" : "visibleText", part.text)
          else
            counter.image(part.image.dataBase64)
        }
      if (message.role === "assistant")
        counter.structured("toolArguments", message.toolCalls)
    })
  counter.uncertainties.add("custom-client-projection-unavailable")
  const input = counter.finish({ protocol: "custom", modelId: "unknown" }, { system: captured.systemPrompt, tools: captured.tools, messages: captured.messages }, { system: captured.systemPrompt, tools: captured.tools }, [], "neutral-only")
  function derive(cap: number | undefined): PreparedModelRequest {
    validateOutputCap(cap)
    return Object.freeze({
      measurement: freezePreparedFacts({
        projectionId: input.inputFingerprint, input,
        output: { capSupport: "unknown" as const, configuredCap: cap, minimumCap: 1, source: "request" as const },
        packet: { sizeKind: "neutral-envelope-estimate" as const, sdkCommandBytesEstimate: Buffer.byteLength(JSON.stringify({ system: captured.systemPrompt, tools: captured.tools, messages: captured.messages })), inlineBinaryBytes: counter.inlineBinaryBytes, cacheMetadataBytes: 0, signatureBytes: 0 }
      }),
      withOutputCap: derive,
      stream: (control?: PreparedStreamControl) => {
        const actual = preparedControls(captured, control)
        actual.validateBeforeTransport?.()
        const { validateBeforeTransport: _guard, ...executionControl } = actual
        const { validateBeforeTransport: _capturedGuard, maxOutputTokens: _previousCap, ...data } = snapshotModelData(captured)
        return client.stream({ ...data, ...(cap !== undefined ? { maxOutputTokens: cap } : {}), ...executionControl })
      },
    })
  }
  return derive(captured.maxOutputTokens)
}
