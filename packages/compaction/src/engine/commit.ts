import type { Session } from "@i-harness/core-session"
import { append } from "@i-harness/core-session"
import { diagnosticsFor } from "@i-harness/diagnostics"
import type { CompactionResult } from "../index.ts"
import { selectShadowableRange } from "../region.ts"
import { safeActiveTokens } from "../projection/window.ts"
import { renderShadowed } from "../projection/shadowed.ts"
import { planPrune, surfaceTokensAfterPrune } from "./prune.ts"
import { prepareSummary, requestSummary } from "./summary.ts"
import type { SummaryDependencies, CompactSettings } from "./contracts.ts"

// W6 T6: ONE module-scope handle for this file's one report, phase `turn`:
// auto-compaction happens at a turn's step boundary (the summary is what the
// NEXT step sees). With nothing installed the handle delegates to console.warn
// verbatim (one argument) — unset mode is the pre-migration bytes.
const d = diagnosticsFor("turn")


// M33 §4: one compact pass. `allowPruneOnly` gates the model-free shortcut —
// only the AUTO path (maybeCompact) may skip the summarizer when pruning the
// big results alone brings the VISIBLE surface back under the threshold;
// explicit compact always summarizes (the caller asked for the shadow, even
// below pressure — pre-M33 semantics).
export async function runCompactionPass(
  session: Session,
  allowPruneOnly: boolean,
  instructions: string | undefined,
  reason: "auto" | "manual" | undefined,
  config: CompactSettings,
  contextWindow: number,
  deps: SummaryDependencies,
  overheadNow: () => number,
): Promise<CompactionResult> {
  // M34 ⑦b: analytics — one `compaction/attempt` per attempt, emitted at
  // each outcome. tokensBefore is the meter at entry; tokensAfter is the
  // meter once the pass's markers are on the log. The host-optional stream
  // is never REQUIRED by stability (M25 convention: telemetry is additive).
  // Malformed persisted shapes must not crash the attempt (Ruling 7
  // convention): the meter is NOT defensive, so measurement degrades to
  // undefined token fields, never a TypeError out of compact().
  const startedAt = Date.now()
  const tokensBefore = safeActiveTokens(session)
  // M75 §1.6: `attempts` counts MODEL CALLS, not passes. A pass that could
  // not fit the single request now makes one call per chained piece (each
  // with its own M34 retry), so the number is no longer comparable with
  // pre-M75 readings of the same session — one pass still emits exactly ONE
  // `compaction/attempt`, with `attempts` = every call it took.
  const emit = (outcome: "success" | "prune-only" | "failure" | "skipped", extra: Record<string, unknown> = {}) => {
    deps.telemetry?.emit({
      type: "compaction/attempt",
      ts: Date.now(),
      data: { reason, outcome, tokensBefore, durationMs: Date.now() - startedAt, ...extra },
    })
  }
  const shadowedSeqs = selectShadowableRange(session, config.retainTokens)
  if (shadowedSeqs.length === 0) {
    emit("skipped", { attempts: 0 })
    return { compacted: false, shadowedSeqs: [] }
  }
  const pruneRecords = planPrune(session, config.prune)
  if (allowPruneOnly && pruneRecords.length > 0) {
    const after = surfaceTokensAfterPrune(session, pruneRecords)
    if (after < contextWindow * config.thresholdRatio) {
      append(session, { type: "compaction/prune", version: 1, pruned: pruneRecords })
      emit("prune-only", { tokensAfter: safeActiveTokens(session), shadowed: 0, pruned: pruneRecords.length, attempts: 0 })
      return { compacted: true, shadowedSeqs: [], pruned: true }
    }
  }
  // M78 §1.1: the marker lands HERE — after the plan, BEFORE the summarizer's
  // prefix is built — instead of only after the summary succeeded (the pre-M78
  // site, further down this function). Same append, same event shape, one
  // position earlier; the prune-only path above keeps its own append (it
  // returns before any summary is attempted).
  //
  // What the MOVE itself changes, measured (2026-09-24): the prune is on the
  // log from before the summarizer is called, so every whole-log read from that
  // moment on sees it — the measured one is the FAILED pass's surface (pinned
  // by the failure case below), and the prune stays there for good: see the
  // note at the `failure` emission. The success telemetry's `tokensAfter` is
  // NOT one of them: the deleted append already preceded that emit, which reads
  // after the summary trio either way.
  //
  // It does NOT prune the summarizer's PREFIX — the M78 finding, recorded
  // rather than smoothed over. `deriveMessagesUpTo(session, lastShadowed)`
  // folds the log filtered to `seq <= maxSeq` (core-session, that function's
  // filter), and `append` gives every new event the HIGHEST seq (core-session,
  // `append`: `seq: session.events.length`) — so the marker can never be at or
  // below the region's last shadowed seq and is dropped from that fold. Probe
  // on this tree's own fixture (retainTokens 500 and 0 alike): lastShadowed
  // 104 / 109 vs markerSeq 110; `deriveMessages` sees the substitute,
  // `deriveMessagesUpTo` does not, and no placement of this append changes it.
  // The prefix is pruned because that filter keeps `compaction/prune` markers
  // regardless of `maxSeq` (the content-addressed exception there), so do NOT
  // delete that disjunct as redundant: cases 1, 4 and 5 of "M78: the prune
  // marker lands before the summarizer folds the log" (test/prune.test.ts) are
  // red without it, and only it.
  if (pruneRecords.length > 0) append(session, { type: "compaction/prune", version: 1, pruned: pruneRecords })
  const replayText = renderShadowed(session, shadowedSeqs, pruneRecords)
  const prepared = prepareSummary(session, shadowedSeqs, config, deps)
  let attempts = 0
  let summary: string
  // M34 ⑦c: minSummaryChars measured inside summarizeWithModel (one
  // same-model retry); the tracker carries the real model-call count for
  // the analytics event even when the pass throws (degenerate retry).
  const attemptsTracker = { count: 0 }
  try {
    const result = await requestSummary(session, shadowedSeqs, replayText, prepared, config, contextWindow, deps, overheadNow, attemptsTracker, instructions)
    summary = result.text
    attempts = attemptsTracker.count
  } catch (err) {
    // Fail-soft: never block the agent on a summarizer failure. The warning
    // makes the otherwise-silent retry observable under sustained pressure.
    // W6 T6: phase `turn` — the summarizer runs at a turn's step boundary, and
    // the message says so. R13 FOLD: the second argument was already a STRING
    // and the first carries no `%` specifier, so `util.format` joined them with
    // one space — the single template below is that same byte sequence.
    d.warn(`[i-harness] compaction summarizer failed (fail-soft, retrying next step): ${err instanceof Error ? err.message : String(err)}`)
    // M78 §1.1 — the deliberate consequence of moving the marker: a FAILED
    // summary now leaves the prune APPLIED (it was appended above, before the
    // attempt) and nothing can undo it, because the log is append-only. That
    // is a choice, for three reasons: prune is safe (it swaps an old tool
    // output for a substitute, nothing more), it is a net win for the next
    // attempt (the tokens are already saved), and the ladder's next rung
    // retries anyway. The RESULT SHAPE does not follow it: `compacted:false`
    // is what the breaker counts, and a failing summarizer must keep counting
    // as a failure, or the breaker stops protecting the model from being
    // hammered — so no `pruned` field, no `compacted:true`. (An odd
    // combination, named rather than smoothed over: the log changed while the
    // result says the pass failed.) Pinned by "M78: a summarizer failure
    // leaves the prune APPLIED — the log is append-only" in test/prune.test.ts.
    //
    // One more consequence of where the append sits, named rather than fixed:
    // the ladder's next rung RE-PLANS the same records and appends a SECOND
    // `compaction/prune` marker (nothing dedupes against the markers already
    // on the log). That is content-idempotent — the substitute map derived
    // from the markers is last-wins per tool call id, so the projection is
    // unchanged — and the number of repeats is bounded by the breaker on the
    // AUTO path ONLY. The in-tree path that actually retries a failed
    // summarizer is UNGATED instead: core-agent's `enforceBudget` layer 1 calls
    // `compact()` at every step boundary while the surface is over budget, and
    // `compact()` consults no gate — so each such retry re-plans the same
    // records and appends again (this path's only early exit is an empty
    // region, above). The cost a dedupe would buy down: every duplicate
    // re-serialises the whole carve (4096 head + 1024 tail chars — measured on
    // the big-output fixture in test/prune.test.ts, one record's marker JSON is
    // 5 180 bytes), so a summarizer that keeps failing under budget pressure
    // grows the durable log until the ladder's NEXT layer (the reset, or the
    // fail-closed throw) ends the cycle — not the breaker. Deliberately left
    // alone; a dedupe would be a second place that decides what a prune means.
    emit("failure", { attempts: attemptsTracker.count })
    return { compacted: false, shadowedSeqs: [], reason: "summarizer-failed" }
  }
  append(session, { type: "compaction/start" })
  append(session, { type: "compaction/summary", text: summary, shadowedSeqs })
  append(session, { type: "compaction/end" })
  emit("success", { tokensAfter: safeActiveTokens(session), shadowed: shadowedSeqs.length, pruned: pruneRecords.length, attempts })
  return { compacted: true, shadowedSeqs, summary, ...(pruneRecords.length > 0 ? { pruned: true } : {}) }
}
