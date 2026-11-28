import { bindVisibleToolIds, hasReorderedTools, stringifyJsonData, type LLMStreamEvent, type ProviderThinkingBlock, type ProviderBlockOrderEntry, type ProviderContinuation } from "@i-harness/llm-seam"
import type { AnthropicConfig } from "../types.ts"
import { mapUsage } from "./usage.ts"

/** One response owns all pending blocks, tool bindings, block order and terminal flags. */
export function createAnthropicFold(config: Pick<AnthropicConfig, "model" | "providerId">, prefixFingerprint: () => string, onToolArguments: () => void, producerWitness?: Extract<ProviderContinuation, { kind: 'anthropic' }>['producerWitness']) {
  let truncated = false
  let refused = false
  const thinkingBlocks: ProviderThinkingBlock[] = []
  const blockOrder = new Map<number, ProviderBlockOrderEntry>()
  let startedTools = 0
  const toolBindings: { id?: string; name: string; inputJson: string }[] = []
  const pendingThinking = new Map<number, { thinking: string; signature: string }>()
  const pendingToolUses = new Map<number, { id?: string; name: string; argsBuffer: string }>()
  // A-01: the Messages wire terminates with message_stop. Its absence means the
  // connection dropped mid-turn; previously EOF was reported as a clean end.
  let receivedStop = false
  const handleEvent = (event: Record<string, unknown>): LLMStreamEvent[] => {
    const t = event.type as string
    if (t === "message_stop") { receivedStop = true; return [] }
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
      if (stop === "max_tokens" || stop === "model_context_window_exceeded") truncated = true
      if (stop === "refusal") refused = true
      const usage = mapUsage(event.usage)
      return usage ? [{ type: "usage", usage }] : []
    }
    if (t === "content_block_start") {
      const block = event.content_block as { type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string; signature?: string; data?: string }
      if (block?.type === "tool_use") {
        startedTools++
        const input = block.input as Record<string, unknown> | undefined
        // Some streams send the full input inline on the start event; if
        // present (and non-empty) seed the args buffer with it.
        const hasInlineInput = !!input && Object.keys(input).length > 0
        pendingToolUses.set(index, {
          ...(block.id ? { id: block.id } : {}),
          name: block.name ?? "",
          argsBuffer: hasInlineInput ? stringifyJsonData(input)! : "",
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
        try {
          const args = JSON.parse(pending.argsBuffer.trim() === "" ? "{}" : pending.argsBuffer) as unknown
          blockOrder.set(index, { kind: "tool", index: toolBindings.length })
          toolBindings.push({ ...(pending.id ? { id: pending.id } : {}), name: pending.name, inputJson: stringifyJsonData(args)! })
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
    if (!receivedStop) return { type: "error", error: new Error("Anthropic stream ended without message_stop") }
    // M77: each bit is written on its own (a response can be both), and both
    // absent ⇒ the byte-exact `{ type: "end" }` every clean ending returned.
    const contentOrder = bindVisibleToolIds([...blockOrder.entries()].sort(([left], [right]) => left - right).map(([, entry]) => entry), toolBindings)
    const rank = { reasoning: 0, text: 1, tool: 2 } as const
    let previousRank = -1
    const interleaved = contentOrder.some((entry) => {
      const current = rank[entry.kind]
      const outOfOrder = current < previousRank
      previousRank = Math.max(previousRank, current)
      return outOfOrder
    }) || hasReorderedTools(contentOrder)
    const ids = new Set<string>()
    const bindingsComplete = toolBindings.length === startedTools && toolBindings.every(binding => {
      if (!binding || !binding.id || ids.has(binding.id) || !/^[a-zA-Z0-9_-]{1,64}$/.test(binding.name)) return false
      ids.add(binding.id)
      const input: unknown = JSON.parse(binding.inputJson)
      return input !== null && typeof input === 'object' && !Array.isArray(input)
    })
    const capturedWitness = producerWitness && !truncated && !refused && !pendingThinking.size && !pendingToolUses.size && bindingsComplete ? producerWitness : undefined
    return { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}), ...(thinkingBlocks.length ? { thinkingBlocks } : {}), ...(thinkingBlocks.length || interleaved ? { providerContinuation: { kind: "anthropic", model: config.model, ...(config.providerId ? { providerId: config.providerId } : {}), ...(interleaved ? { contentOrder } : {}), ...(thinkingBlocks.length ? { prefixFingerprint: prefixFingerprint(), ...(capturedWitness ? { producerWitness: capturedWitness } : {}) } : {}), ...(toolBindings.length ? { toolBindings } : {}) } as const } : {}) }
  }
  return { handleEvent, finish, get terminal() { return receivedStop } }
}
