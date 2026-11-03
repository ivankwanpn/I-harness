import { resolvePromptCacheMode, type LLMRequest } from "@i-harness/llm-seam"
import type { GeminiConfig } from "../types.ts"
import { translateReasoning } from "./reasoning.ts"
import { field, record } from './protojson.ts'

export function createRequestBody(request: LLMRequest, config: GeminiConfig, contents: { role: "user" | "model"; parts: unknown[] }[]): Record<string, unknown> {
  const { thinkingConfig: legacyThinkingConfig, ...configuredOptions } = config.options ?? {}
  const rawGenerationConfig = field(config.options, 'generationConfig')
  const generationKey = Object.hasOwn(config.options ?? {}, 'generation_config') ? 'generation_config' : 'generationConfig'
  const configuredGeneration = typeof rawGenerationConfig === "object" && rawGenerationConfig !== null && !Array.isArray(rawGenerationConfig)
    ? rawGenerationConfig as Record<string, unknown> : {}
  const rawThinking = field(configuredGeneration, 'thinkingConfig')
  const configuredThinking = record(rawThinking)
    ? rawThinking
    : typeof legacyThinkingConfig === "object" && legacyThinkingConfig !== null && !Array.isArray(legacyThinkingConfig)
      ? legacyThinkingConfig as Record<string, unknown> : undefined
  const requestedThinking = translateReasoning(config.model, request.reasoningEffort)?.thinkingConfig
  // Leave raw null/nonobject and alternate spelling intact when there is no
  // managed override. Validation sees the actual lowered value, not a repair.
  const changeGeneration = requestedThinking !== undefined || legacyThinkingConfig !== undefined || request.maxOutputTokens !== undefined
  const generationConfig: Record<string, unknown> = {
    ...configuredGeneration,
    ...(configuredThinking || requestedThinking ? { thinkingConfig: {
      ...(configuredThinking ?? {}),
      ...(requestedThinking ?? {}),
      ...(requestedThinking ? { includeThoughts: request.reasoningEffort !== "off" } : {}),
    } } : {}),
    ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
  }
  if (changeGeneration && request.maxOutputTokens !== undefined) delete generationConfig.max_output_tokens
  if (changeGeneration && (requestedThinking || legacyThinkingConfig)) delete generationConfig.thinking_config
  if (requestedThinking && record(generationConfig.thinkingConfig)) {
    const thinking = generationConfig.thinkingConfig
    if (Object.hasOwn(requestedThinking, 'thinkingBudget')) delete thinking.thinking_budget
    if (Object.hasOwn(requestedThinking, 'thinkingLevel')) delete thinking.thinking_level
    delete thinking.include_thoughts
  }
  const body: Record<string, unknown> = {
    contents,
    ...(request.systemPrompt.trim() !== "" ? { systemInstruction: { parts: [{ text: request.systemPrompt }] } } : {}),
    ...(request.tools.length > 0
      ? { tools: [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }] }
      : {}),
    ...configuredOptions,
    // GenerateContentRequest carries thinkingConfig inside generationConfig.
    // Preserve configured generation fields while request-level choices win.
    ...(changeGeneration && Object.keys(generationConfig).length ? { [generationKey]: generationConfig } : {}),
    // Both thinkingConfig and maxOutputTokens belong to generationConfig.
    // The parent stays absent when neither the route nor the request needs
    // generation settings.
  }
  if (resolvePromptCacheMode(config.promptCache, request.promptCache) === "off") delete body.cachedContent
  return body
}
