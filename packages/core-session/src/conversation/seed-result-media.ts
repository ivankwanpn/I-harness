import type { LLMContentPart, LLMMessage } from '../projection/types.ts'
import type { SeedResult } from './seed-types.ts'

/** Earlier seeds stored a tool's images in a separate user message. Only a
 * saved result's exact media addresses can give those parts back to the tool. */
export function restoreSeedResultMedia(messages: LLMMessage[], results: readonly Pick<SeedResult, 'message' | 'media'>[]): LLMMessage[] {
  if (!results.some(result => result.media.some(ref => ref.message !== result.message))) return messages
  const taken = new Map<number, Set<number>>(), attached = new Map<number, LLMContentPart[]>()
  for (const result of results) for (const ref of result.media) {
    if (ref.message === result.message) continue
    const source = messages[ref.message]
    const part = source?.role === 'user' && Array.isArray(source.content) ? source.content[ref.part] : undefined
    if (part?.type !== 'image' || messages[result.message]?.role !== 'tool') throw new TypeError('Invalid inherited tool result media address')
    const indices = taken.get(ref.message) ?? new Set<number>()
    indices.add(ref.part); taken.set(ref.message, indices)
    const parts = attached.get(result.message) ?? []
    parts.push(part); attached.set(result.message, parts)
  }
  return messages.flatMap((message, i): LLMMessage[] => {
    const parts = attached.get(i)
    if (message.role === 'tool' && parts) return [{ ...message, content: [
      ...(typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content), ...parts,
    ] }]
    const indices = taken.get(i)
    if (message.role !== 'user' || !indices || !Array.isArray(message.content)) return [message]
    const remaining = message.content.filter((_, index) => !indices.has(index))
    if (!remaining.length || remaining.length === 1 && remaining[0]!.type === 'text' && remaining[0]!.text === 'Attached image(s) from tool result:') return []
    return [{ ...message, content: remaining }]
  })
}
