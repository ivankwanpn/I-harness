import { stringifyJsonData, type LLMStreamEvent, type ProviderThinkingBlock, type ProviderBlockOrderEntry, type RetryableErrorCode, type ProviderContinuation } from "@i-harness/llm-seam"
import type { AnthropicConfig } from "../types.ts"
import { mapUsage } from "./usage.ts"

/** One response owns all pending blocks, tool bindings, block order and terminal flags. */
export function createAnthropicFold(config: Pick<AnthropicConfig, "model" | "providerId">, prefixFingerprint: () => string, onToolArguments: () => void, producerWitness?: Extract<ProviderContinuation, { kind: 'anthropic' }>['producerWitness']) {
  // M72 Ⅱ: the wire's own truncation literal (`stop_reason: "max_tokens"`)
  // — set in `handleEvent` below, read once at the ending. Absent stays
  // absent: only `true` writes the field.
  let truncated = false
  // M77: `stop_reason: "refusal"` — the model declined to produce content.
  // Its sibling `stop_reason: "model_context_window_exceeded"` is NOT a
  // refusal (it is an input-side signal) and does not set this: that arm
  // yields the seam's existing `CONTEXT_WINDOW_EXCEEDED` error code
  // instead. A separate variable from `truncated` because the two are
  // independent — neither is the other's `else`. Only `true` is written.
  let refused = false
  const thinkingBlocks: ProviderThinkingBlock[] = []
  const blockOrder = new Map<number, ProviderBlockOrderEntry>()
  let toolOrdinal = 0
  const toolBindings: { id?: string; name: string; inputJson: string }[] = []
  const pendingThinking = new Map<number, { thinking: string; signature: string }>()
  const pendingToolUses = new Map<number, { id?: string; name: string; argsBuffer: string; ordinal: number }>()
  const handleEvent = (event: Record<string, unknown>): LLMStreamEvent[] => {
    const t = event.type as string
    const index = event.index as number
    // M5 T2: the two events that carry usage, until now falling through to
    // `return []` with their numbers unread. They arrive on DIFFERENT ends
    // of the same round-trip — message_start holds the input side (including
    // both cache counts), message_delta the final output count — so the
    // consumer merges them rather than this adapter buffering.
    if (t === "message_start") {
      const usage = mapUsage((event.message as { usage?: unknown } | undefined)?.usage)
      return usage ? [{ type: "usage", usage }] : []
    }
    if (t === "message_delta") {
      const stop = (event.delta as { stop_reason?: string } | undefined)?.stop_reason
      if (stop === "max_tokens") truncated = true
      // M77: the model refused. HTTP 200 with no content, so before M77
      // the seam reported an empty SUCCESS for a turn the model declined.
      if (stop === "refusal") refused = true
      // M77: and this one is deliberately NOT the bit. The Messages API
      // states the INPUT did not fit, and the seam already owns that
      // vocabulary — `RetryableErrorCode`'s `CONTEXT_WINDOW_EXCEEDED`,
      // classified by the seam's retry classifier off an error's `code`
      // field and deliberately absent from the default retryable set (a
      // retry cannot shrink an over-window request). So the code goes on
      // that same field, in this adapter's existing `${label}: ${detail}`
      // error shape, and the event is terminal — no `end`, no bit, and the
      // consumer learns "the provider said the window is too small"
      // instead of seeing a silent empty success.
      // M77 (fix wave): mapped BEFORE the context arm's early return. That
      // arm used to return first, and this same `message_delta` is the one
      // that carries the round-trip's output count — so the number was
      // dropped for a round-trip the provider had already priced. The
      // retry wrapper hides it (a held-aside `usage` is discarded when the
      // attempt settles on an error); an unwrapped client saw nil. The
      // error is still terminal, and the report rides AHEAD of it: `emit`
      // stops at the first error event, so anything after it is never seen.
      const usage = mapUsage(event.usage)
      if (stop === "model_context_window_exceeded") {
        const error = new Error(`stop_reason: ${stop}`) as Error & { code?: RetryableErrorCode }
        error.code = "CONTEXT_WINDOW_EXCEEDED"
        return usage ? [{ type: "usage", usage }, { type: "error", error }] : [{ type: "error", error }]
      }
      return usage ? [{ type: "usage", usage }] : []
    }
    if (t === "content_block_start") {
      const block = event.content_block as { type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string; signature?: string; data?: string }
      if (block?.type === "tool_use") {
        const ordinal = toolOrdinal++
        blockOrder.set(index, { kind: "tool", index: ordinal })
        const input = block.input as Record<string, unknown> | undefined
        // Some streams send the full input inline on the start event; if
        // present (and non-empty) seed the args buffer with it.
        const hasInlineInput = !!input && Object.keys(input).length > 0
        pendingToolUses.set(index, {
          ...(block.id ? { id: block.id } : {}),
          name: block.name ?? "",
          argsBuffer: hasInlineInput ? stringifyJsonData(input)! : "",
          ordinal,
        })
      } else if (block?.type === "thinking") {
        pendingThinking.set(index, { thinking: block.thinking ?? "", signature: block.signature ?? "" })
        return [{ type: "reasoning", blockId: String(index), text: block.thinking ?? "" }]
      } else if (block?.type === "redacted_thinking" && typeof block.data === "string") {
        thinkingBlocks.push({ type: "redacted_thinking", data: block.data })
        blockOrder.set(index, { kind: "reasoning", index: thinkingBlocks.length - 1 })
      } else if (block?.type === "text") {
        blockOrder.set(index, { kind: "text", text: block.text ?? "" })
        return block.text ? [{ type: "text/chunk", text: block.text }] : []
      }
      return []
    }
    if (t === "content_block_delta") {
      const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string }
      if (delta?.type === "text_delta") {
        const block = blockOrder.get(index)
        if (block?.kind === "text") block.text += delta.text ?? ""
        return [{ type: "text/chunk", text: delta.text ?? "" }]
      }
      if (delta?.type === "input_json_delta") {
        const pending = pendingToolUses.get(index)
        if (pending) { pending.argsBuffer += delta.partial_json ?? ""; if (delta.partial_json) onToolArguments() }
        return []
      }
      if (delta?.type === "thinking_delta") {
        const pending = pendingThinking.get(index)
        if (pending) pending.thinking += delta.thinking ?? ""
        return [{ type: "reasoning", blockId: String(index), text: delta.thinking ?? "" }]
      }
      if (delta?.type === "signature_delta") {
        const pending = pendingThinking.get(index)
        if (pending) pending.signature += delta.signature ?? ""
      }
      return []
    }
    if (t === "content_block_stop") {
      const thinking = pendingThinking.get(index)
      if (thinking) {
        pendingThinking.delete(index)
        if (thinking.signature) {
          thinkingBlocks.push({ type: "thinking", thinking: thinking.thinking, signature: thinking.signature })
          blockOrder.set(index, { kind: "reasoning", index: thinkingBlocks.length - 1 })
        }
      }
      const pending = pendingToolUses.get(index)
      if (pending) {
        pendingToolUses.delete(index)
        if (pending.argsBuffer.trim() === "") {
          // Empty inline input ({}) with no deltas → no-arg tool call.
          toolBindings[pending.ordinal] = { ...(pending.id ? { id: pending.id } : {}), name: pending.name, inputJson: "{}" }
          return [{ type: "tool_call", call: { ...(pending.id ? { id: pending.id } : {}), name: pending.name, args: {} } }]
        }
        try {
          const args = JSON.parse(pending.argsBuffer) as unknown
          toolBindings[pending.ordinal] = { ...(pending.id ? { id: pending.id } : {}), name: pending.name, inputJson: stringifyJsonData(args)! }
          return [{ type: "tool_call", call: { ...(pending.id ? { id: pending.id } : {}), name: pending.name, args } }]
        } catch {
          return [{ type: "error", error: new Error("anthropic malformed tool_use input") }]
        }
      }
      return []
    }
    // M72 Ⅰ: Anthropic reports mid-stream failures as an SSE `error` event on
    // an HTTP 200 stream. Without this arm the event fell into `return []`,
    // the loop finished, and the caller got a clean `end` for a failed
    // round-trip — the seam's own words: a failure must not read as success.
    if (t === "error") {
      const err = event.error as { type?: string; message?: string } | undefined
      return [{ type: "error", error: Object.assign(new Error(`${err?.type ?? "error"}: ${err?.message ?? "provider reported an error"}`), typeof err?.type === "string" ? { code: err.type } : {}) }]
    }
    return []
  }
  const finish = (): LLMStreamEvent => {
    // M77: each bit is written on its own (a response can be both), and both
    // absent ⇒ the byte-exact `{ type: "end" }` every clean ending returned.
    const contentOrder = [...blockOrder.entries()].sort(([left], [right]) => left - right).map(([, entry]) => entry)
    const rank = { reasoning: 0, text: 1, tool: 2 } as const
    let previousRank = -1
    const interleaved = contentOrder.some((entry) => {
      const current = rank[entry.kind]
      const outOfOrder = current < previousRank
      previousRank = Math.max(previousRank, current)
      return outOfOrder
    })
    const ids = new Set<string>()
    const bindingsComplete = toolBindings.length === toolOrdinal && [...toolBindings].every(binding => {
      if (!binding || !binding.id || ids.has(binding.id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(binding.name)) return false
      ids.add(binding.id)
      const input: unknown = JSON.parse(binding.inputJson)
      return input !== null && typeof input === 'object' && !Array.isArray(input)
    })
    const capturedWitness = producerWitness && !truncated && !refused && !pendingThinking.size && !pendingToolUses.size && bindingsComplete ? producerWitness : undefined
    return { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}), ...(thinkingBlocks.length ? { thinkingBlocks } : {}), ...(thinkingBlocks.length || interleaved ? { providerContinuation: { kind: "anthropic", model: config.model, ...(config.providerId ? { providerId: config.providerId } : {}), ...(interleaved ? { contentOrder } : {}), ...(thinkingBlocks.length ? { prefixFingerprint: prefixFingerprint(), ...(capturedWitness ? { producerWitness: capturedWitness } : {}) } : {}), ...(toolBindings.length ? { toolBindings } : {}) } as const } : {}) }
  }
  return { handleEvent, finish }
}
