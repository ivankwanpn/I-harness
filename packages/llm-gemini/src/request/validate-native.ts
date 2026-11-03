import { encodeSdkCommandData } from '@i-harness/token-meter'
import { type LLMMessage, validationCollector } from '@i-harness/llm-seam'
import { field, record } from './protojson.ts'
/** Raw replacements cannot inherit mapper attribution. A retained captured
 * signature is bound to its original complete part and position; unrelated
 * signed caller data remains unverified rather than acquiring local proof. */
export function validateGeminiNative(body: Record<string, unknown>, mapped: readonly unknown[], source: readonly LLMMessage[], rawOverride: boolean, check: ReturnType<typeof validationCollector>): void {
  const contents = field(body, 'contents')
  if (!Array.isArray(contents)) return
  const expected = new Map<string, { content: number; part: number; encoded: string }[]>()
  for (const [contentIndex, content] of mapped.entries()) {
    if (!record(content) || !Array.isArray(content.parts)) continue
    for (const [partIndex, part] of content.parts.entries()) {
      const signature = field(part, 'thoughtSignature')
      if (typeof signature !== 'string') continue
      const entries = expected.get(signature) ?? []
      entries.push({ content: contentIndex, part: partIndex, encoded: encodeSdkCommandData(part) }); expected.set(signature, entries)
    }
  }
  let native = false, preserved = false, incompatible = false, unverified = false
  for (const [contentIndex, content] of contents.entries()) {
    if (!record(content) || !Array.isArray(content.parts)) continue
    for (const [partIndex, part] of content.parts.entries()) {
      const signature = field(part, 'thoughtSignature')
      if (typeof signature !== 'string') continue
      native = true
      const original = expected.get(signature)
      if (original) {
        if (!original.some(entry => entry.content === contentIndex && entry.part === partIndex && entry.encoded === encodeSdkCommandData(part))) incompatible = true
        else if (!rawOverride) preserved = true
      } else unverified = true
    }
  }
  // Each assistant owns its native obligation. Another assistant's surviving
  // signature cannot represent this one's opaque-only data or prove that a
  // portable visible-text/call fallback retained native source.
  const assistants = (values: readonly unknown[]) => values.flatMap((content, index) => record(content) && field(content, 'role') === 'model' && Array.isArray(content.parts) ? [{ index, parts: content.parts }] : [])
  const projected = assistants(mapped), actual = assistants(contents)
  const sources = source.filter((message): message is Extract<LLMMessage, { role: 'assistant' }> => message.role === 'assistant')
  for (const [ordinal, message] of sources.entries()) {
    const continuation = message.providerContinuation?.kind === 'gemini' ? message.providerContinuation : undefined
    if (!continuation || !(continuation.callSignatures.some(Boolean) || continuation.textSignature || continuation.thoughtParts?.length || continuation.emptyTextSignatures?.length)) continue
    const before = projected[ordinal], after = actual[ordinal]
    const nativeParts = before?.parts.flatMap((part, index) => record(part) && (field(part, 'thought') === true || typeof field(part, 'thoughtSignature') === 'string') ? [{ part, index }] : []) ?? []
    const retained = nativeParts.length > 0 && before?.index === after?.index && nativeParts.every(({ part, index }) => encodeSdkCommandData(part) === encodeSdkCommandData(after?.parts[index]))
    if (!retained) {
      if (!message.content && !message.toolCalls?.length) incompatible = true
      else unverified = true
    } else if (rawOverride) unverified = true
  }
  if (incompatible) { check.issue('native-replay', 'native', 'native-replay'); check.native('incompatible') }
  else if (unverified || native && (!preserved || rawOverride) || !native && source.some(message => message.role === 'assistant' && message.providerContinuation?.kind === 'gemini' && (message.providerContinuation.callSignatures.some(Boolean) || message.providerContinuation.textSignature || message.providerContinuation.thoughtParts?.length || message.providerContinuation.emptyTextSignatures?.length))) check.native()
  else if (preserved) check.native('preserved')
}
