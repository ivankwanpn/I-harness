import { bindVisibleToolIds, hasReorderedTools, reportStreamActivity, type LLMRequest, type LLMStreamEvent, type ProviderBlockOrderEntry } from "@i-harness/llm-seam"
import type { BedrockConfig } from "../types.ts"
import { mapUsage } from "./usage.ts"
import { completeConverseWitness, type ConverseInputWitness, type ConverseCall } from '../request/validate-native.ts'

/** One Converse response owns all pending blocks and terminal flags. */
export function createBedrockFold(config: BedrockConfig, request: LLMRequest, witness?: ConverseInputWitness) {
  // Tool-use accumulation per content block (the ConverseStream wire):
  // a toolUse delta carries the args as one JSON string split across
  // deltas; the stop event completes the block, and the args are parsed
  // there (mirrors the llm-openai-compatible accumulation).
  const pendingToolUses = new Map<number, { id: string; name: string; buffer: string }>()
  const calls: ConverseCall[] = []
  const pendingReasoning = new Map<number, { text: string; signature: string }>()
  const pendingRedacted = new Map<number, Uint8Array[]>()
  const reasoningBlocks: ({ reasoningText: { text: string; signature?: string } } | { redactedContentBase64: string })[] = []
  const blockOrder = new Map<number, ProviderBlockOrderEntry>()
  let startedTools = 0
  let truncated = false
  let toolError: string | undefined
  let receivedTerminal = false
  let malformed: string | undefined
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
    // Only terminal status, exceptions and usage remain relevant after
    // malformed input or messageStop. No later block can authorize a tool.
    if ((toolError || receivedTerminal) && (m.contentBlockStart || m.contentBlockDelta || m.contentBlockStop)) return []
    if (m.contentBlockStart) {
      const index = m.contentBlockStart.contentBlockIndex
      if (pendingToolUses.has(index ?? 0) || index !== undefined && blockOrder.get(index)?.kind === "tool") {
        toolError = "Bedrock response reused a tool block index"
        return []
      }
    }
    if (m.contentBlockStart !== undefined && m.contentBlockStart.start?.toolUse !== undefined) {
      const toolUse = m.contentBlockStart.start.toolUse
      startedTools++
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
        {
          reasoningBlocks.push({ reasoningText: { text: reasoning.text, ...(reasoning.signature ? { signature: reasoning.signature } : {}) } })
          blockOrder.set(index, { kind: "reasoning", index: reasoningBlocks.length - 1 })
        }
      }
      const pending = pendingToolUses.get(m.contentBlockStop.contentBlockIndex ?? 0)
      pendingToolUses.delete(m.contentBlockStop.contentBlockIndex ?? 0)
      if (pending !== undefined) {
        try {
          const args = JSON.parse(pending.buffer.trim() === "" ? "{}" : pending.buffer) as unknown
          blockOrder.set(index, { kind: "tool", index: calls.length })
          calls.push({ ...(pending.id ? { id: pending.id } : {}), name: pending.name, args })
          return [{ type: "tool_call", call: { ...(pending.id ? { id: pending.id } : {}), name: pending.name, args } }]
        } catch {
          toolError = "Bedrock malformed tool use arguments"
          return []
        }
      }
      return []
    }
    // Final usage metadata can follow messageStop. Retain the classified
    // ending until EOF so those counters are still observable.
    if (m.messageStop !== undefined) {
      receivedTerminal = true
      const reason = m.messageStop.stopReason
      if (reason === "max_tokens" || reason === "model_context_window_exceeded") truncated = true
      if (reason === "guardrail_intervened" || reason === "content_filtered") refused = true
      if (reason === "malformed_model_output" || reason === "malformed_tool_use") malformed = reason
    }
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
    if (!receivedTerminal) return { type: "error", error: new Error("Bedrock stream ended without messageStop") }
    if (malformed) return { type: "error", error: new Error(`Bedrock stopped with ${malformed}`) }
    if (!truncated && !refused) {
      if (toolError) return { type: "error", error: new Error(toolError) }
      if (pendingToolUses.size) return { type: "error", error: new Error("Bedrock response closed with an unfinished tool use block") }
    }
    // M77: each bit is written on its own (a response can be both), and both
    // absent ⇒ the byte-exact `{ type: "end" }` every clean ending returned.
    const contentOrder = bindVisibleToolIds([...blockOrder.entries()].sort(([left], [right]) => left - right).map(([, entry]) => entry), calls)
    const rank = { reasoning: 0, text: 1, tool: 2 } as const
    let previousRank = -1
    const interleaved = contentOrder.some((entry) => {
      const current = rank[entry.kind]
      const outOfOrder = current < previousRank
      previousRank = Math.max(previousRank, current)
      return outOfOrder
    }) || hasReorderedTools(contentOrder)
    const producerWitness = witness && !truncated && !refused && !pendingToolUses.size && !pendingReasoning.size && !pendingRedacted.size && calls.length === startedTools ? completeConverseWitness(witness, calls) : undefined
    return { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}), ...(reasoningBlocks.length || interleaved ? { providerContinuation: { kind: "bedrock", model: config.model, ...(config.providerId ? { providerId: config.providerId } : {}), reasoningBlocks, ...(interleaved || producerWitness ? { contentOrder } : {}), ...(producerWitness ? { producerWitness } : {}) } as const } : {}) }
  }
  return { handleMember, end }
}
