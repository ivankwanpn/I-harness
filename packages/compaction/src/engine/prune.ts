import type { Session } from "@i-harness/core-session"
import { renderPruneSubstitute, type PruneRecord } from "@i-harness/core-session"
import type { ResolvedPruneConfig } from "../config.ts"
import { activeTokens } from "../tokens.ts"

// M33 §4.2: the prune plan — every tool/result whose stringified output
// exceeds `prune.thresholdChars` becomes a record (head/tail carving aligned
// with the retention caps; `removedBytes` = the byte length of the middle).
// A stringify failure (e.g. a BigInt payload) degrades to "not prunable" —
// fail-soft, it just does not participate in this pass.
export function planPrune(session: Session, prune: ResolvedPruneConfig): PruneRecord[] {
  if (!prune.enabled) return []
  const records: PruneRecord[] = []
  for (const ev of session.events) {
    if (ev.type !== "tool/result") continue
    const text = safeStringifyOutput(ev.output)
    if (text === null || text.length <= prune.thresholdChars) continue
    const removed = text.slice(prune.headChars, text.length - prune.tailChars)
    records.push({
      callId: ev.callId,
      head: text.slice(0, prune.headChars),
      tail: prune.tailChars > 0 ? text.slice(-prune.tailChars) : "",
      removedBytes: byteLength(removed),
    })
  }
  return records
}

// M33 §4.2: "替身計數" — the visible surface AFTER the plan's substitutes were
// applied (dsh 語義: pruning alone has resolved the pressure). Estimates by
// pricing the savings of VISIBLE prune candidates (events a prior
// compaction/summary|reset already hides are not on the surface and cost
// nothing) off the current activeTokens — the meter's role overhead cancels
// between the before/after tool messages.
export function surfaceTokensAfterPrune(session: Session, records: PruneRecord[]): number {
  const shadowed = new Set<number>()
  for (const ev of session.events) {
    if (ev.type === "compaction/summary") for (const seq of ev.shadowedSeqs) shadowed.add(seq)
    // defensive `?? []`: persisted logs bypass append validation
    else if (ev.type === "compaction/reset") for (const seq of ev.removedSeqs ?? []) shadowed.add(seq)
  }
  const byCall = new Map<string, PruneRecord>()
  for (const record of records) byCall.set(record.callId, record)
  let savings = 0
  for (const ev of session.events) {
    if (ev.type !== "tool/result") continue
    if (ev.seq !== undefined && shadowed.has(ev.seq)) continue
    const record = byCall.get(ev.callId)
    if (record === undefined) continue
    const before = safeStringifyOutput(ev.output)
    if (before === null) continue
    const after = renderPruneSubstitute(record)
    savings += Math.ceil(before.length / 4) - Math.ceil(after.length / 4)
  }
  return Math.max(0, activeTokens(session) - savings)
}

function safeStringifyOutput(output: unknown): string | null {
  try {
    return JSON.stringify(output)
  } catch {
    return null
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}
