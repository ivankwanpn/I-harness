import { resolvePromptCacheMode, type LLMRequest } from "@i-harness/llm-seam"
import type { GeminiConfig } from "../types.ts"
import { translateReasoning } from "./reasoning.ts"

export function createRequestBody(request: LLMRequest, config: GeminiConfig, contents: { role: "user" | "model"; parts: unknown[] }[]): Record<string, unknown> {
  const { thinkingConfig: legacyThinkingConfig, generationConfig: rawGenerationConfig, ...configuredOptions } = config.options ?? {}
  const configuredGeneration = typeof rawGenerationConfig === "object" && rawGenerationConfig !== null && !Array.isArray(rawGenerationConfig)
    ? rawGenerationConfig as Record<string, unknown> : {}
  const configuredThinking = typeof configuredGeneration.thinkingConfig === "object" && configuredGeneration.thinkingConfig !== null && !Array.isArray(configuredGeneration.thinkingConfig)
    ? configuredGeneration.thinkingConfig as Record<string, unknown>
    : typeof legacyThinkingConfig === "object" && legacyThinkingConfig !== null && !Array.isArray(legacyThinkingConfig)
      ? legacyThinkingConfig as Record<string, unknown> : undefined
  const requestedThinking = translateReasoning(config.model, request.reasoningEffort)?.thinkingConfig
  const generationConfig = {
    ...configuredGeneration,
    ...(configuredThinking || requestedThinking ? { thinkingConfig: {
      ...(configuredThinking ?? {}),
      ...(requestedThinking ?? {}),
      ...(requestedThinking ? { includeThoughts: request.reasoningEffort !== "off" } : {}),
    } } : {}),
    ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
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
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    // Both thinkingConfig and maxOutputTokens belong to generationConfig.
    // The parent stays absent when neither the route nor the request needs
    // generation settings.
  }
  if (resolvePromptCacheMode(config.promptCache, request.promptCache) === "off") delete body.cachedContent
  return body
}
