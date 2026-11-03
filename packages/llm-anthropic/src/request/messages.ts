import { projectionFingerprint } from "@i-harness/token-meter"
import { canReplayContinuation, replayBlockOrder, stringifyJsonData, type LLMContentPart, type LLMMessage, type LLMRequest } from "@i-harness/llm-seam"
import type { AnthropicConfig } from "../types.ts"

export function fingerprintPrefix(system: unknown, tools: unknown, messages: unknown): string {
  return projectionFingerprint({ system, tools, messages })
}

// Shape LLM content parts into Anthropic Messages content blocks. String
// content stays the legacy string. The same native text/image shape is legal
// inside tool_result; neutral image objects must never reach that wire.
function toAnthropicContent(content: string | LLMContentPart[]): unknown {
  if (typeof content === "string") return content
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", source: { type: "base64", media_type: part.image.mediaType, data: part.image.dataBase64 } },
  )
}

/** Map the projected transcript; continuation chain validity belongs to this request. */
export function toWireMessages(config: AnthropicConfig, request: LLMRequest, messages: LLMMessage[], wireTools: unknown[]): { role: "user" | "assistant"; content: unknown }[] {
  const wireMessages: { role: "user" | "assistant"; content: unknown }[] = []
  let toolResults: unknown[] | undefined
  let invalidThinkingChain = false
  for (const m of messages) {
    if (m.role === "tool") {
      if (toolResults === undefined) {
        toolResults = []
        wireMessages.push({ role: "user", content: toolResults })
      }
      toolResults.push({ type: "tool_result", tool_use_id: m.toolCallId, content: toAnthropicContent(m.content), ...(m.isError === true ? { is_error: true } : {}) })
      continue
    }
    toolResults = undefined
    if (m.role === "assistant" && (m.toolCalls?.length || m.thinkingBlocks?.length)) {
      const calls = m.toolCalls ?? []
      // New streams keep the provider's interleaved block order. Older
      // sessions without that metadata retain the canonical fallback.
      const continuation = m.providerContinuation?.kind === "anthropic" ? m.providerContinuation : undefined
      const sourceMatches = m.providerContinuation?.kind === undefined || continuation !== undefined && canReplayContinuation(continuation, config)
      const prefixMatches = continuation?.prefixFingerprint === undefined || continuation.prefixFingerprint === fingerprintPrefix(request.systemPrompt, wireTools, wireMessages)
      const toolsMatch = continuation?.prefixFingerprint === undefined || (continuation.toolBindings?.length ?? 0) === calls.length && (continuation.toolBindings ?? []).every((binding, index) => {
        const call = calls[index]
        return call !== undefined && binding.name === call.name && binding.inputJson === stringifyJsonData(call.args) && (binding.id === undefined || binding.id === call.id)
      })
      if (m.thinkingBlocks?.length) {
        // A later response produced after earlier blocks were dropped has
        // its own valid prefix. Its fingerprint starts a new chain.
        if (continuation?.prefixFingerprint !== undefined) invalidThinkingChain = !sourceMatches || !prefixMatches || !toolsMatch
        else if (!sourceMatches) invalidThinkingChain = true
      }
      let replayThinking = invalidThinkingChain ? [] : m.thinkingBlocks ?? []
      const toolBlocks = calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))
      const order = continuation && sourceMatches ? continuation.contentOrder : undefined
      let orderedContent = replayBlockOrder<unknown>(invalidThinkingChain ? order?.filter((entry) => entry.kind !== "reasoning") : order, m.content, replayThinking, toolBlocks, (text) => ({ type: "text", text }))
      if (order && orderedContent === undefined && replayThinking.length) {
        invalidThinkingChain = true
        replayThinking = []
        orderedContent = replayBlockOrder<unknown>(order.filter((entry) => entry.kind !== "reasoning"), m.content, [], toolBlocks, (text) => ({ type: "text", text }))
      }
      const content: unknown[] = orderedContent ?? [...replayThinking, ...(m.content.trim() !== "" ? [{ type: "text", text: m.content }] : []), ...toolBlocks]
      wireMessages.push({ role: "assistant", content })
      continue
    }
    wireMessages.push({ role: m.role, content: toAnthropicContent(m.content) })
  }
  return wireMessages
}
