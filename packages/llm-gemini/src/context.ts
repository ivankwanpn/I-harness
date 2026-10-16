import { ProjectionCounter } from "@i-harness/token-meter"
import { type LLMRequest } from "@i-harness/llm-seam"
import type { GeminiConfig } from "./types.ts"
import { field, int32, record } from './request/protojson.ts'
export function describeContext(body: Record<string, unknown>, config: GeminiConfig) {
  const contents = field(body, 'contents'), system = field(body, 'systemInstruction'), tools = field(body, 'tools'), cached = field(body, 'cachedContent')
  const counter = new ProjectionCounter("projected-pricing-v2")
  counter.metadata(body)
  counter.structured("system", system)
  counter.structured("toolSchemas", tools)
  const inlineMedia = (value: Record<string, unknown>) => {
    if (typeof field(value, 'mimeType') === 'string' && (field(value, 'mimeType') as string).startsWith('image/')) counter.image(value.data)
    else { counter.structured('otherInput', value); counter.uncertainties.add('inline-media-unpriced') }
  }
  if (Array.isArray(contents))
    for (const item of contents)
      counter.unit(item, item.role === "model" ? "assistant" : Array.isArray(item.parts) && item.parts.every((part: Record<string, unknown>) => field(part, 'functionResponse') !== undefined) ? "tool" : "user", () => {
        if (!Array.isArray(item.parts)) {
          counter.structured("otherInput", item)
          return
        }
        for (const part of item.parts) {
          counter.metadata({ ...part, thoughtSignature: field(part, 'thoughtSignature') })
          const inline = field(part, 'inlineData'), file = field(part, 'fileData'), call = field(part, 'functionCall'), result = field(part, 'functionResponse')
          if (record(inline))
            inlineMedia(inline)
          else if (file) {
            counter.image(undefined)
            counter.uncertainties.add("external-image-token-cost")
          }
          else if (call)
            counter.structured("toolArguments", call)
          else if (record(result)) {
            const { parts: _media, ...response } = result
            counter.structured("toolResults", response)
            const media = field(result, 'parts')
            if (Array.isArray(media)) for (const part of media) { const inline = field(part, 'inlineData'); if (record(inline)) inlineMedia(inline) }
          }
          else if (part.text !== undefined)
            counter.text(part.thought ? "replayedReasoning" : "visibleText", part.text)
          else
            counter.structured("otherInput", part)
        }
      })
  const referenced = cached !== undefined
  if (referenced)
    counter.uncertainties.add("external-cached-content")
  const excluded = new Set(["contents", "systemInstruction", 'system_instruction', "tools", "generationConfig", 'generation_config', "cachedContent", 'cached_content'])
  let generation = field(body, 'generationConfig')
  if (generation !== null && typeof generation === "object" && !Array.isArray(generation)) {
    const { maxOutputTokens: _cap, max_output_tokens: _aliasCap, ...semanticOptions } = generation as Record<string, unknown>
    generation = Object.keys(semanticOptions).length ? semanticOptions : undefined
  }
  const other = { ...Object.fromEntries(Object.entries(body).filter(([key]) => !excluded.has(key))), ...(generation !== undefined ? { generationConfig: generation } : {}) }
  counter.structured("otherInput", other)
  const overrides: ("model" | "system" | "messages" | "tools")[] = []
  for (const [wire, alias, neutral] of [["model", 'model', "model"], ["systemInstruction", 'system_instruction', "system"], ["contents", 'contents', "messages"], ["tools", 'tools', "tools"]] as const)
    if (Object.hasOwn(config.options ?? {}, wire) || Object.hasOwn(config.options ?? {}, alias)) overrides.push(neutral)
  const input = counter.finish({ protocol: "gemini", providerId: config.providerId, modelId: config.model, expectedModelId: config.model }, { system, tools, contents, cachedContent: cached, other }, { system, tools, other }, overrides, referenced || counter.uncertainties.has("external-image-token-cost") || counter.uncertainties.has('inline-media-unpriced') ? "incomplete" : "complete")
  return { input, packet: { sizeKind: "http-json-body" as const, inlineBinaryBytes: counter.inlineBinaryBytes, cacheMetadataBytes: counter.cacheMetadataBytes, signatureBytes: counter.signatureBytes } }
}
export function outputFacts(body: Record<string, unknown>, request: LLMRequest, config: GeminiConfig) {
  const generation = field(body, 'generationConfig'), raw = field(config.options, 'generationConfig')
  const budget = int32(field(field(generation, 'thinkingConfig'), 'thinkingBudget')), rawCap = int32(field(raw, 'maxOutputTokens'))
  return { capSupport: "supported" as const, configuredCap: request.maxOutputTokens ?? rawCap, effectiveCap: int32(field(generation, 'maxOutputTokens')), minimumCap: 1, reasoningBudget: budget !== undefined && budget >= 0 ? budget : undefined, source: request.maxOutputTokens !== undefined ? "request" as const : rawCap !== undefined ? "route" as const : "provider-default" as const }
}
