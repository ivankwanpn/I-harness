import type { SessionView as Session } from "@i-harness/core-session"
import type { CompactionEngine, CompactionResult } from "../index.ts"
import { resetWindowOnce, safeActiveTokens } from "../projection/window.ts"
import type { CompactPass, CompactSettings } from "./contracts.ts"
import { hasReplacementHistory } from '../projection/shadowed.ts'

// Both WeakMaps belong to this module, shared across engines for a Session.
export function createAdmission(
  config: CompactSettings, contextWindow: number,
  readContextTokens: (session: Session) => number, overheadNow: () => number,
  compactOnce: CompactPass,
  reset: CompactionEngine['resetWindow'] = resetWindowOnce,
): CompactionEngine {
  return {
    async maybeCompact(session: Session, options): Promise<CompactionResult> {
      if (hasReplacementHistory(session)) return { compacted: false, reason: 'replacement-history-unsupported', shadowedSeqs: [] }
      options?.signal?.throwIfAborted()
      // M33 §3.1: the host-known charge the session log does not carry
      // (system prompt + tool schemas — CompactionConfig.overheadTokens).
      if (readContextTokens(session) < contextWindow * config.thresholdRatio) {
        return { compacted: false, shadowedSeqs: [] }
      }
      // M34 ⑦d — the auto-path gate stack (documented state machine):
      //   (1) pressure gate (§3.1) — below threshold: nothing to do.
      //   (2) sticky — set by an AUTO success that STILL leaves the surface
      //       over the threshold ("success but over"). Suppresses the auto
      //       path until NEW non-marker events arrive (same predicate as the
      //       re-fire guard) or a MANUAL compaction succeeds. This is what
      //       stops the prune-only hot loop: a prune-only pass appends no
      //       `compaction/end`, so the re-fire guard alone would re-plan (and
      //       re-append) the same prune records on the next step when the
      //       meter + overhead still reads over threshold.
      //   (3) re-fire guard (pre-M33) — no new non-marker events past the
      //       LAST `compaction/end`: no work, no re-compact.
      //   (4) hysteresis (M33 §2.1) — `minTurnsBeforeRecompact` turn/end
      //       events must pass after the last compaction.
      //   (5) breaker (M33 §2.2, M34 until-success) — 3 consecutive AUTO
      //       failures open the circuit: paused until new non-marker events
      //       arrive (ONE attempt per content burst — the recovered model is
      //       given a chance, the failing one is never hammered), but the
      //       counter is NEVER restarted by content — only a successful
      //       compaction (auto OR manual) closes the circuit. Where M33
      //       reset the count on new content, M34 keeps it: the pause is
      //       effectively "until a success" with a per-burst attempt.
      //   `compact()` (explicit) is UNGATED (only its success side effects
      //   touch the state above).
      const stickySeq = stickyFromSeq.get(session) ?? -1
      if (stickySeq >= 0) {
        if (!hasNonMarkerEventsAfter(session, stickySeq)) {
          return { compacted: false, shadowedSeqs: [] }
        }
        stickyFromSeq.delete(session) // new non-marker content releases the stick
      }
      const last = lastCompactionEndSeq(session)
      if (last >= 0 && !hasNonMarkerEventsAfter(session, last)) {
        return { compacted: false, shadowedSeqs: [] } // no new work since the last compaction
      }
      // M33 §2.1 hysteresis: after a compaction, at least
      // `minTurnsBeforeRecompact` turn/end events must pass before the AUTO
      // path may run again (0 = the pure pre-M33 re-fire guard). Explicit
      // compact()/resetWindow() stay ungated.
      if (last >= 0 && config.minTurnsBeforeRecompact > 0) {
        if (countTurnEndsAfter(session, last) < config.minTurnsBeforeRecompact) {
          return { compacted: false, shadowedSeqs: [] }
        }
      }
      // M34 ⑦d (until-success): release the pause on new content but keep
      // the counter — success is the only reset.
      let failures = (autoFailures.get(session) ?? { count: 0, openSeq: -1 }).count
      if (failures >= BREAKER_MAX_FAILURES) {
        const state = autoFailures.get(session)!
        if (!hasNonMarkerEventsAfter(session, state.openSeq)) {
          return { compacted: false, shadowedSeqs: [] }
        }
      }
      const result = await compactOnce(session, true, undefined, { ...options, reason: options?.reason ?? "auto" })
      if (result.compacted) {
        autoFailures.set(session, { count: 0, openSeq: -1 })
        // M34 ⑦d sticky arm: success that still leaves the surface over the
        // gate → suppress auto re-compaction until new content/manual success.
        const after = safeActiveTokens(session)
        if (after !== undefined && after + overheadNow() >= contextWindow * config.thresholdRatio) {
          stickyFromSeq.set(session, lastEventSeq(session))
        } else {
          stickyFromSeq.delete(session)
        }
      } else {
        const count = failures + 1
        autoFailures.set(session, count >= BREAKER_MAX_FAILURES
          ? { count, openSeq: lastEventSeq(session) }
          : { count, openSeq: -1 })
      }
      return result
    },
    compact: async (session, instructions, options) => {
      if (hasReplacementHistory(session)) return { compacted: false, reason: 'replacement-history-unsupported', shadowedSeqs: [] }
      const result = await compactOnce(session, false, instructions, { ...options, reason: options?.reason ?? "manual" })
      // M34 ⑦d: a MANUAL compaction success shares the until-success reset
      // (breaker close + sticky release) — the only other release condition
      // is new non-marker content on the auto path.
      if (result.compacted) {
        autoFailures.set(session, { count: 0, openSeq: -1 })
        stickyFromSeq.delete(session)
      }
      return result
    },
    recover: (session, options) => hasReplacementHistory(session) ? Promise.resolve({ compacted: false, reason: 'replacement-history-unsupported', shadowedSeqs: [] }) : compactOnce(session, true, undefined, { ...options, reason: "recovery" }),
    resetWindow: reset,
  }
}


