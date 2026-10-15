import { resolvePromptCacheMode, type LLMRequest, type ReasoningEffort } from "@i-harness/llm-seam"
import type { OpenAIConfig } from "../types.ts"
import { mapMessages, withoutCacheBreakpoints } from "./messages.ts"
import type { GeneratedAffinity } from "./cache-evidence.ts"

/**
 * M32 openai-family translation table (Responses | Chat | DeepSeek — ONE
 * table, zero generation special-casing): the effort is passed through
 * verbatim and "off" maps to "none". A selected reasoning level also opts in
 * to the official Responses summary stream, which is distinct from private
 * model thoughts. Unset effort → undefined (don't send).
 */
export function translateReasoning(_model: string, effort: ReasoningEffort | undefined): { reasoning: { effort: string; summary?: "auto" } } | undefined {
  if (effort === undefined) return undefined
  return { reasoning: effort === "off" ? { effort: "none" } : { effort, summary: "auto" } }
}

/** Body precedence, cache policy, and account-bound wire restrictions. */
export function createRequestBody(
  config: Pick<OpenAIConfig, "model" | "providerId" | "options" | "promptCache">,
  request: Pick<LLMRequest, "systemPrompt" | "tools" | "reasoningEffort" | "maxOutputTokens" | "promptCache">,
  messages: LLMRequest["messages"],
  codexSubscription: boolean,
  subscriptionCacheKey?: () => string,
) {
  const body: Record<string, unknown> = {
    ...(codexSubscription ? config.options ?? {} : {}),
    model: config.model,
    instructions: request.systemPrompt,
    input: mapMessages(messages, config, codexSubscription),
    tools: request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })),
    stream: true,
    ...(!codexSubscription ? config.options ?? {} : {}),
    // M32: request-level effort wins over config.options (explicit per-request intent).
    ...(translateReasoning(config.model, request.reasoningEffort) ?? {}),
    // M72 Ⅱ: a request-level cap, so it lands after config.options (the
    // same precedence rule the reasoning line above documents).
    ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
  }
  const cacheMode = resolvePromptCacheMode(config.promptCache, request.promptCache)
  let generatedAffinity: GeneratedAffinity | undefined
  if (cacheMode === "off") {
    delete body.prompt_cache_key
    delete body.prompt_cache_retention
    delete body.prompt_cache_options
    body.input = withoutCacheBreakpoints(body.input)
  } else if (cacheMode === "automatic" && body.prompt_cache_key === undefined && request.promptCache?.key !== undefined) {
    body.prompt_cache_key = request.promptCache.key
  }
  // Native subscription parity; public/API-key route defaults stay intact.
  if (subscriptionCacheKey && cacheMode !== "off" && body.prompt_cache_key === undefined) {
    body.prompt_cache_key = request.promptCache?.key ?? subscriptionCacheKey()
    if (request.promptCache?.key === undefined) generatedAffinity = { adapter: "openai-responses-subscription", revision: "subscription-affinity-v1", path: "prompt_cache_key", value: body.prompt_cache_key as string }
  }
  if (codexSubscription) {
    // Match Codex 0.160.0 codex-api/src/common.rs ResponsesApiRequest;
    // HTTP carries the full input rather than a previous_response_id.
    const fields = new Set(["model", "instructions", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "stream", "stream_options", "include", "service_tier", "prompt_cache_key", "text", "client_metadata", "access_programs"])
    for (const field of Object.keys(body)) if (!fields.has(field)) delete body[field]
    body.store = false
    body.stream = true
    body.tool_choice ??= "auto"
    body.parallel_tool_calls ??= true
    body.include = [...new Set([...(Array.isArray(body.include) ? body.include.filter(value => typeof value === "string") : []), "reasoning.encrypted_content"])]
    // One adapter-owned namespace keeps neutral tool names stable during
    // execution and restores their wire namespace on every history replay.
    body.tools = request.tools.length ? [{
      type: "namespace", name: "ih", description: "I-harness local tools",
      tools: request.tools.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })),
    }] : []
  }
  return { body, cacheMode, generatedAffinity }
}
