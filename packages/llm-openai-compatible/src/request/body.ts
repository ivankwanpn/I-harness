import { resolvePromptCacheMode, type LLMRequest } from "@i-harness/llm-seam"
import type { OpenAICompatibleConfig } from "../types.ts"
import { toWireMessages } from "./messages.ts"
import { translateReasoning } from "./reasoning.ts"

/** Assemble only wire fields after the client has projected images. */
export function createRequestBody(config: OpenAICompatibleConfig, request: LLMRequest, messages: LLMRequest["messages"]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    // M72 Ⅰ: the system prompt is the first MESSAGE. The old code sent no
    // system content at all — chat/completions has no top-level `system`
    // FIELD, but the role IS the mapping, and dropping it meant every
    // request to a compatible gateway ran without its system prompt.
    // Blank → no message: same rule as llm-gemini/llm-bedrock, and an
    // empty system turn is pure overhead.
    messages: [
      ...(request.systemPrompt.trim() !== "" ? [{ role: "system", content: request.systemPrompt }] : []),
      ...toWireMessages(messages, config),
    ],
    tools: request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
    stream: true,
    // M72 Ⅲ: usage must be ASKED for on this wire (the other four report it
    // unasked). Default ON — a routing flag, not a guess about capability;
    // a gateway that rejects the key is switched off per route with
    // `usageInStream: false` (Pi's supportsUsageInStreaming, explicit).
    // Written BEFORE the route's raw `options` so the more specific
    // statement still wins: an `options` key that collides must override
    // this default, never be clobbered by it.
    ...((config.usageInStream ?? true) ? { stream_options: { include_usage: true } } : {}),
    ...(config.options ?? {}),
    // M32: request-level effort wins over config.options (explicit per-request intent).
    ...(translateReasoning(config.model, request.reasoningEffort) ?? {}),
    // M72 Ⅱ: the field NAME is a per-route choice — `max_tokens` is what
    // compatible gateways take, `max_completion_tokens` is what the newest
    // OpenAI models demand. Explicit config, not a guess (Pi's
    // maxTokensField solves the same problem by probing).
    ...(request.maxOutputTokens !== undefined
      ? { [config.maxTokensField ?? "max_tokens"]: request.maxOutputTokens }
      : {}),
  }
  if (resolvePromptCacheMode(config.promptCache, request.promptCache) === "off") {
    delete body.prompt_cache_key
    delete body.prompt_cache_retention
    delete body.prompt_cache_options
  }
  return body
}
