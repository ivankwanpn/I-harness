import { textProtocolToolResult, canReplayContinuation, isOfficialDeepSeekApi, officialXaiRoute, replayBlockOrder, replayVisibleToolOrder, responsesEndpoint, responsesEndpointFingerprint, type LLMContentPart, type LLMRequest } from "@i-harness/llm-seam"
import type { OpenAIConfig } from "../types.ts"

function toInputContent(content: string | LLMContentPart[]): unknown {
  if (typeof content === "string") return content
  return content.map((part) =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_image", image_url: `data:${part.image.mediaType};base64,${part.image.dataBase64}` },
  )
}

/** Remove explicit cache metadata only from documented content-block sites;
 * opaque tool arguments, tool text and native reasoning remain intact. */
export function withoutCacheBreakpoints(input: unknown): unknown {
  if (!Array.isArray(input)) return input
  const cleanBlocks = (blocks: unknown[]): unknown[] => blocks.map((block) => {
    if (typeof block !== "object" || block === null || Array.isArray(block)) return block
    const part = block as Record<string, unknown>
    if (part.type !== "input_text" && part.type !== "input_image" && part.type !== "input_file") return block
    const clean = { ...part }
    delete clean.prompt_cache_breakpoint
    return clean
  })
  return input.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item
    const record = item as Record<string, unknown>
    if (record.type === "function_call_output" && Array.isArray(record.output)) return { ...record, output: cleanBlocks(record.output) }
    if (Array.isArray(record.content) && (record.type === "message" || typeof record.role === "string")) return { ...record, content: cleanBlocks(record.content) }
    return item
  })
}

/** Map projected history, preserving native continuation ordering and tool images. */
export function mapMessages(messages: LLMRequest["messages"], config: Pick<OpenAIConfig, "model" | "providerId" | "baseUrl">, codexSubscription: boolean, reasoningOwner?: (ordinal: number) => void): unknown[] {
  const deepSeek = !codexSubscription && isOfficialDeepSeekApi(config.baseUrl)
  let assistantOrdinal = -1
  const recordReasoning = (items: Record<string, unknown>[]) => {
    if (reasoningOwner) for (const item of items) if (item.type === "reasoning") reasoningOwner(assistantOrdinal)
  }
  let targetFingerprint: string | null | undefined
  const matchesEndpoint = (source: string | null) => {
    if (source === null) return false
    if (targetFingerprint === undefined) targetFingerprint = responsesEndpointFingerprint(responsesEndpoint(config.baseUrl, codexSubscription), codexSubscription)
    return source === targetFingerprint
  }
  return messages
    .map((m) => {
      if (m.role === "user") return { role: "user", content: toInputContent(m.content) }
      if (m.role === "tool") {
        const content = textProtocolToolResult(m)
        // Responses scopes ordered text and image parts to the original
        // call_id. Keep the existing string encoding for text-only results.
        const output = Array.isArray(content) && content.every(part => part.type === "text")
          ? content.map(part => part.text).join("") : toInputContent(content)
        return { type: "function_call_output", call_id: m.toolCallId, output }
      }
      // assistant
      assistantOrdinal++
      const previous = m.providerContinuation
      const continuation = previous?.kind === "openai-responses" && canReplayContinuation(previous, config)
        && (previous.replayEndpointFingerprint === undefined || previous.providerId === config.providerId && previous.model === config.model && matchesEndpoint(previous.replayEndpointFingerprint))
        && (previous.deepSeekReplayFingerprint === undefined || deepSeek)
        && (previous.origin === undefined || previous.origin === officialXaiRoute(config.baseUrl)?.origin) ? previous : undefined
      // DeepSeek's two APIs use different envelopes for the same provider text.
      // Require explicit matching provenance before translating an older round.
      const chatReasoning = deepSeek && config.providerId === "deepseek" && previous?.kind === "openai-compatible" && previous.providerId === config.providerId && previous.model === config.model
        ? previous.reasoningContent : undefined
      const originalReasoningItems = continuation?.reasoningItems ?? (chatReasoning ? [{ type: "reasoning", content: [{ type: "reasoning_text", text: chatReasoning }] }] : [])
      const calls = m.toolCalls?.map((c) => ({
        type: "function_call",
        call_id: c.id,
        name: c.name,
        ...(codexSubscription ? { namespace: "ih" } : {}),
        arguments: JSON.stringify(c.args),
      })) ?? []
      const ordered = replayBlockOrder<unknown>(continuation?.outputOrder, m.content, originalReasoningItems, calls,
        (content, phase) => ({ role: "assistant", content, ...(phase !== undefined ? { phase } : {}) }), m.toolCalls)
      if (ordered !== undefined) {
        if (originalReasoningItems.length) recordReasoning(originalReasoningItems)
        return ordered
      }
      if (!continuation && !originalReasoningItems.length) {
        const visible = replayVisibleToolOrder<unknown>(m, calls, text => ({ role: "assistant", content: text }))
        if (visible) return visible
      }
      // An order envelope that no longer matches the neutral message is
      // stale. Its native reasoning belongs to that old assistant text.
      // Old logs without an order envelope keep their historical replay.
      const reasoningItems = continuation?.outputOrder ? [] : originalReasoningItems
      if (reasoningItems.length) recordReasoning(reasoningItems)
      if (m.toolCalls && m.toolCalls.length > 0) {
        // M51/B2: a folded step message carries the step's text AND its
        // tool calls — emit the assistant text item before the
        // function_call items (dropping it lost the narration).
        return [...reasoningItems, ...(m.content.trim() !== "" ? [{ role: "assistant", content: m.content }] : []), ...calls]
      }
      return reasoningItems.length ? [...reasoningItems, { role: "assistant", content: m.content }] : { role: "assistant", content: m.content }
    })
    .flat()
}
