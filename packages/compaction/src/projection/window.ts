import type { SessionView as Session, LegacyCompactionFacts, ProducerFactOutcome } from "@i-harness/core-session"
import { committedFactSeqs } from "@i-harness/core-session"
import { ordinaryCompactionFacts } from '../engine/facts.ts'
import type { CompactionResult } from "../index.ts"
import { activeTokens } from "../tokens.ts"
import { walkOffToolEvents } from "../region.ts"

// M20: pure reset (absorbs codex token-budget `start_new_context_window`) —
// new context window: keeps the last `retainLast` events (by seq) visible and
// hides everything older, appending a `compaction/reset` marker, no summary.
// FIX ROUND 1 (Ruling 4 — M11-consistent append-only shadow): the durable log
// is NEVER truncated. Persistence backends are append-only (sqlite/JSONL
// mirror via onAppend), so in-place deletions never reached disk — on resume
// the full pre-reset history returned, re-overflowing every time. Instead the
// marker carries `removedSeqs`; deriveMessages shadows exactly those seqs
// (same mechanism as `compaction/summary.shadowedSeqs`) and activeTokens
// prices that same projection, so checkBudget sees the post-reset surface.
// Recovery replays the log ⇒ nothing lost. Events with `seq === undefined`
// are never removable: they cannot be keyed and include externally-injected
// user messages the agent loop must retain. Nothing removable →
// `{ compacted: false, reset: false }` (caller falls through to fail-closed).
export async function resetWindowOnce(session: Session, retainLast: number, facts?: () => LegacyCompactionFacts<ProducerFactOutcome>): Promise<CompactionResult> {
  if (!Number.isInteger(retainLast) || retainLast < 1) {
    throw new Error(`compaction: resetWindow retainLast must be a positive integer (got ${retainLast})`)
  }
  // M5/D2: the retained tail must not start inside a tool block — the shared
  // rule lives in `walkOffToolEvents` (this site used to inline the loop; so did
  // selectShadowableRange). It walks the cut BACKWARDS (retaining more, never
  // less) until it rests on a cut that keeps every result's call with it.
  // M76: that rule is EXACT now (it asks the result side, so M70's
  // `tool/dispatch` between a call and its result can no longer end the walk
  // early). Measured on an 8-turn read session in the shipped order
  // (call → dispatch → result, 72 events), `retainLast` 1..25: 6 values orphan
  // with no walk at all ([4,5,13,14,22,23]) and STILL 6 under the pre-M76
  // heuristic — the walk was inert — while the exact rule leaves 0. The same
  // fixture over 200 sampled `retainTokens` budgets (10..2000 step 10):
  // 115 orphan with no walk, 115 under the heuristic, 0 with the exact rule.
  // The reading that stood here ("4 of the first 25") was measured before M70
  // wrote a dispatch into every tool run.
  const cut = walkOffToolEvents(session, Math.max(0, session.events.length - retainLast))
  const keepSeqs = new Set(
    session.events.slice(cut).map((e) => e.seq).filter((s): s is number => s !== undefined),
  )
  const removedSeqs: number[] = []
  for (const ev of session.events) {
    if (ev.seq === undefined || keepSeqs.has(ev.seq)) continue
    removedSeqs.push(ev.seq)
  }
  if (removedSeqs.length === 0) return { compacted: false, shadowedSeqs: [], reset: false }
  // Append-only record of the removal — no `session.events` mutation.
  committedFactSeqs(await ordinaryCompactionFacts(session, facts).commit([{ type: "compaction/reset", removedSeqs }]))
  return { compacted: true, shadowedSeqs: removedSeqs, reset: true }
}

// M34 ⑦b: defensive meter read — the token-meter projects through the same
// deriveMessages that has been made defensive for malformed persisted logs,
// but its OWN defensive envelope is not warranted for a host-optional
// analytics feed: any measurement failure degrades to `undefined` (the
// attempt continues; the telemetry token fields stay unset) — never a
// TypeError escaping compaction (Ruling 7 convention).
export function safeActiveTokens(session: Session): number | undefined {
  try {
    return activeTokens(session)
  } catch {
    return undefined
  }
}
