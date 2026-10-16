import { ProjectionCounter } from "@i-harness/token-meter"
import { type LLMRequest } from "@i-harness/llm-seam"
import type { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime"
import type { BedrockConfig } from "./types.ts"
import { translateReasoning } from "./request/reasoning.ts"
export function describeContext(body: ConverseStreamCommandInput, config: BedrockConfig) {
  const counter = new ProjectionCounter("projected-pricing-v2")
  counter.structured("system", body.system)
  counter.structured("toolSchemas", body.toolConfig)
  for (const item of body.messages ?? [])
    counter.unit(item, item.role === "assistant" ? "assistant" : item.content?.every(part => part.toolResult !== undefined) ? "tool" : "user", () => {
      for (const part of item.content ?? []) {
        if (part.image)
          counter.image(part.image.source?.bytes)
        else if (part.reasoningContent) {
          const reasoning = part.reasoningContent
          if (reasoning.reasoningText) {
            counter.text("replayedReasoning", reasoning.reasoningText.text)
            counter.metadata(reasoning.reasoningText as unknown as Record<string, unknown>)
          }
          if (reasoning.redactedContent)
            counter.opaque(reasoning.redactedContent)
        }
        else if (part.toolUse)
          counter.structured("toolArguments", part.toolUse)
        else if (part.toolResult) {
          const result = part.toolResult
          counter.structured('framing', { toolUseId: result.toolUseId, status: result.status })
          for (const resultPart of result.content ?? []) {
            if (resultPart.image) counter.image(resultPart.image.source?.bytes)
            else if (resultPart.text !== undefined) counter.text('toolResults', resultPart.text)
            else counter.structured('toolResults', resultPart)
          }
        }
        else if (part.text !== undefined)
          counter.text("visibleText", part.text)
        else
          counter.structured("otherInput", part)
      }
    })
  const additional = body.additionalModelRequestFields as Record<string, unknown> | undefined
  const additionalInput = additional ?? {}
  const inference = { ...body.inferenceConfig }
  delete inference.maxTokens
  const root = Object.fromEntries(Object.entries(body).filter(([key]) => !["modelId", "system", "messages", "toolConfig", "inferenceConfig", "additionalModelRequestFields", "requestMetadata"].includes(key)))
  const other = { ...root, ...(Object.keys(inference).length ? { inferenceConfig: inference } : {}), ...(Object.keys(additionalInput).length ? { additionalModelRequestFields: additionalInput } : {}) }
  counter.structured("otherInput", other)
  const input = counter.finish({ protocol: "bedrock", providerId: config.providerId, modelId: config.model, expectedModelId: config.model }, { system: body.system, tools: body.toolConfig, messages: body.messages, other }, { system: body.system, tools: body.toolConfig, other })
  return { input, packet: { sizeKind: "sdk-command-estimate" as const, inlineBinaryBytes: counter.inlineBinaryBytes, cacheMetadataBytes: counter.cacheMetadataBytes, signatureBytes: counter.signatureBytes } }
}
export function outputFacts(body: ConverseStreamCommandInput, request: LLMRequest) {
  const additional = body.additionalModelRequestFields as Record<string, unknown> | undefined
  const thinking = additional?.thinking as {
    type?: string
    budget_tokens?: number
  } | undefined
  const budget = thinking?.type === "enabled" ? thinking.budget_tokens : undefined
  const managed = request.reasoningEffort !== undefined && request.reasoningEffort !== 'off'
  return { capSupport: "supported" as const, configuredCap: request.maxOutputTokens, effectiveCap: body.inferenceConfig?.maxTokens, minimumCap: budget !== undefined && managed ? 1025 : 1, reasoningBudget: typeof budget === 'number' && Number.isSafeInteger(budget) && budget >= 0 ? budget : undefined, source: request.maxOutputTokens !== undefined ? "request" as const : budget !== undefined && managed ? "adapter-default" as const : "provider-default" as const }
}
export function capBody(body: ConverseStreamCommandInput, cap: number | undefined, request: LLMRequest, config: BedrockConfig): ConverseStreamCommandInput {
  const additional = body.additionalModelRequestFields as Record<string, unknown> | undefined
  const thinking = additional?.thinking as {
    type?: string
    budget_tokens?: number
  } | undefined
  const desired = translateReasoning(config.model, request.reasoningEffort)
  cap ??= desired?.thinking?.type === "enabled" ? 8192 : undefined
  const budget = desired?.thinking?.type === "enabled" ? desired.thinking.budget_tokens : thinking?.budget_tokens
  const result = { ...body }
  delete result.inferenceConfig
  return { ...result, ...(cap !== undefined ? { inferenceConfig: { ...body.inferenceConfig, maxTokens: cap } } : {}), ...(thinking?.type === "enabled" && request.reasoningEffort !== undefined && request.reasoningEffort !== "off" && cap !== undefined ? { additionalModelRequestFields: { ...additional, thinking: { ...thinking, budget_tokens: Math.min(budget!, cap - 1) } } } : {}) }
}
