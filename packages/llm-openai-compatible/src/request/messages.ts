import { textProtocolToolResult, canReplayContinuation, deepSeekCallFingerprint, isOfficialDeepSeekApi, replayBlockOrder, type LLMContentPart, type LLMMessage } from "@i-harness/llm-seam"
import { projectionFingerprint } from "@i-harness/token-meter"
import type { OpenAICompatibleConfig } from "../types.ts"

type Target = Pick<OpenAICompatibleConfig, "baseUrl" | "model" | "providerId">

function chatReasoning(message: Extract<LLMMessage, { role: "assistant" }>, target: Target): string | undefined {
  const native = message.providerContinuation
  if (!native || !canReplayContinuation(native, target)) return
  if (native.kind === "openai-compatible") return native.reasoningContent
  if (native.kind !== "openai-responses" || !native.deepSeekReplayFingerprint || native.origin !== undefined
    || !native.providerId || native.providerId !== target.providerId || native.model !== target.model || !isOfficialDeepSeekApi(target.baseUrl)) return
  const calls = message.toolCalls ?? []
  if (native.deepSeekReplayFingerprint !== projectionFingerprint([message.content, calls.map(deepSeekCallFingerprint)])) return

  // DeepSeek accepts only verbatim reasoning_text on this route. A summary,
  // ciphertext, or mixed item cannot represent the original reasoning.
  const texts: string[] = []
  for (const item of native.reasoningItems) {
    if (item.type !== "reasoning" || item.encrypted_content != null
      || item.summary !== undefined && (!Array.isArray(item.summary) || item.summary.length !== 0)
      || !Array.isArray(item.content) || item.content.length === 0
      || !item.content.every(part => part?.type === "reasoning_text" && typeof part.text === "string")) return
    texts.push(item.content.map(part => part.text).join(""))
  }
  return replayBlockOrder(native.outputOrder, message.content, texts, calls.map(() => ""), () => "")?.join("")
}

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
function toWireMessage(m: LLMMessage, target: Target): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: toContent(textProtocolToolResult(m)) }
  const text = m.role === "assistant" ? chatReasoning(m, target) : undefined
  const reasoning = text ? { reasoning_content: text } : {}
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

/** Only adapter-created image companions move after sibling results. Ordinary
 * user input keeps its position, so malformed source groups remain visible. */
export function toWireMessages(messages: LLMMessage[], target: Target): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [], companions: Record<string, unknown>[] = [], pending = new Set<string>()
  const flushImages = () => { result.push(...companions); companions.length = 0 }
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) pending.add(call.id)
    if (message.role === 'tool' && Array.isArray(message.content)) {
      const images = message.content.filter(part => part.type === 'image')
      result.push(toWireMessage({ ...message, content: message.content.filter(part => part.type === 'text') }, target))
      if (images.length) companions.push({ role: 'user', content: toContent(images) })
    } else result.push(toWireMessage(message, target))
    if (message.role === 'tool') pending.delete(message.toolCallId)
    if (!pending.size) flushImages()
  }
  // Retain images even on malformed/incomplete sources; the final validator
  // rejects the open group rather than repairing it or discarding the image.
  flushImages()
  return result
}
