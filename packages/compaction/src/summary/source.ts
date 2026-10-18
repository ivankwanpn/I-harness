import { renderConversation, type LLMContentPart, type LLMMessage } from '@i-harness/core-session'
import type { ReductionGroup } from '@i-harness/context-engine'
import { SummaryBlockedError } from '../summary-errors.ts'

function reasoning(message: Extract<LLMMessage, { role: 'assistant' }>): (string | undefined)[] {
  const native = message.providerContinuation
  if (native?.kind === 'openai-compatible') return [native.reasoningContent]
  if (native?.kind === 'gemini') return (native.thoughtParts ?? []).map(part => part.text)
  if (native?.kind === 'bedrock') return native.reasoningBlocks.map(block => 'reasoningText' in block ? block.reasoningText.text : undefined)
  if (native?.kind === 'openai-responses') return native.reasoningItems.map(item => Array.isArray(item.summary) ? item.summary.flatMap(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? [part.text] : []).join('') : undefined)
  return (message.thinkingBlocks ?? []).map(block => block.type === 'thinking' ? block.thinking : undefined)
}
/** Portable encoder over selected typed items; never a Session renderer. */
export function portableSource(groups: readonly ReductionGroup[]): LLMMessage[] {
  return groups.flatMap(group => group.items.map(item => {
    const content: LLMContentPart[] = [{ type: 'text', text: `[recorded-source group=${group.id} kind=${item.kind} author=${item.provenance.kind} authority=${item.provenance.authority}]` }]
    let semantic = false
    const text = (value: string) => { if (value.length) { semantic = true; content.push({ type: 'text', text: value }) } }
    for (const message of renderConversation({ items: [item] })) {
      content.push({ type: 'text', text: `[recorded ${message.role}${message.role === 'tool' ? ` result ${message.toolCallId}` : ''}]` })
      if (message.role === 'assistant') {
        const reasons = reasoning(message), native = message.providerContinuation
        const order = native?.kind === 'gemini' ? native.partOrder : native?.kind === 'openai-responses' ? native.outputOrder : native?.kind === 'anthropic' || native?.kind === 'bedrock' ? native.contentOrder : undefined
        const call = (i: number) => { const value = message.toolCalls?.[i]; if (value) text(`[recorded tool call ${value.name} id=${value.id}]\n${JSON.stringify(value.args)}`) }
        if (order?.length) {
          const seenReasoning = new Set<number>(), seenCalls = new Set<number>()
          if (order.filter(entry => entry.kind === 'text').map(entry => entry.text).join('') !== message.content) throw new SummaryBlockedError('source-unrepresentable')
          for (const entry of order) {
            if (entry.kind === 'text') text(entry.text)
            else if (entry.kind === 'reasoning') { if (seenReasoning.has(entry.index) || !Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= reasons.length) throw new SummaryBlockedError('source-unrepresentable'); seenReasoning.add(entry.index); text(reasons[entry.index] ?? '') }
            else { if (seenCalls.has(entry.index) || !message.toolCalls?.[entry.index]) throw new SummaryBlockedError('source-unrepresentable'); seenCalls.add(entry.index); call(entry.index) }
          }
          if (reasons.some((value, index) => !!value && !seenReasoning.has(index)) || (message.toolCalls ?? []).some((_, index) => !seenCalls.has(index))) throw new SummaryBlockedError('source-unrepresentable')
        } else { for (const value of reasons) text(value ?? ''); text(message.content); for (let i = 0; i < (message.toolCalls?.length ?? 0); i++) call(i) }
      } else if (typeof message.content === 'string') text(message.content)
      else for (const part of message.content) { if (part.type === 'text') text(part.text); else { semantic = true; content.push(part) } }
    }
    if (!semantic) throw new SummaryBlockedError('source-unrepresentable')
    return { role: 'user' as const, content }
  }))
}
export function selectedSource(groups: readonly ReductionGroup[], portable: boolean) {
  // Coverage always needs complete visible semantics, including on a native
  // adapter that could otherwise accept an opaque continuation by itself.
  const observations = portableSource(groups)
  const messages = portable ? observations : renderConversation({ items: groups.flatMap(group => group.items) })
  let cursor = 0
  const manifest = groups.map(group => {
    const count = portable ? group.items.length : group.items.reduce((n, item) => n + item.messages.length, 0)
    const row = { group: group.id, messages: [cursor, cursor + count], sources: group.coverage,
      provenance: group.items.map(item => ({ itemKind: item.kind, ...item.provenance })) }
    cursor += count; return row
  })
  const images = messages.reduce((n, message) => n + (typeof message.content === 'string' ? 0 : message.content.filter(part => part.type === 'image').length), 0)
  return { messages, images, manifest: JSON.stringify(manifest) }
}
