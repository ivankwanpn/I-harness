import { ProjectionCounter } from "@i-harness/token-meter"
import { ANTHROPIC_MAX_TOKENS_FALLBACK, type LLMRequest } from "@i-harness/llm-seam"
import { translateReasoning } from "./request/reasoning.ts"
import type { AnthropicConfig } from "./types.ts"
import { describeCachedBody, type CacheEvidence } from "./request/cache-evidence.ts"
import { anthropicCapabilities, hasInterleavedBeta } from "./request/capabilities.ts"
export function describeContext(actualBody: Record<string, unknown>, config: AnthropicConfig, cacheEvidence: CacheEvidence) {
  const { semantic: body, metadataBytes } = describeCachedBody(actualBody, cacheEvidence)
  const counter = new ProjectionCounter("projected-pricing-v2")
  counter.cacheMetadataBytes += metadataBytes
  counter.metadata(body)
  const block = (value: unknown, category: "system" | "visibleText" | "toolResults"): void => {
    if (typeof value === "string") {
      counter.text(category, value)
      return
    }
    if (!value || typeof value !== "object")
      return
    const item = value as Record<string, unknown>
    counter.metadata(item)
    if (item.type === "image") {
      const source = item.source as Record<string, unknown>
      counter.image(source?.data)
    }
    else if (item.type === "thinking")
      counter.text("replayedReasoning", item.thinking)
    else if (item.type === "redacted_thinking")
      counter.opaque(item.data)
    else if (item.type === "tool_use")
      counter.structured("toolArguments", { id: item.id, name: item.name, input: item.input })
    else if (item.type === "tool_result") {
      counter.structured("framing", { tool_use_id: item.tool_use_id, is_error: item.is_error })
      if (Array.isArray(item.content))
        for (const part of item.content)
          block(part, "toolResults")
      else
        counter.text("toolResults", item.content)
    }
    else if (item.text !== undefined)
      counter.text(category, item.text)
    else
      counter.structured("otherInput", item)
  }
  if (Array.isArray(body.system))
    for (const item of body.system)
      block(item, "system")
  else
    block(body.system, "system")
  counter.structured("toolSchemas", body.tools)
  if (Array.isArray(body.tools))
    for (const item of body.tools)
      counter.metadata(item)
  if (Array.isArray(body.messages))
    for (const item of body.messages)
      counter.unit(item, item.role === "assistant" ? "assistant" : Array.isArray(item.content) && item.content.every((part: Record<string, unknown>) => part.type === "tool_result") ? "tool" : "user", () => {
        if (Array.isArray(item.content))
          for (const part of item.content)
            block(part, "visibleText")
        else
          block(item.content, "visibleText")
      })
  const excluded = new Set(["model", "system", "messages", "tools", "max_tokens", "stream"])
  const other = Object.fromEntries(Object.entries(body).filter(([key]) => !excluded.has(key)))
  counter.structured("otherInput", other)
  const input = counter.finish({ protocol: "anthropic-messages", providerId: config.providerId, modelId: config.model, expectedModelId: config.model }, { system: body.system, tools: body.tools, messages: body.messages, other }, { system: body.system, tools: body.tools, other })
  return { input, packet: { sizeKind: "http-json-body" as const, inlineBinaryBytes: counter.inlineBinaryBytes, cacheMetadataBytes: counter.cacheMetadataBytes, signatureBytes: counter.signatureBytes } }
}
export function outputFacts(body: Record<string, unknown>, request: LLMRequest, config: AnthropicConfig) {
  const thinking = body.thinking as {
    type?: string
    budget_tokens?: number
  } | undefined
  const managed = request.reasoningEffort !== undefined && request.reasoningEffort !== "off"
  const budget = thinking?.type === "enabled" ? thinking.budget_tokens : undefined
  const capability = anthropicCapabilities(config)
  const ordinaryManual = capability?.modes.includes("enabled") && !(capability.manualInterleaving && hasInterleavedBeta(config.headers))
  const minimumCap = budget === undefined ? 1 : managed ? 1025 : ordinaryManual ? budget + 1 : 1
  return { capSupport: "supported" as const, configuredCap: request.maxOutputTokens ?? (typeof config.options?.max_tokens === "number" ? config.options.max_tokens : undefined), effectiveCap: typeof body.max_tokens === "number" ? body.max_tokens : undefined, minimumCap, reasoningBudget: budget, source: request.maxOutputTokens !== undefined ? "request" as const : config.options?.max_tokens !== undefined ? "route" as const : "adapter-default" as const }
}
export function capBody(body: Record<string, unknown>, cap: number | undefined, request: LLMRequest, config: AnthropicConfig) {
  cap ??= typeof config.options?.max_tokens === "number" ? config.options.max_tokens : ANTHROPIC_MAX_TOKENS_FALLBACK
  const thinking = body.thinking as {
    type?: string
    budget_tokens?: number
  } | undefined
  const desired = translateReasoning(config.model, request.reasoningEffort)
  const budget = desired?.thinking.type === "enabled" ? desired.thinking.budget_tokens : thinking?.budget_tokens
  return { ...body, max_tokens: cap, ...(thinking?.type === "enabled" && request.reasoningEffort !== undefined && request.reasoningEffort !== "off" ? { thinking: { ...thinking, budget_tokens: Math.min(budget!, cap - 1) } } : {}) }
}
