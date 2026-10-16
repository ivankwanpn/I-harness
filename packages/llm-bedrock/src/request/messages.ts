import { canReplayContinuation, replayBlockOrder, type LLMContentPart, type LLMRequest } from "@i-harness/llm-seam"
import type { BedrockConfig } from "../types.ts"
import { bedrockCapabilities } from './capabilities.ts'

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
  if (Array.isArray(content)) return toConverseContent(content)
  const raw = typeof content === "string"
    ? content
    : ''
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

export function toConverseMessages(config: BedrockConfig, messages: LLMRequest["messages"], official = false): { role: "user" | "assistant"; content: unknown[] }[] {
  const wireMessages: { role: "user" | "assistant"; content: unknown[] }[] = []
  let toolResults: unknown[] | undefined
  let toolImages: unknown[] = []
  const capability = bedrockCapabilities(config.model, official)
  const flushImages = () => { if (toolImages.length) wireMessages.push({ role: 'user', content: toolImages }); toolImages = [] }
  for (const m of messages) {
    if (m.role === "tool") {
      if (toolResults === undefined) {
        toolResults = []
        wireMessages.push({ role: "user", content: toolResults })
      }
      const content = Array.isArray(m.content) && !capability.toolImage ? m.content.filter(part => part.type !== 'image') : m.content
      const annotation = m.isError && !capability.status ? [{ json: { isError: true } }] : []
      const relocatedOnly = Array.isArray(m.content) && m.content.some(part => part.type === 'image') && Array.isArray(content) && content.length === 0
      const representation = relocatedOnly ? [{ text: '[Adapter representation: image content from this tool result is supplied in the following user image companion.]' }] : []
      toolResults.push({ toolResult: { toolUseId: m.toolCallId, content: [...annotation, ...representation, ...toolResultContent(content)], ...(m.isError === true && capability.status ? { status: "error" } : {}) } })
      if (Array.isArray(m.content) && !capability.toolImage) toolImages.push(...toConverseContent(m.content.filter(part => part.type === 'image')))
      continue
    }
    flushImages()
    toolResults = undefined
    if (m.role === "assistant" && (m.toolCalls?.length || m.providerContinuation?.kind === 'bedrock')) {
      const continuation = m.providerContinuation?.kind === "bedrock" && canReplayContinuation(m.providerContinuation, config)
        ? m.providerContinuation : undefined
      const blocks = continuation
        ? continuation.reasoningBlocks.map((block) => "reasoningText" in block ? { reasoningContent: { reasoningText: block.reasoningText } } : { reasoningContent: { redactedContent: Buffer.from(block.redactedContentBase64, "base64") } }) : []
      const tools = (m.toolCalls ?? []).map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.args as Record<string, unknown> } }))
      const content: unknown[] = replayBlockOrder<unknown>(continuation?.contentOrder, m.content, blocks, tools, (text) => ({ text }))
        ?? [...blocks, ...(m.content.trim() !== "" ? [{ text: m.content }] : []), ...tools]
      wireMessages.push({ role: "assistant", content })
      continue
    }
    wireMessages.push({ role: m.role, content: toConverseContent(m.content) })
  }
  flushImages()
  return wireMessages
}
