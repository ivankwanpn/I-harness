import type { Session } from "@i-harness/core-session"

export type LLMStreamEvent =
  | { type: "text/chunk"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: { name: string; args: unknown } }
  | { type: "end" }
  | { type: "error"; error: Error }

export interface LLMMessage {
  role: "user" | "assistant"
  content: string
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: unknown
}

export interface LLMRequest {
  messages: LLMMessage[]
  tools: ToolSchema[]
  systemPrompt: string
  model?: string
}

export interface ModelClient {
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>
}

export function assertMessagesFromLog(messages: LLMMessage[], session: Session): void {
  const logged: LLMMessage[] = []
  for (const ev of session.events) {
    if (ev.type === "user/message") logged.push({ role: "user", content: ev.text })
    else if (ev.type === "assistant/message") logged.push({ role: "assistant", content: ev.text })
  }
  const msgJson = JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })))
  const logJson = JSON.stringify(logged.map((m) => ({ role: m.role, content: m.content })))
  if (msgJson !== logJson) throw new Error("model-visible messages must derive from the session log (audit F01-3)")
}
