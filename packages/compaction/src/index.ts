import type { Session, SessionEvent } from "@i-harness/core-session"
import { append, deriveMessagesUpTo, deriveSearchText, renderPruneSubstitute, type PruneRecord } from "@i-harness/core-session"
import type { LLMMessage, ModelClient, ToolSchema } from "@i-harness/llm-seam"
import type { ProviderProfile } from "@i-harness/provider"
import type { Telemetry } from "@i-harness/telemetry"
import { diagnosticsFor } from "@i-harness/diagnostics"
import { resolveCompactSpec, resolveContextWindow, type CompactionConfig, type ResolvedPruneConfig } from "./config.ts"
import { activeTokens } from "./tokens.ts"
import { selectShadowableRange, walkOffToolEvents } from "./region.ts"
import { summarizeWithModel } from "./summarizer.ts"

// W6 T6: ONE module-scope handle for this file's one report, phase `turn`:
// auto-compaction happens at a turn's step boundary (the summary is what the
// NEXT step sees). With nothing installed the handle delegates to console.warn
// verbatim (one argument) — unset mode is the pre-migration bytes.
const d = diagnosticsFor("turn")

export { approxTokens, activeTokens, IMAGE_TOKEN_ESTIMATE } from "./tokens.ts"
export { selectShadowableRange } from "./region.ts"
export { resolveConfig, resolveCompactSpec, resolveContextWindow } from "./config.ts"
export type { CompactionConfig, CompactionRequest, ModelCompactionPolicy, PruneConfig, ResolvedCompactionConfig, ResolvedPruneConfig } from "./config.ts"

export interface CompactionResult {
  compacted: boolean
  // For compact(): the seqs shadowed behind the appended summary. For a pure
  // reset (reset:true): the removedSeqs recorded on the compaction/reset
  // marker (identical shadow semantics — deriveMessages hides them). For a
  // prune-only pass (pruned:true): nothing was shadowed → [].
  shadowedSeqs: number[]
  summary?: string
  reset?: boolean // M20: true only for a pure resetWindow (no summary)
  // M33: true when a `compaction/prune` marker was appended in this pass (the
  // model surface / summarizer input now carries substitutes). A prune-only
  // pass also reports `compacted:true` (pressure resolved without an LLM call).
  pruned?: boolean
  /** M73: WHY a pass that did not compact did not. `compacted:false` has EIGHT
   * producers at this revision — compactOnce's no-shadowable-region arm and
   * its summarizer failure, maybeCompact's five gates (pressure, sticky,
   * re-fire, hysteresis, breaker), and resetWindow's `reset: false` — and
   * before this field they were indistinguishable to every consumer: the CLI
   * reported the summarizer's failure as "nothing to compact". Only the
   * summarizer failure names a reason, because it is the only arm that can be
   * a real FAILURE; the other seven mean "nothing to do" and stay absent
   * (pre-M73 behavior, unchanged). */
  reason?: "summarizer-failed"
}

export interface CompactionEngine {
  maybeCompact(session: Session): Promise<CompactionResult>
  // M33 §5: `instructions` is the manual session-compact surface — threaded
  // into the summarizer prompt as a "User instructions" section. Optional and
  // additive: absent → pre-M33 behavior; the auto path never passes one.
  compact(session: Session, instructions?: string): Promise<CompactionResult>
  // M20 (absorbs codex token-budget `start_new_context_window`): new context
  // window — hide everything except the last `retainLast` events, appending a
  // `compaction/reset` marker, NO summary. Used when compact (summary) fails
  // or cannot bring the session back under budget. Pure-reset is more reliable
  // than summarization at the hard cap: the model cannot read a full context
  // it has already overflowed.
  // FIX ROUND 1 (Ruling 4): append-only — no truncation; the marker records
  // `removedSeqs` and deriveMessages shadows them (M11 shadow mechanism), so
  // the durable log and in-memory truth stay identical across resume.
  resetWindow(session: Session, retainLast: number): Promise<CompactionResult>
}

