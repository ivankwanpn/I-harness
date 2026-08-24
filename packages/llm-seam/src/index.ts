import type { LLMMessage, Session } from "@i-harness/core-session"
import { deriveMessages } from "@i-harness/core-session"

export type LLMStreamEvent =
  | { type: "text/chunk"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: { name: string; args: unknown } }
  | { type: "end" }
  | { type: "error"; error: Error }

// LLMMessage is owned by core-session (it is the audit seam for the session
// log); llm-seam re-exports it rather than re-declaring a duplicate type.
export type { LLMMessage, LLMContentPart, ImageInput, ImageMediaType } from "@i-harness/core-session"

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
  const logged = deriveMessages(session)
  const msgJson = JSON.stringify(messages)
  const logJson = JSON.stringify(logged)
  if (msgJson !== logJson) throw new Error("model-visible messages must derive from the session log (audit F01-3)")
}

// M14 negative capability: text-only models never see image bytes. Replaces
// every image part with a deterministic text placeholder (the base64 prefix
// is a stable correlation hint, not the bytes). String content passes through.
export function projectImagesForTextModel(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m
    // assistant content is always string, so after the check only user/tool
    // parts messages remain; TS cannot prove it from the typeof guard alone
    // (non-literal property), so narrow explicitly on the role discriminant.
    if (m.role === "assistant") return m
    return {
      ...m,
      content: m.content.map((part) =>
        part.type === "image"
          ? { type: "text" as const, text: `[image omitted: model is text-only; base64:${part.image.dataBase64.slice(0, 8)}]` }
          : part,
      ),
    }
  })
}
