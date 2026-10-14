import { ProjectionCounter } from "@i-harness/token-meter"
import { invalidPreparedRequest, type LLMRequest } from "@i-harness/llm-seam"
import type { GeminiConfig } from "./types.ts"
export function describeContext(body: Record<string, unknown>, config: GeminiConfig) {
  // Gemini model is the URL path; a body model option cannot resolve another binding.
  if (body.model !== undefined && body.model !== config.model)
    throw invalidPreparedRequest("Actual request model does not match the resolved binding", "MODEL_BINDING_MISMATCH")
  const counter = new ProjectionCounter()
  counter.metadata(body)
  counter.structured("system", body.systemInstruction)
  counter.structured("toolSchemas", body.tools)
  if (Array.isArray(body.contents))
    for (const item of body.contents)
      counter.unit(item, item.role === "model" ? "assistant" : Array.isArray(item.parts) && item.parts.every((part: Record<string, unknown>) => part.functionResponse !== undefined) ? "tool" : "user", () => {
        if (!Array.isArray(item.parts)) {
          counter.structured("otherInput", item)
          return
        }
        for (const part of item.parts) {
          counter.metadata(part)
          if (part.inlineData)
            counter.image(part.inlineData.data)
          else if (part.fileData) {
            counter.image(undefined)
            counter.uncertainties.add("external-image-token-cost")
          }
          else if (part.functionCall)
            counter.structured("toolArguments", part.functionCall)
          else if (part.functionResponse)
            counter.structured("toolResults", part.functionResponse)
          else if (part.text !== undefined)
            counter.text(part.thought ? "replayedReasoning" : "visibleText", part.text)
          else
            counter.structured("otherInput", part)
        }
      })
  const referenced = body.cachedContent !== undefined
  if (referenced)
    counter.uncertainties.add("external-cached-content")
  const excluded = new Set(["contents", "systemInstruction", "tools", "generationConfig", "cachedContent"])
  const other = Object.fromEntries(Object.entries(body).filter(([key]) => !excluded.has(key)))
  counter.structured("otherInput", other)
  const overrides: ("model" | "system" | "messages" | "tools")[] = []
  for (const [wire, field] of [["model", "model"], ["systemInstruction", "system"], ["contents", "messages"], ["tools", "tools"]] as const)
    if (Object.hasOwn(config.options ?? {}, wire))
      overrides.push(field)
  const input = counter.finish({ protocol: "gemini", providerId: config.providerId, modelId: config.model, expectedModelId: config.model }, { system: body.systemInstruction, tools: body.tools, contents: body.contents, cachedContent: body.cachedContent, other }, { system: body.systemInstruction, tools: body.tools }, overrides, referenced || counter.uncertainties.has("external-image-token-cost") ? "incomplete" : "complete")
  return { input, packet: { sizeKind: "http-json-body" as const, inlineBinaryBytes: counter.inlineBinaryBytes, cacheMetadataBytes: counter.cacheMetadataBytes, signatureBytes: counter.signatureBytes } }
}
export function outputFacts(body: Record<string, unknown>, request: LLMRequest, config: GeminiConfig) {
  const generation = body.generationConfig as {
    maxOutputTokens?: number
    thinkingConfig?: {
      thinkingBudget?: number
    }
  } | undefined
  const raw = config.options?.generationConfig as {
    maxOutputTokens?: number
  } | undefined
  return { capSupport: "supported" as const, configuredCap: request.maxOutputTokens ?? raw?.maxOutputTokens, effectiveCap: generation?.maxOutputTokens, minimumCap: 1, reasoningBudget: generation?.thinkingConfig?.thinkingBudget !== undefined && generation.thinkingConfig.thinkingBudget >= 0 ? generation.thinkingConfig.thinkingBudget : undefined, source: request.maxOutputTokens !== undefined ? "request" as const : raw?.maxOutputTokens !== undefined ? "route" as const : "provider-default" as const }
}
