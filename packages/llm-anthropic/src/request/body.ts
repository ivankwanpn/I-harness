import { ANTHROPIC_MAX_TOKENS_FALLBACK, resolvePromptCacheMode, type LLMMessage, type LLMRequest, type PromptCacheConfig } from "@i-harness/llm-seam"
import type { AnthropicConfig } from "../types.ts"
import { toWireMessages } from "./messages.ts"
import { translateReasoning } from "./reasoning.ts"
import type { CacheEdit, CacheEvidence } from "./cache-evidence.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Work on the final wire copy so cache markers never enter signed-continuation
 * fingerprints or mutate the neutral transcript. Only cache-control locations
 * are visited: a tool schema or tool argument named cache_control is data. */
function applyPromptCache(body: Record<string, unknown>, config: PromptCacheConfig | undefined, intent: LLMRequest["promptCache"], edits: CacheEdit[]): Record<string, unknown> {
  const mode = resolvePromptCacheMode(config, intent)
  if (mode === undefined) return body
  const tools = Array.isArray(body.tools) ? body.tools : []
  const messages = Array.isArray(body.messages) ? body.messages : []
  const blocks = (content: unknown): Record<string, unknown>[] => Array.isArray(content) ? content.filter(isRecord) : []
  const cleanBlock = (block: unknown): unknown => {
    if (!isRecord(block)) return block
    const clean = { ...block }
    delete clean.cache_control
    if (block.type === "tool_result" && Array.isArray(block.content)) clean.content = block.content.map(cleanBlock)
    return clean
  }
  if (mode === "off") {
    const clean = { ...body }
    delete clean.cache_control
    return {
      ...clean,
      system: Array.isArray(body.system) ? body.system.map(cleanBlock) : body.system,
      tools: tools.map(cleanBlock),
      messages: messages.map((message) => isRecord(message) && Array.isArray(message.content) ? { ...message, content: message.content.map(cleanBlock) } : message),
    }
  }
  // A caller's existing automatic wire option also occupies one slot. Its TTL
  // wins so the final explicit block cannot disagree with that moving marker.
  const manual = isRecord(body.cache_control) ? body.cache_control : undefined
  const retention = manual?.type === "ephemeral" ? manual.ttl : config?.retention
  const marker = { type: "ephemeral", ...(retention !== undefined ? { ttl: retention } : {}) }
  let used = Object.hasOwn(body, "cache_control") ? 1 : 0
  const countBlock = (block: Record<string, unknown>): void => {
    if (Object.hasOwn(block, "cache_control")) used++
    if (block.type === "tool_result") for (const inner of blocks(block.content)) countBlock(inner)
  }
  for (const block of [...blocks(body.system), ...tools.filter(isRecord), ...messages.flatMap((message) => isRecord(message) ? blocks(message.content) : [])]) countBlock(block)
  const mark = (block: Record<string, unknown>, path?: (string | number)[]): Record<string, unknown> => {
    if (used >= 4 || Object.hasOwn(block, "cache_control")) return block
    used++
    if (path) edits.push({ path: [...path, "cache_control"], inserted: { ...marker } })
    return { ...block, cache_control: { ...marker } }
  }
  let system = body.system
  if (typeof system === "string" && system.length > 0 && used < 4) {
    const original = system
    system = [mark({ type: "text", text: system })]
    edits.push({ path: ["system"], inserted: system, original })
  }
  const cachedTools = tools.map((tool, index) => index === tools.length - 1 && isRecord(tool) ? mark(tool, ["tools", index]) : tool)
  const cachedMessages = [...messages]
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== "user") continue
    if (typeof message.content === "string") {
      if (message.content.length === 0 || used >= 4) continue
      cachedMessages[index] = { ...message, content: [mark({ type: "text", text: message.content })] }
      edits.push({ path: ["messages", index, "content"], inserted: (cachedMessages[index] as Record<string, unknown>).content, original: message.content })
      break
    }
    if (!Array.isArray(message.content)) continue
    const content = [...message.content]
    const last = content.findLastIndex((block) => isRecord(block) && (block.type === "tool_result" || block.type === "image" || block.type === "text" && typeof block.text === "string" && block.text.length > 0))
    if (last === -1) continue
    content[last] = mark(content[last] as Record<string, unknown>, ["messages", index, "content", last])
    cachedMessages[index] = { ...message, content }
    break
  }
  return { ...body, system, tools: cachedTools, messages: cachedMessages }
}

/** Build the signed prefix first, then add cache markers only to the wire copy. */
export function createRequestBody(config: AnthropicConfig, request: LLMRequest, messages: LLMMessage[]):
  | { error: Error }
  | { body: Record<string, unknown>; payload: Record<string, unknown>; cacheEvidence: CacheEvidence } {
  const maxTokens = request.maxOutputTokens ??
    (typeof config.options?.max_tokens === "number" ? config.options.max_tokens : ANTHROPIC_MAX_TOKENS_FALLBACK)
  const reasoning = translateReasoning(config.model, request.reasoningEffort)
  if (reasoning && reasoning.thinking.type === "enabled" && maxTokens <= 1024) {
    return { error: new Error("anthropic thinking requires max_tokens above 1024") }
  }
  const boundedReasoning = reasoning?.thinking.type === "enabled"
    ? { thinking: { type: "enabled" as const, budget_tokens: Math.min(reasoning.thinking.budget_tokens, maxTokens - 1) } }
    : reasoning
  const wireTools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
  const wireMessages = toWireMessages(config, request, messages, wireTools)
  const body = {
    ...(config.options ?? {}),
    // Extra route options must not replace the selected model or the
    // neutral transcript that provenance and signature checks describe.
    model: config.model,
    system: request.systemPrompt,
    messages: wireMessages,
    tools: wireTools,
    stream: true,
    // M32: request-level effort wins over config.options (explicit per-request intent).
    ...(boundedReasoning ?? {}),
    // M72 Ⅱ: `max_tokens` is REQUIRED by the Messages API — the one wire
    // where "send nothing" is not an option. The chain is request → route
    // options → the named constant, so a route that already configured
    // `options.max_tokens` keeps working and the constant is the last resort.
    max_tokens: maxTokens,
  }
  const cacheEdits: CacheEdit[] = []
  const payload = applyPromptCache(body, config.promptCache, request.promptCache, cacheEdits)
  return { body, payload, cacheEvidence: { adapter: "anthropic-messages", revision: "anthropic-cache-v1", edits: cacheEdits } }
}