// M33 §2.2: per-session consecutive auto-compaction failure counter. `count`
// is the consecutive failures; `openSeq` records the session's last seq when
// the breaker tripped (the pause-release predicate compares against it, so a
// fresh session's PRE-EXISTING history never releases the circuit — only
// content appended AFTER the trip does).
const BREAKER_MAX_FAILURES = 3
const autoFailures = new WeakMap<Session, { count: number; openSeq: number }>()

// M34 ⑦d: per-session sticky state — the seq at which an AUTO success left
// the surface still over the threshold. While set, maybeCompact's auto path
// is suppressed (after a successful compaction that did not resolve
// pressure) until new non-marker events arrive past this seq or a manual
// compact() succeeds. Same predicate as the re-fire guard — the difference
// is that sticky also covers success paths without a `compaction/end`
// (prune-only) where the re-fire guard alone would re-fire immediately.
const stickyFromSeq = new WeakMap<Session, number>()

function lastCompactionEndSeq(session: Session): number {
  let last = -1
  for (const ev of session.events) {
    if (ev.type === "compaction/end" && ev.seq !== undefined) last = ev.seq
  }
  return last
}

// M33 §2.1: turn/end events strictly after `seq` — the hysteresis count.
function countTurnEndsAfter(session: Session, seq: number): number {
  let count = 0
  for (const ev of session.events) {
    if (ev.type === "turn/end" && ev.seq !== undefined && ev.seq > seq) count += 1
  }
  return count
}

function lastEventSeq(session: Session): number {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const seq = session.events[i]!.seq
    if (seq !== undefined) return seq
  }
  return -1
}

function hasNonMarkerEventsAfter(session: Session, seq: number): boolean {
  for (const ev of session.events) {
    if (ev.seq === undefined || ev.seq <= seq) continue
    if (ev.type === "compaction/start" || ev.type === "compaction/end" || ev.type === "compaction/summary" || ev.type === "compaction/reset" || ev.type === "compaction/prune") continue
    return true
  }
  return false
}
