import { stringifyJsonData } from "@i-harness/core-session"
import { ProjectionCounter } from "@i-harness/token-meter"
import type { LLMRequest, ModelClient } from "../index.ts"
import type { PreparedModelRequest, PreparedStreamControl } from "./types.ts"
import { freezePreparedFacts, preparedControls, snapshotModelData, validateOutputCap } from "./wrappers.ts"
import { createPreparedValidation } from './validation.ts'
import { readPreparedTextOutput } from './text-output.ts'
import { NO_GENERATION_RETRY, generationError } from './generation.ts'
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
      retryPolicy: NO_GENERATION_RETRY,
      textOutput: readPreparedTextOutput({}),
      validation: createPreparedValidation({ version: 1, route: 'custom', contract: 'neutral-only-v1', status: 'partial', coverage: 'neutral-only', native: 'unverified', issues: [], gaps: ['custom-client'], omittedIssueCount: 0 }),
      measurement: freezePreparedFacts({
        projectionId: input.inputFingerprint, input,
        output: { capSupport: "unknown" as const, configuredCap: cap, minimumCap: 1, source: "request" as const },
        packet: { sizeKind: "neutral-envelope-estimate" as const, sdkCommandBytesEstimate: Buffer.byteLength(stringifyJsonData({ system: captured.systemPrompt, tools: captured.tools, messages: captured.messages })!), inlineBinaryBytes: counter.inlineBinaryBytes, cacheMetadataBytes: 0, signatureBytes: 0 }
      }),
      withOutputCap: derive,
      stream: (control?: PreparedStreamControl) => {
        const actual = preparedControls(captured, control)
        if (actual.generation) throw generationError('GENERATION_UNSUPPORTED')
        actual.validateBeforeTransport?.()
        // Explicit standalone opaque clients retain conservative invocation
        // semantics. This is not durable physical evidence or a managed grant.
        try { actual.onTransportIssue?.() } catch { /* Invocation observers do not alter execution. */ }
        const { validateBeforeTransport: _guard, confirmExecution: _confirmation, onTransportIssue: _issue, ...executionControl } = actual
        const { validateBeforeTransport: _capturedGuard, confirmExecution: _capturedConfirmation, onTransportIssue: _capturedIssue, maxOutputTokens: _previousCap, ...data } = snapshotModelData(captured)
        return client.stream({ ...data, ...(cap !== undefined ? { maxOutputTokens: cap } : {}), ...executionControl })
      },
    })
  }
  return derive(captured.maxOutputTokens)
}
