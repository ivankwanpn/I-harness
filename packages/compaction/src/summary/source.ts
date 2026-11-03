import { createHash } from 'node:crypto'
import { canonicalJsonData, renderConversation, type LLMContentPart, type LLMMessage } from '@i-harness/core-session'
import type { ReductionGroup } from '@i-harness/context-engine'
import { SummaryBlockedError } from '../summary-errors.ts'

export const sourceHash = (text: string) => createHash('sha256').update(text).digest('hex')
export interface RecordedSegment {
  readonly segmentId: string
  readonly source: { groupId: string; itemRef: unknown; messageIndex: number; field: string; partIndex?: number; role: string; callId?: string; callName?: string; sources: unknown; provenance: unknown }
  readonly totalBytes: number
  readonly digest: string
  readonly text?: string
  readonly media?: LLMContentPart
  readonly label: string
}
function reasoning(message: Extract<LLMMessage, { role: 'assistant' }>): (string | undefined)[] {
  const native = message.providerContinuation
  if (native?.kind === 'openai-compatible') return [native.reasoningContent]
  if (native?.kind === 'gemini') return (native.thoughtParts ?? []).map(part => part.text)
  if (native?.kind === 'bedrock') return native.reasoningBlocks.map(block => 'reasoningText' in block ? block.reasoningText.text : undefined)
  if (native?.kind === 'openai-responses') return native.reasoningItems.map(item => Array.isArray(item.summary) ? item.summary.flatMap(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? [part.text] : []).join('') : undefined)
  return (message.thinkingBlocks ?? []).map(block => block.type === 'thinking' ? block.thinking : undefined)
}
/** The one portable encoder enumerates captured visible semantics in native order. */
export function recordedSegments(groups: readonly ReductionGroup[]): readonly RecordedSegment[] {
  const segments: RecordedSegment[] = []
  for (const group of groups) for (const item of group.items) {
    let semantic = false
    const messages = renderConversation({ items: [item] })
    const names = new Map(messages.flatMap(message => message.role === 'assistant' ? (message.toolCalls ?? []).map(call => [call.id, call.name] as const) : []))
    for (const [messageIndex, message] of messages.entries()) {
      const add = (field: string, value: string | LLMContentPart, partIndex?: number, callId?: string, callName?: string, label = '') => {
        const text = typeof value === 'string' ? value : undefined
        // UTF8 cannot faithfully represent lone UTF16 surrogates. Never silently replace them.
        if (text !== undefined && Buffer.from(text).toString('utf8') !== text) throw new SummaryBlockedError('source-unrepresentable')
        const encoded = text ?? canonicalJsonData(value)
        const source = { groupId: group.id, itemRef: item.ref ?? item.id, messageIndex, field, ...(partIndex !== undefined ? { partIndex } : {}), role: message.role,
          ...(callId ? { callId } : {}), ...(callName ? { callName } : {}), sources: item.sources, provenance: item.provenance }
        segments.push(Object.freeze({ segmentId: `${group.id}:${segments.length}`, source, totalBytes: Buffer.byteLength(encoded), digest: sourceHash(encoded),
          ...(text !== undefined ? { text } : { media: value as LLMContentPart }), label }))
        semantic ||= text !== undefined ? text.length > 0 : true
      }
      if (message.role === 'assistant') {
        const reasons = reasoning(message), native = message.providerContinuation
        const order = native?.kind === 'gemini' ? native.partOrder : native?.kind === 'openai-responses' ? native.outputOrder : native?.kind === 'anthropic' || native?.kind === 'bedrock' ? native.contentOrder : undefined
        const call = (index: number) => { const value = message.toolCalls?.[index]; if (value) add('call-arguments', canonicalJsonData(value.args), index, value.id, value.name, `[recorded tool call ${value.name} id=${value.id}]\n`) }
        if (order?.length) {
          const seenReasoning = new Set<number>(), seenCalls = new Set<number>()
          if (order.filter(entry => entry.kind === 'text').map(entry => entry.text).join('') !== message.content) throw new SummaryBlockedError('source-unrepresentable')
          for (const [index, entry] of order.entries()) {
            if (entry.kind === 'text') add('assistant-text', entry.text, index)
            else if (entry.kind === 'reasoning') { if (seenReasoning.has(entry.index) || !Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= reasons.length) throw new SummaryBlockedError('source-unrepresentable'); seenReasoning.add(entry.index); if (reasons[entry.index] !== undefined) add('visible-reasoning', reasons[entry.index]!, entry.index) }
            else { if (seenCalls.has(entry.index) || !message.toolCalls?.[entry.index]) throw new SummaryBlockedError('source-unrepresentable'); seenCalls.add(entry.index); call(entry.index) }
          }
          if (reasons.some((value, index) => !!value && !seenReasoning.has(index)) || (message.toolCalls ?? []).some((_, index) => !seenCalls.has(index))) throw new SummaryBlockedError('source-unrepresentable')
        } else { for (const [index, value] of reasons.entries()) if (value !== undefined) add('visible-reasoning', value, index); add('assistant-text', message.content); for (let i = 0; i < (message.toolCalls?.length ?? 0); i++) call(i) }
      } else {
        const callId = message.role === 'tool' ? message.toolCallId : undefined
        if (typeof message.content === 'string') add(`${message.role}-text`, message.content, undefined, callId, callId ? names.get(callId) : undefined)
        else for (const [index, part] of message.content.entries()) add(part.type === 'text' ? 'content-part-text' : 'media', part.type === 'text' ? part.text : part, index, callId, callId ? names.get(callId) : undefined)
      }
    }
    if (!semantic && !messages.some(message => message.role !== 'assistant' || !message.providerContinuation && !message.thinkingBlocks?.length)) throw new SummaryBlockedError('source-unrepresentable')
  }
  return Object.freeze(segments)
}
export function portableSource(groups: readonly ReductionGroup[]): LLMMessage[] {
  const segments = recordedSegments(groups)
  return groups.flatMap(group => group.items.map(item => {
    const content: LLMContentPart[] = [{ type: 'text', text: `[recorded-source group=${group.id} kind=${item.kind} author=${item.provenance.kind} authority=${item.provenance.authority}]` }]
    let messageIndex = -1
    for (const segment of segments.filter(segment => segment.source.groupId === group.id && canonicalJsonData(segment.source.itemRef) === canonicalJsonData(item.ref ?? item.id))) {
      if (segment.source.messageIndex !== messageIndex) { messageIndex = segment.source.messageIndex; content.push({ type: 'text', text: `[recorded ${segment.source.role}${segment.source.role === 'tool' ? ` result ${segment.source.callId}` : ''}]` }) }
      if (segment.media) content.push(segment.media)
      else if (segment.text?.length) content.push({ type: 'text', text: segment.label + segment.text })
    }
    return { role: 'user' as const, content }
  }))
}
export function selectedSource(groups: readonly ReductionGroup[], portable: boolean) {
  const observations = portableSource(groups)
  const selected = portable ? observations : renderConversation({ items: groups.flatMap(group => group.items) })
  const opener: LLMMessage[] = selected[0]?.role !== 'user' ? [{ role: 'user', content: '[source-record framing: the following messages are recorded observations with provenance in the manifest]' }] : []
  const messages = [...opener, ...selected]
  let cursor = opener.length
  const manifest = groups.map(group => {
    const count = portable ? group.items.length : group.items.reduce((n, item) => n + item.messages.length, 0)
    const row = { group: group.id, messages: [cursor, cursor + count], sources: group.coverage, provenance: group.items.map(item => ({ itemKind: item.kind, ...item.provenance })) }
    cursor += count; return row
  })
  const images = messages.reduce((n, message) => n + (typeof message.content === 'string' ? 0 : message.content.filter(part => part.type === 'image').length), 0)
  return { messages, images, manifest: JSON.stringify(manifest) }
}
