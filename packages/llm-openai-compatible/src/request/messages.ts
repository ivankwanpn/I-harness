import { canReplayContinuation, type LLMContentPart } from "@i-harness/llm-seam"

// Shape LLM content parts into the Chat Completions `content` array. String
// content stays the legacy string (byte-identical).
function toContent(content: string | LLMContentPart[]): unknown {
  if (typeof content === "string") return content
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image_url", image_url: { url: `data:${part.image.mediaType};base64,${part.image.dataBase64}` } },
  )
}

// Translate the neutral LLMMessage union into Chat Completions wire messages.
export function toWireMessage(m: {
  role: "user" | "assistant" | "tool"
  content: string | LLMContentPart[]
  toolCalls?: { id: string; name: string; args: unknown }[]
  toolCallId?: string
  providerContinuation?: { kind: string; reasoningContent?: string; model?: string; providerId?: string }
}, target: { model: string; providerId?: string }): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId!, content: toContent(m.content) }
  const reasoning = m.role === "assistant" && m.providerContinuation?.kind === "openai-compatible" && canReplayContinuation(m.providerContinuation, target) && m.providerContinuation.reasoningContent
    ? { reasoning_content: m.providerContinuation.reasoningContent } : {}
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: toContent(m.content),
      ...reasoning,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    }
  }
  return { role: m.role, content: toContent(m.content), ...reasoning }
}
