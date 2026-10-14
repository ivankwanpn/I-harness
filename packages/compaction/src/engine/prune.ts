import { deriveMessages, derivePruneSubstitutes, renderPruneSubstitute, type Session, type PruneRecord } from "@i-harness/core-session"
import type { ResolvedPruneConfig } from "../config.ts"
import { activeTokens } from "../tokens.ts"

/** Plan against the active substituted surface, once per call identity. */
export function planPrune(session: Session, prune: ResolvedPruneConfig): PruneRecord[] {
  if (!prune.enabled) return []
  if (!session.events.some(event => event.type === "tool/result")) return []
  const records: PruneRecord[] = [], seen = new Set<string>()
  const existing = derivePruneSubstitutes(session)
  let originalByCall: Map<string, string | null> | undefined
  const originalText = (callId: string) => {
    if (!originalByCall) {
      originalByCall = new Map()
      // Only a genuinely tighter carve needs the original byte provenance.
      // Keep the same active shadow/rewind/tool fold; remove substitutions only.
      for (const message of deriveMessages({ ...session, events: session.events.filter(event => event.type !== "compaction/prune") })) {
        if (message.role === "tool" && !originalByCall.has(message.toolCallId)) originalByCall.set(message.toolCallId, typeof message.content === "string" ? message.content : safeStringifyOutput(message.content))
      }
    }
    return originalByCall.get(callId)
  }
  for (const message of deriveMessages(session)) {
    if (message.role !== "tool" || seen.has(message.toolCallId)) continue
    seen.add(message.toolCallId)
    const text = typeof message.content === "string" ? message.content : safeStringifyOutput(message.content)
    if (text === null || text.length <= prune.thresholdChars) continue
    const previous = existing.get(message.toolCallId)
    const head = previous ? previous.head.slice(0, prune.headChars) : text.slice(0, prune.headChars)
    const tail = previous ? previous.tail.slice(-prune.tailChars) : text.slice(-prune.tailChars)
    // The marker itself is never additional removed tool content. Equal or
    // looser retained bounds cannot replace its original removal provenance.
    if (previous && head === previous.head && tail === previous.tail) continue
    const original = previous ? originalText(message.toolCallId) : text
    if (original == null || !original.startsWith(head) || !original.endsWith(tail)) continue
    const record = { callId: message.toolCallId, head, tail, removedBytes: Buffer.byteLength(original.slice(head.length, original.length - tail.length), "utf8") }
    if (renderPruneSubstitute(record).length < text.length) records.push(record)
  }
  return records
}

/** Price the same candidate fold that the marker would produce. */
export function surfaceTokensAfterPrune(session: Session, records: PruneRecord[]): number {
  return activeTokens({ ...session, events: [...session.events, { type: "compaction/prune", version: 1, pruned: records, seq: session.events.length }] })
}

function safeStringifyOutput(output: unknown): string | null {
  try { return JSON.stringify(output) ?? null } catch { return null }
}
