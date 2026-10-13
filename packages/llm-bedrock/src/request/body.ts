import type { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime"
import type { LLMRequest } from "@i-harness/llm-seam"
import type { BedrockConfig } from "../types.ts"
import { translateReasoning } from "./reasoning.ts"
import { toConverseMessages } from "./messages.ts"

export function buildConverseBody(config: BedrockConfig, request: LLMRequest, messages: LLMRequest["messages"]): { body: ConverseStreamCommandInput; error?: never } | { error: Error; body?: never } {
  // M32: request-level effort wins over config.options (explicit per-request intent).
  const reasoning = translateReasoning(config.model, request.reasoningEffort)
  const legacyThinking = reasoning?.thinking?.type === "enabled" ? reasoning.thinking : undefined
  const outputLimit = request.maxOutputTokens ?? (legacyThinking ? 8192 : undefined)
  if (legacyThinking && outputLimit !== undefined && outputLimit <= 1024) {
    return { error: new Error("Bedrock Claude thinking requires maxTokens above 1024") }
  }
  const effectiveReasoning = legacyThinking && outputLimit !== undefined
    ? { ...reasoning, thinking: { type: "enabled" as const, budget_tokens: Math.min(legacyThinking.budget_tokens, outputLimit - 1) } }
    : reasoning
  const wireMessages = toConverseMessages(config, messages)
  const body: ConverseStreamCommandInput = {
    modelId: config.model,
    ...(request.systemPrompt.trim() !== "" ? { system: [{ text: request.systemPrompt }] } : {}),
    messages: wireMessages as ConverseStreamCommandInput["messages"],
    ...(request.tools.length > 0
      ? { toolConfig: { tools: request.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } })) } as ConverseStreamCommandInput["toolConfig"] }
      : {}),
    ...(config.options !== undefined || effectiveReasoning !== undefined
      ? { additionalModelRequestFields: { ...(config.options ?? {}), ...(effectiveReasoning ?? {}) } as ConverseStreamCommandInput["additionalModelRequestFields"] }
      : {}),
    // M72 Ⅱ: Converse accepts maxTokens ONLY inside inferenceConfig, which
    // this adapter has never built (every option went to
    // additionalModelRequestFields, which the wire does not read for it).
    ...(outputLimit !== undefined
      ? { inferenceConfig: { maxTokens: outputLimit } }
      : {}),
  }
  return { body }
}
