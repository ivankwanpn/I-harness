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
  // A stale mapper-side native order has an explicit portable semantic source;
  // opaque-only removal is blocked, never reported as preserved.
  const lost = source.some(message => message.role === 'assistant' && message.providerContinuation?.kind === 'gemini'
    && !message.content && !message.toolCalls?.length && message.providerContinuation.thoughtParts?.length && !native)
  if (incompatible || lost) { check.issue('native-replay', 'native', 'native-replay'); check.native('incompatible') }
  else if (unverified || native && (!preserved || rawOverride) || !native && source.some(message => message.role === 'assistant' && message.providerContinuation?.kind === 'gemini' && (message.providerContinuation.callSignatures.some(Boolean) || message.providerContinuation.textSignature || message.providerContinuation.thoughtParts?.length || message.providerContinuation.emptyTextSignatures?.length))) check.native()
  else if (preserved) check.native('preserved')
}
