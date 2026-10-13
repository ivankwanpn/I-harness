import { reportStreamActivity, type LLMRequest, type LLMStreamEvent, type ProviderBlockOrderEntry } from "@i-harness/llm-seam"
import type { BedrockConfig } from "../types.ts"
import { mapUsage } from "./usage.ts"

/** One Converse response owns all pending blocks and terminal flags. */
export function createBedrockFold(config: BedrockConfig, request: LLMRequest) {
  // Tool-use accumulation per content block (the ConverseStream wire):
  // a toolUse delta carries the args as one JSON string split across
  // deltas; the stop event completes the block, and the args are parsed
  // there (mirrors the llm-openai-compatible accumulation).
  const pendingToolUses = new Map<number, { id: string; name: string; buffer: string }>()
  const pendingReasoning = new Map<number, { text: string; signature: string }>()
  const pendingRedacted = new Map<number, Uint8Array[]>()
  const reasoningBlocks: ({ reasoningText: { text: string; signature: string } } | { redactedContentBase64: string })[] = []
  const blockOrder = new Map<number, ProviderBlockOrderEntry>()
  let toolOrdinal = 0
  // M72 Ⅱ: the wire's own truncation literal (`messageStop.stopReason:
  // "max_tokens"`) — set in `handleMember` below, read once at the ending.
  // Absent stays absent: only `true` writes the field.
  let truncated = false
  // M77: the same `stopReason` carries this wire's refusal literal,
  // `guardrail_intervened` (a guardrail stopped the exchange) — which
  // arrives as an ordinary HTTP 200 stream, so before M77 the seam reported
  // an empty SUCCESS. A separate variable from `truncated`: the two are
  // independent and neither is the other's `else`. Sibling stop reasons this
  // unit does NOT treat as refusals (measured in the AWS SDK's own
  // `StopReason` enum in this tree's node_modules, unread here on purpose):
  // `content_filtered`, `malformed_model_output`, `malformed_tool_use`,
  // `model_context_window_exceeded` — recorded as a residual, not guessed at.
  let refused = false
  // Soft-walk the SDK's discriminated member union: every member key is
  // declared as `?: never` on its siblings, so TS's `in` narrowing cannot
  // split the union — runtime key checks behave like the wire shape.
  const handleMember = (member: unknown): LLMStreamEvent[] => {
    const m = member as {
      contentBlockStart?: { contentBlockIndex?: number; start?: { toolUse?: { toolUseId?: string; name?: string } } }
      contentBlockDelta?: { contentBlockIndex?: number; delta?: { text?: string; toolUse?: { input?: string }; reasoningContent?: { text?: string; signature?: string; redactedContent?: Uint8Array } } }
      contentBlockStop?: { contentBlockIndex?: number }
      messageStop?: { stopReason?: string }
      metadata?: { usage?: unknown }
      internalServerException?: { message?: string }
      modelStreamErrorException?: { message?: string }
      serviceUnavailableException?: { message?: string }
      throttlingException?: { message?: string }
      validationException?: { message?: string }
    }
    if (m.contentBlockStart !== undefined && m.contentBlockStart.start?.toolUse !== undefined) {
      const toolUse = m.contentBlockStart.start.toolUse
      blockOrder.set(m.contentBlockStart.contentBlockIndex ?? 0, { kind: "tool", index: toolOrdinal++ })
      pendingToolUses.set(m.contentBlockStart.contentBlockIndex ?? 0, {
        id: toolUse.toolUseId ?? "",
        name: toolUse.name ?? "",
        buffer: "",
      })
      return []
    }
    if (m.contentBlockDelta !== undefined) {
      const delta = m.contentBlockDelta.delta
      if (delta !== undefined) {
        if (typeof delta.text === "string" && delta.text.length > 0) {
          const index = m.contentBlockDelta.contentBlockIndex ?? 0
          const entry = blockOrder.get(index)
          if (entry?.kind === "text") entry.text += delta.text
          else blockOrder.set(index, { kind: "text", text: delta.text })
          return [{ type: "text/chunk", text: delta.text }]
        }
        if (delta.toolUse !== undefined) {
          const pending = pendingToolUses.get(m.contentBlockDelta.contentBlockIndex ?? 0)
          if (pending !== undefined && typeof delta.toolUse.input === "string") {
            pending.buffer += delta.toolUse.input
            if (delta.toolUse.input.length > 0) reportStreamActivity(request, "tool-arguments")
          }
          return []
        }
        if (delta.reasoningContent !== undefined) {
          const index = m.contentBlockDelta.contentBlockIndex ?? 0
          const block = delta.reasoningContent
          if (block.redactedContent instanceof Uint8Array) {
            const fragments = pendingRedacted.get(index) ?? []
            fragments.push(block.redactedContent)
            pendingRedacted.set(index, fragments)
          }
          if (typeof block.text === "string" || typeof block.signature === "string") {
            const pending = pendingReasoning.get(index) ?? { text: "", signature: "" }
            pending.text += block.text ?? ""
            pending.signature += block.signature ?? ""
            pendingReasoning.set(index, pending)
          }
          if (typeof block.text === "string") return [{ type: "reasoning", blockId: String(index), text: block.text }]
        }
      }
      return []
    }
    if (m.contentBlockStop !== undefined) {
      const index = m.contentBlockStop.contentBlockIndex ?? 0
      const redacted = pendingRedacted.get(index)
      if (redacted) {
        pendingRedacted.delete(index)
        reasoningBlocks.push({ redactedContentBase64: Buffer.concat(redacted.map((bytes) => Buffer.from(bytes))).toString("base64") })
        blockOrder.set(index, { kind: "reasoning", index: reasoningBlocks.length - 1 })
      }
      const reasoning = pendingReasoning.get(index)
      if (reasoning) {
        pendingReasoning.delete(m.contentBlockStop.contentBlockIndex ?? 0)
        if (reasoning.signature) {
          reasoningBlocks.push({ reasoningText: reasoning })
          blockOrder.set(index, { kind: "reasoning", index: reasoningBlocks.length - 1 })
        }
      }
      const pending = pendingToolUses.get(m.contentBlockStop.contentBlockIndex ?? 0)
      pendingToolUses.delete(m.contentBlockStop.contentBlockIndex ?? 0)
      if (pending !== undefined) {
        try {
          const args = JSON.parse(pending.buffer.trim() === "" ? "{}" : pending.buffer) as unknown
          return [{ type: "tool_call", call: { ...(pending.id ? { id: pending.id } : {}), name: pending.name, args } }]
        } catch {
          return [{
            type: "error",
            error: new Error(`bedrock malformed tool use args for "${pending.name}": ${pending.buffer}`),
          }]
        }
      }
      return []
    }
    // M72 Ⅱ: `messageStop` IS read now — it is where this wire states WHY
    // the stream ended, and `stopReason` is the truncation literal the
    // seam's `end` bit takes. It carries no other stream content (it
    // terminates the stream → `end` below); `messageStart` carries none at
    // all. `metadata` carries the usage snapshot (the Converse
    // `TokenUsage`) — until M72 Ⅲ this adapter documented that wire position
    // here instead of surfacing it; the arm below now maps it onto the
    // seam's own `usage` event (`{ type: "usage"; usage: LLMUsage }`).
    if (m.messageStop?.stopReason === "max_tokens") truncated = true
    // M77: the refusal on the very same field — a sibling test, never the
    // `else` of the truncation above.
    if (m.messageStop?.stopReason === "guardrail_intervened") refused = true
    // M72 Ⅲ: `metadata` carries the round-trip's usage snapshot — typed
    // here since the beginning and never read. Same two rules as every
    // other adapter: finite numbers only, and nothing recognisable ⇒ no
    // event at all.
    const usage = mapUsage(m.metadata?.usage)
    if (usage !== undefined) return [{ type: "usage", usage }]
    const exceptions = [
      "internalServerException", "modelStreamErrorException", "serviceUnavailableException",
      "throttlingException", "validationException",
    ] as const
    for (const code of exceptions) {
      const exception = m[code]
      if (exception !== undefined) {
        const raw = exception as { message?: unknown }
        const message = typeof raw.message === "string" ? raw.message : "unknown stream error"
        return [{ type: "error", error: Object.assign(new Error(`bedrock stream failed: ${message}`), { code }) }]
      }
    }
    return []
  }
  const end = (): LLMStreamEvent => {
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
    return { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}), ...(reasoningBlocks.length || interleaved ? { providerContinuation: { kind: "bedrock", model: config.model, ...(config.providerId ? { providerId: config.providerId } : {}), reasoningBlocks, ...(interleaved ? { contentOrder } : {}) } as const } : {}) }
  }
  return { handleMember, end }
}
