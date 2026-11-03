import { ProjectionCounter } from "@i-harness/token-meter"
import type { LLMRequest } from "@i-harness/llm-seam"
import type { OpenAICompatibleConfig } from "./types.ts"
export function describeContext(body: Record<string, unknown>, config: OpenAICompatibleConfig) {
  const counter = new ProjectionCounter("projected-pricing-v2")
  counter.metadata(body)
  let unknownInput = false
  counter.structured("toolSchemas", body.tools)
  if (Array.isArray(body.messages))
    for (const value of body.messages) {
      const item = value as Record<string, unknown>, category = item.role === "system" || item.role === "developer" ? "system" : item.role === "tool" ? "toolResults" : "visibleText"
      const visit = () => {
        if (item.role === 'assistant' && item.audio != null) {
          unknownInput = true
          counter.uncertainties.add('server-referenced-context-unavailable')
        }
        if (Array.isArray(item.content))
          for (const part of item.content) {
            if (part.type === "image_url") {
              const url = String(part.image_url?.url ?? "")
              if (url.startsWith("data:"))
                counter.image(url.slice(url.indexOf(",") + 1))
              else {
                counter.image(undefined)
                counter.uncertainties.add("external-image-token-cost")
              }
            }
            else if (typeof part.text === "string")
              counter.text(category, part.text)
            else {
              counter.structured("otherInput", part)
              unknownInput = true
              counter.uncertainties.add("unsupported-input-block-token-cost")
            }
          }
        else
          counter.text(category, item.content)
        counter.text("replayedReasoning", item.reasoning_content)
        counter.structured("toolArguments", item.tool_calls)
        counter.structured("framing", { name: item.name, tool_call_id: item.tool_call_id })
      }
      if (category === "system")
        visit()
      else
        counter.unit(value, item.role === "assistant" ? "assistant" : item.role === "tool" ? "tool" : "user", visit)
    }
  const excluded = new Set(["model", "messages", "tools", "max_tokens", "max_completion_tokens", "stream", "stream_options"])
  const other = Object.fromEntries(Object.entries(body).filter(([key]) => !excluded.has(key)))
  counter.structured("otherInput", other)
  const overrides: ("model" | "system" | "messages" | "tools")[] = []
  for (const key of ["model", "messages", "tools"] as const)
    if (Object.hasOwn(config.options ?? {}, key))
      overrides.push(key)
  const input = counter.finish({ protocol: "openai-compatible", providerId: config.providerId, modelId: config.model, expectedModelId: config.model }, { messages: body.messages, tools: body.tools, other }, { tools: body.tools, other, system: Array.isArray(body.messages) ? body.messages.filter(item => item.role === "system" || item.role === "developer") : [] }, overrides, unknownInput || counter.uncertainties.has("external-image-token-cost") ? "incomplete" : "complete")
  return { input, packet: { sizeKind: "http-json-body" as const, inlineBinaryBytes: counter.inlineBinaryBytes, cacheMetadataBytes: counter.cacheMetadataBytes, signatureBytes: counter.signatureBytes } }
}
export function outputFacts(body: Record<string, unknown>, request: LLMRequest, config: OpenAICompatibleConfig) {
  const field = config.maxTokensField ?? "max_tokens"
  const value = body[field] ?? body[field === "max_tokens" ? "max_completion_tokens" : "max_tokens"]
  return { capSupport: "supported" as const, configuredCap: request.maxOutputTokens ?? (typeof value === "number" ? value : undefined), effectiveCap: typeof value === "number" ? value : undefined, minimumCap: 1, source: request.maxOutputTokens !== undefined ? "request" as const : value !== undefined ? "route" as const : "provider-default" as const }
}
