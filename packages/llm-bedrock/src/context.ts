import { ProjectionCounter } from "@i-harness/token-meter"
import { invalidPreparedRequest, type LLMRequest } from "@i-harness/llm-seam"
import type { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime"
import type { BedrockConfig } from "./types.ts"
import { translateReasoning } from "./request/reasoning.ts"
export function describeContext(body: ConverseStreamCommandInput, config: BedrockConfig) {
  const counter = new ProjectionCounter()
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
        else if (part.toolResult)
          counter.structured("toolResults", part.toolResult)
        else if (part.text !== undefined)
          counter.text("visibleText", part.text)
        else
          counter.structured("otherInput", part)
      }
    })
  const additional = body.additionalModelRequestFields as Record<string, unknown> | undefined
  const other = Object.fromEntries(Object.entries(additional ?? {}).filter(([key]) => !["thinking", "reasoningConfig", "output_config", "max_tokens", "maxTokens", "max_completion_tokens"].includes(key)))
  counter.structured("otherInput", other)
  const input = counter.finish({ protocol: "bedrock", providerId: config.providerId, modelId: config.model, expectedModelId: config.model }, { system: body.system, tools: body.toolConfig, messages: body.messages, other }, { system: body.system, tools: body.toolConfig })
  return { input, packet: { sizeKind: "sdk-command-estimate" as const, inlineBinaryBytes: counter.inlineBinaryBytes, cacheMetadataBytes: counter.cacheMetadataBytes, signatureBytes: counter.signatureBytes } }
}
export function outputFacts(body: ConverseStreamCommandInput, request: LLMRequest, config: BedrockConfig) {
  const additional = body.additionalModelRequestFields as Record<string, unknown> | undefined
  const thinking = additional?.thinking as {
    type?: string
    budget_tokens?: number
  } | undefined
  const budget = thinking?.type === "enabled" ? thinking.budget_tokens : undefined
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1024))
    throw invalidPreparedRequest("Bedrock reasoning budget is invalid")
  const rawCaps = [additional?.max_tokens, additional?.maxTokens, additional?.max_completion_tokens].filter(value => value !== undefined)
  if (rawCaps.length > 1 || rawCaps.length > 0 && body.inferenceConfig?.maxTokens !== undefined)
    throw invalidPreparedRequest("Bedrock request contains conflicting output cap fields")
  const raw = rawCaps[0]
  if (raw !== undefined && (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1))
    throw invalidPreparedRequest("Bedrock raw output cap is invalid")
  return { capSupport: "supported" as const, configuredCap: request.maxOutputTokens ?? (typeof raw === "number" ? raw : undefined), effectiveCap: body.inferenceConfig?.maxTokens ?? (typeof raw === "number" ? raw : undefined), minimumCap: budget === undefined ? 1 : request.reasoningEffort !== undefined && request.reasoningEffort !== "off" ? 1025 : budget + 1, reasoningBudget: budget, source: request.maxOutputTokens !== undefined ? "request" as const : raw !== undefined ? "route" as const : budget !== undefined ? "adapter-default" as const : config.options ? "provider-default" as const : "provider-default" as const }
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
