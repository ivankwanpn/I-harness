import { deriveMessages, renderPruneSubstitute, type Session, type PruneRecord } from "@i-harness/core-session"
import type { ResolvedPruneConfig } from "../config.ts"
import { activeTokens } from "../tokens.ts"

/** Plan against the active substituted surface, once per call identity. */
export function planPrune(session: Session, prune: ResolvedPruneConfig): PruneRecord[] {
  if (!prune.enabled) return []
  if (!session.events.some(event => event.type === "tool/result")) return []
  const records: PruneRecord[] = [], seen = new Set<string>()
  for (const message of deriveMessages(session)) {
    if (message.role !== "tool" || seen.has(message.toolCallId)) continue
    seen.add(message.toolCallId)
    const text = typeof message.content === "string" ? message.content : safeStringifyOutput(message.content)
    if (text === null || text.length <= prune.thresholdChars) continue
    const record = { callId: message.toolCallId, head: text.slice(0, prune.headChars), tail: text.slice(-prune.tailChars), removedBytes: Buffer.byteLength(text.slice(prune.headChars, -prune.tailChars), "utf8") }
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
