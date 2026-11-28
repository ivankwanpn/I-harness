import { describeChatStreamError, reportStreamActivity, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"
import type { OpenAICompatibleConfig } from "../types.ts"
import { mapUsage } from "./usage.ts"

export const emit = function* (events: LLMStreamEvent[]): Generator<LLMStreamEvent, boolean, unknown> {
  for (const ev of events) {
    if (ev.type === "error") {
      yield ev
      return true
    }
    yield ev
  }
  return false
}

/** One response owns its tools, reasoning and terminal flags. */
export function createChatFold(config: Pick<OpenAICompatibleConfig, "model" | "providerId">, request: LLMRequest) {
  // M72 Ⅱ: the wire's own truncation literal (`finish_reason: "length"`) —
  // set in handleFrame below, read once at the ending. Absent stays
  // absent: only `true` writes the field.
  let truncated = false
  let primaryFinish: string | undefined
  // M77: this wire reports a refusal on TWO carriers — the SIBLING of
  // `length` on the same field, `finish_reason: "content_filter"`, and the
  // delta's own `refusal` field (both recognised in handleFrame below).
  // Either way it is HTTP 200 with no content, so before M77 the seam
  // reported an empty SUCCESS and the turn ended as if the model had
  // answered with nothing. Two variables rather than one: a response can
  // be both, so neither bit may be the other's `else`.
  let refused = false
  let reasoningContent = ""
  // tool call accumulation: index -> { id, name, argsBuffer }
  const pendingToolCalls = new Map<number, { id: string; name: string; argsBuffer: string }>()
  let invalidToolFields = false

  // M72 Ⅲ: ONE frame handler for both the read loop and the residual
  // flush. R12 patched the second copy of a rule; the copies had already
  // drifted (the flush never accumulated tool-call fragments, so a tool
  // call arriving only in a boundary-less final frame was dropped). New
  // wire rules land HERE, once.
  const handleFrame = (event: Record<string, unknown>): LLMStreamEvent[] => {
    const events: LLMStreamEvent[] = []
    const usage = mapUsage((event as { usage?: unknown }).usage)
    // Null is the optional no-error value. Every other explicit carrier must
    // fail, even when its diagnostic is malformed or unknown. Usage is a
    // billing observation; never process choices from an error-bearing frame.
    if (Object.hasOwn(event, 'error') && event.error !== null) {
      if (usage !== undefined) events.push({ type: 'usage', usage })
      events.push({ type: 'error', error: describeChatStreamError(event.error) })
      return events
    }
    const choices = (event as { choices?: { index?: number; finish_reason?: string; delta?: Record<string, unknown> }[] }).choices ?? []
    // IH owns one assistant reply. Streaming gateways may send alternative
    // candidates out of order, or send only a secondary candidate in a frame.
    const choice = choices.find(value => value.index === 0) ?? (choices[0]?.index == null ? choices[0] : undefined)
    if (choice) {
      const delta = choice.delta ?? {}
      // R12: a final frame that lost its trailing "\n\n" is parsed here
      // too (via the residual flush), and the provider's failure channel
      // must not depend on where the frame boundary fell — one rule, both
      // callers.
      const finishReason = choice.finish_reason
      const alreadyFinished = primaryFinish !== undefined
      if (finishReason) {
        if (alreadyFinished && finishReason !== primaryFinish) invalidToolFields = true
        primaryFinish = finishReason
      }
      if (finishReason === "insufficient_system_resource") {
        if (usage !== undefined) events.push({ type: "usage", usage })
        events.push({ type: "error", error: Object.assign(new Error("Provider stopped generation due to insufficient resources"), { code: "CAPACITY" }) })
        return events
      }
      if (finishReason === "length") truncated = true
      // M77: `content_filter` is this wire's refusal, and it arrives on the
      // very same field — hence the sibling test, never the `else` of it.
      if (finishReason === "content_filter") refused = true
      // M72 Ⅲ: DeepSeek-family gateways stream the reasoning text on
      // `delta.reasoning_content` — a sibling of `content` that had ZERO
      // readers in this tree, so the whole trajectory was dropped. Pushed
      // BEFORE this frame's content: a model that both thinks and answers
      // does so in that order.
      const reasoningText = (delta as { reasoning_content?: unknown }).reasoning_content
      if (typeof reasoningText === "string" && reasoningText.length > 0) {
        reasoningContent += reasoningText
        events.push({ type: "reasoning", text: reasoningText })
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        events.push({ type: "text/chunk", text: delta.content })
      }
      // M77 (fix wave): this wire's SECOND refusal carrier, and it is not a
      // stop reason at all — it is a field on the delta. openai-node's
      // `Choice.Delta.refusal?: string | null` ("The refusal message
      // generated by the model") arrives with `content: null` and
      // `finish_reason: "stop"`, so the `content_filter` branch above never
      // fires and both text reads come up empty: HTTP 200, a bare `end`,
      // an empty assistant message, a silent CLI — the symptom this
      // milestone removes. The recognised literal is "the field arrived
      // carrying a string" (the rule gemini's `promptFeedback` uses), so
      // the `refusal: null` every non-refusing structured-outputs delta
      // carries writes nothing. The refusal's TEXT is deliberately NOT
      // promoted into assistant text (a parked product decision).
      const refusalText = (delta as { refusal?: unknown }).refusal
      if (typeof refusalText === "string") refused = true
      const toolCalls = delta.tool_calls
      if (toolCalls != null && !Array.isArray(toolCalls)) invalidToolFields = true
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (alreadyFinished || !tc || typeof tc !== "object" || (tc.type != null && tc.type !== "function")) {
            invalidToolFields = true
            continue
          }
          const idx = tc.index ?? 0
          const pending = pendingToolCalls.get(idx) ?? { id: "", name: "", argsBuffer: "" }
          const name = tc.function?.name
          const args = tc.function?.arguments
          if (!Number.isSafeInteger(idx) || idx < 0 || conflictsWith(pending.id, tc.id) ||
              conflictsWith(pending.name, name) || (args != null && typeof args !== "string")) {
            invalidToolFields = true
            continue
          }
          pendingToolCalls.set(idx, pending)
          if (tc.id) pending.id = tc.id
          if (name) pending.name = name
          if (args) {
            pending.argsBuffer += args
            reportStreamActivity(request, "tool-arguments")
          }
        }
      }
    }
    // M72 Ⅲ: the ask above buys a trailing usage-only chunk — `choices: []`
    // with the round-trip's counters. It is the ONE carrier of usage on this
    // wire, and it is handled here, at the single frame handler both loops
    // share (Task 4), so the residual flush reports it identically.
    if (usage !== undefined) events.push({ type: "usage", usage })
    return events
  }

  const finish = (receivedDone: boolean): LLMStreamEvent[] => {
    if (!receivedDone && !primaryFinish) return [{ type: "error", error: Object.assign(new Error("Chat stream closed before a finish reason or [DONE]"), { code: "TRANSPORT" }) }]
    const end: LLMStreamEvent = { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}), ...(reasoningContent ? { providerContinuation: { kind: "openai-compatible", model: config.model, ...(config.providerId ? { providerId: config.providerId } : {}), reasoningContent } as const } : {}) }
    if (truncated || refused) return [end]

    // Validate the entire batch before publishing any executable call. A
    // prefix can be valid JSON and still be extended or rejected by the peer.
    const malformed = (message: string): LLMStreamEvent[] => [{ type: "error", error: Object.assign(new Error(message), { code: "MALFORMED_RESPONSE" }) }]
    if (pendingToolCalls.size && primaryFinish && primaryFinish !== "tool_calls" && primaryFinish !== "stop") return malformed("openai-compatible unrecognized tool completion")
    if (invalidToolFields || (primaryFinish === "tool_calls" && !pendingToolCalls.size)) return malformed("openai-compatible malformed tool call")
    const events: LLMStreamEvent[] = []
    const ids = new Set<string>()
    for (const [, pending] of [...pendingToolCalls].sort(([left], [right]) => left - right)) {
      if (!pending.name.trim() || (pending.id && (!pending.id.trim() || ids.has(pending.id)))) return malformed("openai-compatible malformed tool identity")
      if (pending.id) ids.add(pending.id)
      try {
        const args = JSON.parse(pending.argsBuffer) as unknown
        events.push({ type: "tool_call", call: { ...(pending.id ? { id: pending.id } : {}), name: pending.name, args } })
      } catch {
        return malformed("openai-compatible malformed tool args")
      }
    }
    events.push(end)
    return events
  }

  return { handleFrame, finish }
}

// Many gateways send the name and ID only in the first delta, then send
// empty or null placeholders. A different nonempty identity is ambiguous.
function conflictsWith(current: string, value: unknown): boolean {
  if (value == null || value === "") return false
  return typeof value !== "string" || (current !== "" && value !== current)
}
