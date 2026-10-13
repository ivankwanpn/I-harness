import { canReplayContinuation, replayBlockOrder, type LLMContentPart, type LLMRequest } from "@i-harness/llm-seam"
import type { BedrockConfig } from "../types.ts"

// Shape LLM content parts into Converse content blocks. String content stays
// one text block (byte-identical). Images use the Converse ImageBlock
// ({format, source:{bytes}}); media types outside the four Converse image
// formats are sent as PNG-lite by the sub-type fallback.
function toConverseContent(content: string | LLMContentPart[]): unknown[] {
  if (typeof content === "string") return [{ text: content }]
  return content.map((part) =>
    part.type === "text"
      ? { text: part.text }
      : { image: { format: imageFormatOf(part.image.mediaType), source: { bytes: Buffer.from(part.image.dataBase64, "base64") } } },
  )
}

function imageFormatOf(mediaType: string): "png" | "jpeg" | "gif" | "webp" {
  const sub = mediaType.split("/")[1]?.toLowerCase() ?? "png"
  return sub === "jpeg" || sub === "gif" || sub === "webp" ? sub : "png"
}

// A Converse toolResult content block: valid-JSON object content is passed
// through as { json }, anything else becomes a { text } block.
function toolResultContent(content: string | LLMContentPart[]): unknown[] {
  const raw = typeof content === "string"
    ? content
    : content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n")
  if (raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return [{ json: parsed }]
    } catch {
      // not JSON — text below
    }
  }
  return [{ text: raw }]
}

// Converse's ToolResultBlock.status is accepted only by Nova and Claude 3/4.
// Other Bedrock models still receive the error text, without an unsupported field.
function supportsToolResultStatus(model: string): boolean {
  // Converse accepts both foundation-model IDs and inference-profile IDs,
  // including regional/global prefixes and ARN resource suffixes.
  const resource = model.split("/").at(-1) ?? model
  const id = resource.replace(/^[a-z][a-z0-9-]*\.(?=(?:anthropic|amazon)\.)/, "")
  return /^amazon\.nova(?:[-.]|$)/.test(id)
    || /^anthropic\.claude-(?:3(?:-|$)|(?:haiku|sonnet|opus)-[34](?:-|$))/.test(id)
}

export function toConverseMessages(config: BedrockConfig, messages: LLMRequest["messages"]): { role: "user" | "assistant"; content: unknown[] }[] {
  const wireMessages: { role: "user" | "assistant"; content: unknown[] }[] = []
  let toolResults: unknown[] | undefined
  for (const m of messages) {
    if (m.role === "tool") {
      if (toolResults === undefined) {
        toolResults = []
        wireMessages.push({ role: "user", content: toolResults })
      }
      toolResults.push({ toolResult: { toolUseId: m.toolCallId, content: toolResultContent(m.content), ...(m.isError === true && supportsToolResultStatus(config.model) ? { status: "error" } : {}) } })
      continue
    }
    toolResults = undefined
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const continuation = m.providerContinuation?.kind === "bedrock" && canReplayContinuation(m.providerContinuation, config)
        ? m.providerContinuation : undefined
      const blocks = continuation
        ? continuation.reasoningBlocks.map((block) => "reasoningText" in block ? { reasoningContent: { reasoningText: block.reasoningText } } : { reasoningContent: { redactedContent: Buffer.from(block.redactedContentBase64, "base64") } }) : []
      const tools = m.toolCalls.map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.args as Record<string, unknown> } }))
      const content: unknown[] = replayBlockOrder<unknown>(continuation?.contentOrder, m.content, blocks, tools, (text) => ({ text }))
        ?? [...blocks, ...(m.content.trim() !== "" ? [{ text: m.content }] : []), ...tools]
      wireMessages.push({ role: "assistant", content })
      continue
    }
    wireMessages.push({ role: m.role, content: toConverseContent(m.content) })
  }
  return wireMessages
}
