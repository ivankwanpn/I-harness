import { canReplayContinuation, replayBlockOrder, replayVisibleToolOrder, stringifyJsonData, toolResultImageLabel, type LLMContentPart, type LLMRequest, type ProviderContinuation } from "@i-harness/llm-seam"
import type { GeminiConfig } from "../types.ts"
import { officialGeminiGeneration, supportsFunctionResponseImage } from "./capabilities.ts"
import { record } from "./protojson.ts"

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
function toFunctionResponse(content: string | LLMContentPart[]): Record<string, unknown> {
  if (typeof content !== "string") {
    content = content.filter(p => p.type === 'text').map(p => p.text).join("\n")
  }
  if (content.trim() !== "") {
    try {
      const parsed = JSON.parse(content) as unknown
      if (record(parsed)) return parsed
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
    (text, _phase, thoughtSignature) => ({ text, ...(thoughtSignature ? { thoughtSignature } : {}) }), calls)
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
  // Resolve each tool result against the preceding emitted call group. A
  // later exchange may legitimately reuse an id with a different name.
  const callsById = new Map<string, { name: string; position: number }>()
  const generation = officialGeminiGeneration(config)
  const contents: { role: "user" | "model"; parts: unknown[] }[] = []
  type ResultPart = { functionResponse: { id: string; name: string; response: Record<string, unknown>; parts?: unknown[] } }
  let functionResponses: ResultPart[] | undefined
  let toolImages: unknown[] = []
  const finishResults = () => {
    if (!functionResponses) return
    if (generation !== undefined && generation < 3 && functionResponses.length > 1) {
      // These models can match parallel results by position. Follow the
      // assistant order actually serialized, even if tools finished out of order.
      const position = (part: ResultPart) => callsById.get(part.functionResponse.id)?.position ?? Infinity
      functionResponses.sort((left, right) => position(left) - position(right))
    }
    if (toolImages.length) contents.push({ role: 'user', parts: toolImages })
    toolImages = []
    functionResponses = undefined
  }
  for (const m of messages) {
    if (m.role === "tool") {
      if (functionResponses === undefined) {
        callsById.clear()
        const prior = contents.at(-1)
        if (prior?.role === 'model') {
          for (const [position, part] of prior.parts.entries()) {
            if (record(part) && record(part.functionCall) && typeof part.functionCall.id === 'string' && typeof part.functionCall.name === 'string')
              callsById.set(part.functionCall.id, { name: part.functionCall.name, position })
          }
        }
        functionResponses = []
        contents.push({ role: "user", parts: functionResponses })
      }
      const images = Array.isArray(m.content) ? m.content.filter(part => part.type === "image") : []
      const native = generation !== undefined && generation >= 3 && images.length > 0 && images.every(({image}) => supportsFunctionResponseImage(image.mediaType))
      const response = toFunctionResponse(m.content)
      functionResponses.push({ functionResponse: {
        id: m.toolCallId,
        name: callsById.get(m.toolCallId)?.name ?? "",
        response: m.isError ? { error: response } : Object.hasOwn(response, 'error') ? { output: response } : response,
        ...(native ? { parts: toGeminiParts(images) } : {}),
      } })
      if (images.length && !native) toolImages.push({ text: toolResultImageLabel(m.toolCallId) }, ...toGeminiParts(images))
      continue
    }
    finishResults()
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const continuation = m.providerContinuation?.kind === "gemini" && canReplayContinuation(m.providerContinuation, config)
        ? m.providerContinuation : undefined
      const matchingContinuation = geminiCallsMatch(continuation, m.toolCalls) ? continuation : undefined
      const ordered = replayGeminiParts(matchingContinuation, m.content, m.toolCalls)
      if (ordered !== undefined) { contents.push({ role: "model", parts: ordered }); continue }
      const safeContinuation = matchingContinuation?.partOrder ? undefined : matchingContinuation
      const calls = m.toolCalls.map(({ id, name, args }, index) => {
        const signature = safeContinuation?.callSignatures[index]
        return { functionCall: { id, name, args }, ...(signature ? { thoughtSignature: signature } : {}) }
      })
      const portable = !continuation ? replayVisibleToolOrder<unknown>(m, calls, text => ({ text })) : undefined
      const parts = portable ?? [
        ...(safeContinuation?.thoughtParts ?? []).map((part) => ({ text: part.text, thought: true, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) })),
        ...(m.content !== "" ? [{ text: m.content, ...(safeContinuation?.textSignature ? { thoughtSignature: safeContinuation.textSignature } : {}) }] : []),
        ...(safeContinuation?.emptyTextSignatures ?? []).map((thoughtSignature) => ({ text: "", thoughtSignature })),
        ...calls,
      ]
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
  finishResults()
  return contents
}
