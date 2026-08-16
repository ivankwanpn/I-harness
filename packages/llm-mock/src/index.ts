import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"

export interface MockToolCall {
  name: string
  args: unknown
}

export interface MockStep {
  role: "assistant"
  text?: string
  toolCalls?: MockToolCall[]
}

export function createMockClient(script: MockStep[]): ModelClient {
  return {
    // Each stream() call drains the ENTIRE remaining script, replaying every
    // step's tool calls and text, then yields `end`. A subsequent call on an
    // exhausted script yields `error` instead. Script consumption is
    // destructive: the script is a one-shot cassette, not a fixed playlist.
    async *stream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      if (script.length === 0) {
        yield { type: "error", error: new Error("mock script exhausted") }
        return
      }
      while (script.length > 0) {
        const step = script.shift()!
        if (step.toolCalls && step.toolCalls.length > 0) {
          for (const call of step.toolCalls) yield { type: "tool_call", call }
        }
        if (step.text !== undefined) yield { type: "text/chunk", text: step.text }
      }
      yield { type: "end" }
    },
  }
}