export function createCompactionEngine(deps: {
  model: ModelClient
  config: CompactionConfig
  profile?: ProviderProfile // M15: optional context catalog
  modelId?: string          // M15: the resolved model id for catalog lookup
  provider?: string         // M34 ⑦a: the policy-key provider namespace ("provider/model")
  telemetry?: Telemetry     // M34 ⑦b: optional host stream (M25 convention — absent = zero events)
  /** M5/D2: the shape the main loop sends, read AT COMPACT TIME rather than
   * whatever was true at construction. Present → the summarizer replays the
   * region as REAL messages, so its request is a LEADING SLICE of the fold the
   * main path would send at that moment, byte for byte up to the region's
   * block-aligned cut. M78 holds that identity across a prune, and it is the
   * POST-MARKER fold that the prefix matches: the `compaction/prune` marker is
   * on the log before this fold is taken and the seq filter keeps it visible, so
   * prefix and main fold substitute the same old tool output. The move ALONE
   * would break exactly this — the marker lands past the region's cut, and the
   * prefix shows the RAW output where the main fold shows the substitute.
   * Absent → the legacy text form, unchanged: without the shape the bytes cannot
   * match, so there is no reuse to lose.
   *
   * It is NOT a byte-prefix of the LAST SENT main request any more, and the
   * cache side is a trade this unit did not measure — stated, not repaired.
   * Pre-M78, at the moment of the pass, the replayed messages WERE
   * byte-identical to that last request (the marker that changes the fold is
   * appended only after the attempt), so the provider's automatic prefix cache
   * could serve them at the cached-read price. Post-M78 the replayed prefix
   * diverges from that cached content at the first newly-pruned output:
   * everything after it is billed at the full rate, while the pruned bytes are
   * not sent at all. Which side wins depends on the cache discount and on where
   * the pruned output sits. */
  requestShape?: () => { systemPrompt: string; tools: ToolSchema[] }
  /** M73: the model's resolved output cap, handed down from core-agent's deps
   * — the layer that resolved it. Absent → the summarizer's request
   * carries no cap (pre-M73 behavior). NOT `config.maxTokens`, which stays the
   * post-hoc character slice of the accepted summary — see summarizeWithModel's
   * `limits` note. */
  maxOutputTokens?: number
}): CompactionEngine {
  // M34 ⑦a: global chain + the per-model policy arm (deps.provider/modelId
  // select the exact "provider/model" entry of config.modelPolicies). No
  // provider/modelId → resolveConfig → pre-M34 behavior exactly.
  const config = resolveCompactSpec(deps.config, deps.provider, deps.modelId)
  // M15: catalog-first (profile.modelContexts[modelId] → profile.contextWindow
  // → config.contextWindow). No profile/modelId → config → M11/M14 behavior.
  const contextWindow = resolveContextWindow(deps.profile, deps.modelId, config)

  // M33 §4: one compact pass. `allowPruneOnly` gates the model-free shortcut —
  // only the AUTO path (maybeCompact) may skip the summarizer when pruning the
  // big results alone brings the VISIBLE surface back under the threshold;
  // explicit compact always summarizes (the caller asked for the shadow, even
  // below pressure — pre-M33 semantics).
  async function compactOnce(
    session: Session,
    allowPruneOnly: boolean,
    instructions?: string,
    reason?: "auto" | "manual",
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
    // R-B2: a CONFIGURED summarization model WINS over `deps.model` — deliberate,
    // not the silent exception this unit exists to remove. `deps.model` is the
    // session assembly's stable model handle (R-B1), so every HANDLE-REACHABLE
    // holder follows a rebind; this one does not, because a rebind must not
    // silently discard the user's explicit summarization choice. Its twin: the
    // guardian's `guardian.model` (reviewer.ts, `deps.model ?? deps.parentModel`)
    // — "configured" names TWO exceptions, never one. Cost, for both, after a
    // rebind: each summary / review keeps billing the configured endpoint.
    // Pinned by "a CONFIGURED summarization model wins over the handle" in
    // packages/session-executor/test/assembly.test.ts — do NOT "fix" this
    // into following the handle.
    const model = config.summarizationModel ?? deps.model
    // M5/D2: replay the region as REAL messages so this call is a byte-prefix of
    // the last main request. Only when the summarizer is the same model — a
    // configured `summarizationModel` has its own cache key, so replaying would
    // buy nothing and cost tokens for nothing. The region is everything the
    // shadow markers name, and it is a prefix of the log by construction, so
    // deriveMessagesUpTo over its last seq is exactly the main path's fold.
    const shape = config.summarizationModel === undefined ? deps.requestShape?.() : undefined
    let prefix: { systemPrompt: string; tools: ToolSchema[]; messages: LLMMessage[] } | undefined
    if (shape !== undefined) {
      let lastShadowed = -1
      for (const seq of shadowedSeqs) if (seq > lastShadowed) lastShadowed = seq
      prefix = { systemPrompt: shape.systemPrompt, tools: shape.tools, messages: deriveMessagesUpTo(session, lastShadowed) }
    }
    // M33 §1.2 anchored: scan the session for the LAST `compaction/summary`
    // before building the prompt. If one exists, its text is injected via
    // `<previous-summary>` and the summarizer is told to UPDATE it — the
    // anchored semantics are prompt-only; the `compaction/summary` event shape
    // is unchanged (each round still appends its own summary event).
    const previousSummary = lastSummaryText(session)
    let attempts = 0
    let summary: string
    // M34 ⑦c: minSummaryChars measured inside summarizeWithModel (one
    // same-model retry); the tracker carries the real model-call count for
    // the analytics event even when the pass throws (degenerate retry).
    const attemptsTracker = { count: 0 }
    try {
      // M73: the 9th argument is the request's OWN budget — both halves spread
      // conditionally, so "absent" stays absent at every hop (a default here
      // would be a number nobody chose). `config.maxTokens` keeps its position
      // as the 3rd argument: it is still only the post-hoc character slice.
      // The CAP follows the SHAPE's gate (`summarizationModel === undefined`
      // above): a configured summarization model is a different endpoint, so
      // `deps.maxOutputTokens` — the session model's resolved cap — was never
      // resolved for the one receiving this request. The guardian's twin says
      // what to do with it (reviewer.ts: "a wrong number … is worse than an
      // absent one").
      const result = await summarizeWithModel(model, replayText, config.maxTokens, previousSummary, instructions, config.minSummaryChars, attemptsTracker, prefix, {
        ...(config.summarizationModel === undefined && deps.maxOutputTokens !== undefined ? { maxOutputTokens: deps.maxOutputTokens } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        // The host-known charge the session log does not carry — the SAME one
        // the session's own clamp adds to its input price (core-agent:
        // `estimateContent(messages) + overheadTokens`). The summarizer's
        // request carries the system prompt and tool schemas too. Resolved
        // (default 0), so it is passed as a value, not as a spread.
        overheadTokens: config.overheadTokens,
      },
      // M75: and the region itself, RAW — the summarizer slices it for itself
      // when the single request cannot fit the window. Pre-slicing here would
      // move the fit predicate to this side of the seam, where the clamp's own
      // arithmetic (which prices the directive and the overhead too) is not.
      { session, shadowedSeqs })
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

  return {
    async maybeCompact(session: Session): Promise<CompactionResult> {
      // M33 §3.1: the host-known charge the session log does not carry
      // (system prompt + tool schemas — CompactionConfig.overheadTokens).
      if (activeTokens(session) + config.overheadTokens < contextWindow * config.thresholdRatio) {
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
      const result = await compactOnce(session, true, undefined, "auto")
      if (result.compacted) {
        autoFailures.set(session, { count: 0, openSeq: -1 })
        // M34 ⑦d sticky arm: success that still leaves the surface over the
        // gate → suppress auto re-compaction until new content/manual success.
        const after = safeActiveTokens(session)
        if (after !== undefined && after + config.overheadTokens >= contextWindow * config.thresholdRatio) {
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
    compact: async (session, instructions) => {
      const result = await compactOnce(session, false, instructions, "manual")
      // M34 ⑦d: a MANUAL compaction success shares the until-success reset
      // (breaker close + sticky release) — the only other release condition
      // is new non-marker content on the auto path.
      if (result.compacted) {
        autoFailures.set(session, { count: 0, openSeq: -1 })
        stickyFromSeq.delete(session)
      }
      return result
    },
    resetWindow: resetWindowOnce,
  }
}

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
async function resetWindowOnce(session: Session, retainLast: number): Promise<CompactionResult> {
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
  append(session, { type: "compaction/reset", removedSeqs })
  return { compacted: true, shadowedSeqs: removedSeqs, reset: true }
}

// M34 ⑦b: defensive meter read — the token-meter projects through the same
// deriveMessages that has been made defensive for malformed persisted logs,
// but its OWN defensive envelope is not warranted for a host-optional
// analytics feed: any measurement failure degrades to `undefined` (the
// attempt continues; the telemetry token fields stay unset) — never a
// TypeError escaping compaction (Ruling 7 convention).
function safeActiveTokens(session: Session): number | undefined {
  try {
    return activeTokens(session)
  } catch {
    return undefined
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

// M33 §4.2: the prune plan — every tool/result whose stringified output
// exceeds `prune.thresholdChars` becomes a record (head/tail carving aligned
// with the retention caps; `removedBytes` = the byte length of the middle).
// A stringify failure (e.g. a BigInt payload) degrades to "not prunable" —
// fail-soft, it just does not participate in this pass.
function planPrune(session: Session, prune: ResolvedPruneConfig): PruneRecord[] {
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
function surfaceTokensAfterPrune(session: Session, records: PruneRecord[]): number {
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

function renderShadowed(session: Session, shadowedSeqs: number[], pruneRecords: PruneRecord[] = []): string {
  const set = new Set(shadowedSeqs)
  // M33: summary-input substitution — the shadow region's pruned results are
  // rendered as substitutes so the summarizer never pays for the removed
  // middle (design 裁定 ①).
  const prunedByCall = new Map(pruneRecords.map((record) => [record.callId, record]))
  const parts: string[] = []
  for (const ev of session.events) {
    if (ev.seq !== undefined && set.has(ev.seq)) {
      const prunedRecord = ev.type === "tool/result" ? prunedByCall.get(ev.callId) : undefined
      // M33 (design 裁定 ①): a pruned tool/result renders as its substitute in
      // the summary input — the summarizer must not pay for the cut middle.
      // NOTE: this replaces the M20 image-descriptor union for that event —
      // the raw bytes stay durably in the log; the narrowed input drops them
      // along with the rest of the output (v0 carve; image-aware summarize is
      // still deferred).
      if (prunedRecord !== undefined) {
        parts.push(renderPruneSubstitute(prunedRecord))
        continue
      }
      // M20 image-aware replay: events carrying images are replayed with a
      // descriptor so the summary records WHICH visuals were in context. The
      // real byte-level replay needs a multimodal summarizer + store ref
      // (deferred); this is the descriptor path.
      // FINAL REVIEW (Ruling 8b): UNION, not replace. Pre-M20 an image-bearing
      // event replayed as its surrounding text + image info; a replace-only
      // descriptor path silently dropped that prose from the summarizer input.
      // Replay `descriptor\n<derived search text>`; no-image events keep the
      // exact previous behavior (desc === undefined → fallback unchanged,
      // byte-identical for text-only sessions).
      const desc = imageDescriptor(ev)
      // Ruling 7 kept intact under the 8b union: `deriveSearchText` re-derives
      // core-session's OWN text contribution — including its legacy FTS image
      // descriptor, which assumes well-formed ImageInput fields
      // (`dataBase64.slice`). A malformed persisted shape must degrade to "no
      // derived text" instead of escaping compaction (renderShadowed runs
      // outside compact()'s fail-soft try); the descriptor above still records
      // the visual. Well-formed events take the exact same path as before.
      let base = ""
      try {
        base = deriveSearchText(ev)
      } catch {
        base = ""
      }
      const t = desc ? `${desc}\n${base}` : base
      if (t.length > 0) parts.push(t)
    }
  }
  return parts.join("\n")
}

// M20 Task 8 (+ Fix Round 1, Rulings 6+7): render shadowed events' images as
// compact descriptors, e.g. `[image: image/png, 6 bytes]` — mediaType keeps
// its full IANA form (no `image/` strip) and bytes are the decoded count,
// core-session's convention (src/index.ts:138/277):
// Math.ceil(dataBase64.length * 3 / 4). Returns undefined when the event
// carries no usable `images` array (including malformed persisted shapes),
// so the caller falls back to the unchanged `deriveSearchText` replay.
// Malformed per-image fields degrade to `unknown` / `?` placeholders instead
// of throwing: renderShadowed runs OUTSIDE compact()'s fail-soft try, so a
// TypeError here would escape compaction entirely (Ruling 7).
// M33 §1.2: the text of the LAST `compaction/summary` event, if any.
// Defensive `typeof` guard: persisted logs bypass append validation, so a
// malformed marker must not break the anchored scan (falls back to fresh).
function lastSummaryText(session: Session): string | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const ev = session.events[i]
    if (ev && ev.type === "compaction/summary") return typeof ev.text === "string" ? ev.text : undefined
  }
  return undefined
}

function imageDescriptor(ev: SessionEvent): string | undefined {
  // FINAL REVIEW (Ruling 8b): the probe covers BOTH image locations —
  // user-message images live at the top level (`event.images`), while
  // tool-result images ride inside the opaque output payload (`output.images`,
  // the same shape deriveMessages probes). Probing only the top level made a
  // tool/result fall through to the legacy FTS descriptor line, leaving two
  // descriptor styles in one replay. Malformed persisted shapes (non-array /
  // empty at both locations) still degrade to `undefined` → plain
  // `deriveSearchText` replay (Ruling 7 guards intact).
  const direct = (ev as { images?: unknown }).images
  const nested = ev.type === "tool/result"
    ? (ev as { output?: { images?: unknown } }).output?.images
    : undefined
  const images = Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : undefined
  if (!Array.isArray(images) || images.length === 0) return undefined
  const parts = (images as unknown[]).map((raw): string => {
    const img = typeof raw === "object" && raw !== null ? (raw as { mediaType?: unknown; dataBase64?: unknown }) : undefined
    const mediaType = img?.mediaType
    const dataBase64 = img?.dataBase64
    const label = typeof mediaType === "string" ? mediaType : "unknown"
    const bytes = typeof dataBase64 === "string" ? Math.ceil((dataBase64.length * 3) / 4) : "?"
    return `[image: ${label}, ${bytes} bytes]`
  })
  return parts.join("\n")
}
