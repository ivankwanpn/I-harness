import { canReplayContinuation, replayBlockOrder, type LLMContentPart, type LLMRequest } from "@i-harness/llm-seam"
import type { OpenAIConfig } from "../types.ts"

function toInputContent(content: string | LLMContentPart[]): unknown {
  if (typeof content === "string") return content
  return content.map((part) =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_image", image_url: `data:${part.image.mediaType};base64,${part.image.dataBase64}` },
  )
}

/** Remove explicit cache metadata only from documented content-block sites;
 * opaque tool arguments, tool text and native reasoning remain intact. */
export function withoutCacheBreakpoints(input: unknown): unknown {
  if (!Array.isArray(input)) return input
  const cleanBlocks = (blocks: unknown[]): unknown[] => blocks.map((block) => {
    if (typeof block !== "object" || block === null || Array.isArray(block)) return block
    const part = block as Record<string, unknown>
    if (part.type !== "input_text" && part.type !== "input_image" && part.type !== "input_file") return block
    const clean = { ...part }
    delete clean.prompt_cache_breakpoint
    return clean
  })
  return input.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item
    const record = item as Record<string, unknown>
    if (record.type === "function_call_output" && Array.isArray(record.output)) return { ...record, output: cleanBlocks(record.output) }
    if (Array.isArray(record.content) && (record.type === "message" || typeof record.role === "string")) return { ...record, content: cleanBlocks(record.content) }
    return item
  })
}

// M14 direct-path collapse: a host hand-built tool message with image parts
// becomes a function_call_output carrying only the text, followed by a user
// item carrying the images (matching what deriveMessages emits for the agent
// path). Returns undefined when there is nothing to split.
function splitToolContent(content: string | LLMContentPart[]): { text: string; images: Extract<LLMContentPart, { type: "image" }>[] } {
  if (typeof content === "string") return { text: content, images: [] }
  let text = ""
  const images: Extract<LLMContentPart, { type: "image" }>[] = []
  for (const part of content) {
    if (part.type === "text") text += part.text
    else images.push(part)
  }
  return { text, images }
}

/** Map projected history, preserving native continuation ordering and tool images. */
export function mapMessages(messages: LLMRequest["messages"], config: Pick<OpenAIConfig, "model" | "providerId">, codexSubscription: boolean): unknown {
  return messages
    .map((m) => {
      if (m.role === "user") return { role: "user", content: toInputContent(m.content) }
      if (m.role === "tool") {
        const { text, images } = splitToolContent(m.content)
        const output = { type: "function_call_output", call_id: m.toolCallId, output: text }
        if (images.length === 0) return output
        return [output, { role: "user", content: images.map((part) => ({ type: "input_image", image_url: `data:${part.image.mediaType};base64,${part.image.dataBase64}` })) }]
      }
      // assistant
      const continuation = m.providerContinuation?.kind === "openai-responses" && canReplayContinuation(m.providerContinuation, config) ? m.providerContinuation : undefined
      const originalReasoningItems = continuation?.reasoningItems ?? []
      const calls = m.toolCalls?.map((c) => ({
        type: "function_call",
        call_id: c.id,
        name: c.name,
        ...(codexSubscription ? { namespace: "ih" } : {}),
        arguments: JSON.stringify(c.args),
      })) ?? []
      const ordered = replayBlockOrder<unknown>(continuation?.outputOrder, m.content, originalReasoningItems, calls,
        (content, phase) => ({ role: "assistant", content, ...(phase !== undefined ? { phase } : {}) }))
      if (ordered !== undefined) return ordered
      // An order envelope that no longer matches the neutral message is
      // stale. Its native reasoning belongs to that old assistant text.
      // Old logs without an order envelope keep their historical replay.
      const reasoningItems = continuation?.outputOrder ? [] : originalReasoningItems
      if (m.toolCalls && m.toolCalls.length > 0) {
        // M51/B2: a folded step message carries the step's text AND its
        // tool calls — emit the assistant text item before the
        // function_call items (dropping it lost the narration).
        return [...reasoningItems, ...(m.content.trim() !== "" ? [{ role: "assistant", content: m.content }] : []), ...calls]
      }
      return reasoningItems.length ? [...reasoningItems, { role: "assistant", content: m.content }] : { role: "assistant", content: m.content }
    })
    .flat()
}
