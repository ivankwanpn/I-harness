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
      yield { type: "end" }
    },
  }
}
