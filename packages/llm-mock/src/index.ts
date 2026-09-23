import type { LLMRequest, LLMStreamEvent, LLMUsage, ModelClient } from "@i-harness/llm-seam"

export interface MockToolCall {
  name: string
  args: unknown
}

export interface MockStep {
  role: "assistant"
  text?: string
  toolCalls?: MockToolCall[]
  /** M5 T2: what the provider reports for this round-trip. Unset → the mock
   * reports nothing, which is also a case worth testing (absent ≠ zero). */
  usage?: LLMUsage
  /** M72 Ⅱ: this step ends at the output cap. Present ONLY as `true` (the
   * seam's own discipline) — unset → the step ends cleanly, byte-identical to
   * before this field existed. It exists because a `MockStep` is the ONLY way
   * the CLI's run-level path can be driven end-to-end with a truncated ending. */
  truncated?: true
}

export function createMockClient(script: MockStep[]): ModelClient {
  return {
    // Each stream() call replays exactly ONE script step (turn-based): the
    // step's tool calls, then its text, then `end`. The next stream() call
    // replays the NEXT step (one model turn each). An exhausted script
    // yields `error` instead. Consumption is destructive — the script is a
    // one-shot cassette consumed one step per turn.
    async *stream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      if (script.length === 0) {
        yield { type: "error", error: new Error("mock script exhausted") }
        return
      }
      const step = script.shift()!
      // M5 T2: yielded FIRST, mirroring the wire — Anthropic reports the input
      // side on message_start, before any content arrives.
      if (step.usage !== undefined) yield { type: "usage", usage: step.usage }
      if (step.toolCalls && step.toolCalls.length > 0) {
        for (const call of step.toolCalls) yield { type: "tool_call", call }
      }
      if (step.text !== undefined) yield { type: "text/chunk", text: step.text }
      // M72 Ⅱ: the step's own ending. Absent → the exact literals this file
      // yielded before the field existed; `truncated: true` → the seam's
      // truncated terminal, which is what a cap-hitting provider reports.
      yield step.truncated === true ? { type: "end", truncated: true } : { type: "end" }
    },
  }
}
