import { canReplayContinuation, replayBlockOrder, stringifyJsonData, type LLMContentPart, type LLMRequest, type ProviderContinuation } from "@i-harness/llm-seam"
import type { GeminiConfig } from "../types.ts"

// Shape LLM content parts into GenAI content part objects. String content
// stays a single text part (byte-identical). Images are inlineData (base64).
function toGeminiParts(content: string | LLMContentPart[]): unknown[] {
  if (typeof content === "string") return [{ text: content }]
  return content.map((part) =>
    part.type === "text"
      ? { text: part.text }
      : { inlineData: { mimeType: part.image.mediaType, data: part.image.dataBase64 } },
  )
}

// A tool RESULT reaches Gemini as functionResponse — its `response` field is
// an OBJECT, so the neutral tool content (JSON string or plain text) is
// wrapped: valid-JSON object content is passed through verbatim, anything
// else becomes { output: <text> }.
function toFunctionResponse(content: string | LLMContentPart[]): unknown {
  if (typeof content !== "string") {
    content = content.filter(p => p.type === 'text').map(p => p.text).join("\n")
  }
  if (content.trim() !== "") {
    try {
      const parsed = JSON.parse(content) as unknown
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed
      return { output: parsed }
    } catch {
      // not JSON — wrap below
    }
  }
  return { output: content }
}

/** Keep Gemini's signed parts in the positions where the provider issued them.
 * The neutral transcript remains authoritative for visible text and tool args;
 * stale or incomplete native order falls back to an unsigned projection. */
function replayGeminiParts(
  continuation: Extract<ProviderContinuation, { kind: "gemini" }> | undefined,
  content: string,
  calls: readonly { id: string; name: string; args: unknown }[],
): unknown[] | undefined {
  if (!continuation?.partOrder) return undefined
  if (!geminiCallsMatch(continuation, calls)) return undefined
  const thoughts = (continuation.thoughtParts ?? []).map((part) => ({ text: part.text, thought: true, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) }))
  const tools = calls.map((call, index) => ({ functionCall: { id: call.id, name: call.name, args: call.args }, ...(continuation.callSignatures[index] ? { thoughtSignature: continuation.callSignatures[index] } : {}) }))
  return replayBlockOrder<unknown>(continuation.partOrder, content, thoughts, tools,
    (text, _phase, thoughtSignature) => ({ text, ...(thoughtSignature ? { thoughtSignature } : {}) }))
}

function geminiCallsMatch(
  continuation: Extract<ProviderContinuation, { kind: "gemini" }> | undefined,
  calls: readonly { id: string; name: string; args: unknown }[],
): boolean {
  if (!continuation) return false
  if (!continuation.callBindings) return calls.length === 0 || continuation.partOrder === undefined
  return continuation.callBindings.length === calls.length && continuation.callBindings.every((binding, index) => {
    const call = calls[index]
    return call !== undefined && binding.name === call.name && binding.argsJson === stringifyJsonData(call.args)
      && (binding.id === undefined || binding.id === call.id)
  })
}

export function toGeminiContents(messages: LLMRequest["messages"], config: GeminiConfig): { role: "user" | "model"; parts: unknown[] }[] {
  // Gemini's functionResponse requires the function NAME, but the neutral
  // tool message carries only the call id — the name is recovered from the
  // assistant toolCalls the session log derived (they always precede the
  // tool results in model-visible order).
  const namesByCallId = new Map<string, string>()
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls !== undefined) {
      for (const c of m.toolCalls) namesByCallId.set(c.id, c.name)
    }
  }
  const contents: { role: "user" | "model"; parts: unknown[] }[] = []
  let functionResponses: unknown[] | undefined
  let toolImages: unknown[] = []
  const flushImages = () => {
    if (toolImages.length) contents.push({ role: 'user', parts: toolImages })
    toolImages = []
  }
  for (const m of messages) {
    if (m.role === "tool") {
      if (functionResponses === undefined) {
        functionResponses = []
        contents.push({ role: "user", parts: functionResponses })
      }
      functionResponses.push({ functionResponse: {
        id: m.toolCallId,
        name: namesByCallId.get(m.toolCallId) ?? "",
        response: m.isError ? { error: toFunctionResponse(m.content) } : toFunctionResponse(m.content),
      } })
      if (Array.isArray(m.content)) toolImages.push(...toGeminiParts(m.content.filter(part => part.type === 'image')))
      continue
    }
    flushImages()
    functionResponses = undefined
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const continuation = m.providerContinuation?.kind === "gemini" && canReplayContinuation(m.providerContinuation, config)
        ? m.providerContinuation : undefined
      const matchingContinuation = geminiCallsMatch(continuation, m.toolCalls) ? continuation : undefined
      const ordered = replayGeminiParts(matchingContinuation, m.content, m.toolCalls)
      if (ordered !== undefined) { contents.push({ role: "model", parts: ordered }); continue }
      const safeContinuation = matchingContinuation?.partOrder ? undefined : matchingContinuation
      const parts: unknown[] = [
        ...(safeContinuation?.thoughtParts ?? []).map((part) => ({ text: part.text, thought: true, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) })),
        ...(m.content !== "" ? [{ text: m.content, ...(safeContinuation?.textSignature ? { thoughtSignature: safeContinuation.textSignature } : {}) }] : []),
        ...(safeContinuation?.emptyTextSignatures ?? []).map((thoughtSignature) => ({ text: "", thoughtSignature })),
      ]
      for (const [index, c] of m.toolCalls.entries()) {
        const signature = safeContinuation?.callSignatures[index]
        parts.push({ functionCall: { id: c.id, name: c.name, args: c.args }, ...(signature ? { thoughtSignature: signature } : {}) })
      }
      contents.push({ role: "model", parts })
      continue
    }
    if (m.role === "assistant" && m.providerContinuation?.kind === "gemini" && canReplayContinuation(m.providerContinuation, config)) {
      const continuation = m.providerContinuation
      const ordered = replayGeminiParts(continuation, m.content, [])
      if (ordered !== undefined) { contents.push({ role: "model", parts: ordered }); continue }
      if (continuation.partOrder) { contents.push({ role: "model", parts: [{ text: m.content }] }); continue }
      contents.push({ role: "model", parts: [
        ...(continuation.thoughtParts ?? []).map((part) => ({ text: part.text, thought: true, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) })),
        ...(m.content !== "" ? [{ text: m.content, ...(continuation.textSignature ? { thoughtSignature: continuation.textSignature } : {}) }] : []),
        ...(continuation.emptyTextSignatures ?? []).map((thoughtSignature) => ({ text: "", thoughtSignature })),
      ] })
      continue
    }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts: toGeminiParts(m.content) })
  }
  flushImages()
  return contents
}
