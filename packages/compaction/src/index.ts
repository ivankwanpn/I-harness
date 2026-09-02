import type { Session, SessionEvent } from "@i-harness/core-session"
import { append, deriveSearchText, renderPruneSubstitute, type PruneRecord } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import type { ProviderProfile } from "@i-harness/provider"
import { resolveConfig, resolveContextWindow, type CompactionConfig, type ResolvedPruneConfig } from "./config.ts"
import { activeTokens } from "./tokens.ts"
import { selectShadowableRange } from "./region.ts"
import { summarizeWithModel } from "./summarizer.ts"

export { approxTokens, activeTokens, IMAGE_TOKEN_ESTIMATE } from "./tokens.ts"
export { selectShadowableRange } from "./region.ts"
export { resolveConfig, resolveContextWindow } from "./config.ts"
export type { CompactionConfig, PruneConfig, ResolvedCompactionConfig, ResolvedPruneConfig } from "./config.ts"

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
}

export interface CompactionEngine {
  maybeCompact(session: Session): Promise<CompactionResult>
  compact(session: Session): Promise<CompactionResult>
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
}): CompactionEngine {
  const config = resolveConfig(deps.config)
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
  ): Promise<CompactionResult> {
    const shadowedSeqs = selectShadowableRange(session, config.retainTokens)
    if (shadowedSeqs.length === 0) return { compacted: false, shadowedSeqs: [] }
    const pruneRecords = planPrune(session, config.prune)
    if (allowPruneOnly && pruneRecords.length > 0) {
      const after = surfaceTokensAfterPrune(session, pruneRecords)
      if (after < contextWindow * config.thresholdRatio) {
        append(session, { type: "compaction/prune", version: 1, pruned: pruneRecords })
        return { compacted: true, shadowedSeqs: [], pruned: true }
      }
    }
    const replayText = renderShadowed(session, shadowedSeqs, pruneRecords)
    const model = config.summarizationModel ?? deps.model
    let summary: string
    try {
      summary = await summarizeWithModel(model, replayText, config.maxTokens)
    } catch (err) {
      // Fail-soft: never block the agent on a summarizer failure. The warning
      // makes the otherwise-silent retry observable under sustained pressure.
      console.warn("[i-harness] compaction summarizer failed (fail-soft, retrying next step):", err instanceof Error ? err.message : String(err))
      return { compacted: false, shadowedSeqs: [] }
    }
    if (pruneRecords.length > 0) append(session, { type: "compaction/prune", version: 1, pruned: pruneRecords })
    append(session, { type: "compaction/start" })
    append(session, { type: "compaction/summary", text: summary, shadowedSeqs })
    append(session, { type: "compaction/end" })
    return { compacted: true, shadowedSeqs, summary, ...(pruneRecords.length > 0 ? { pruned: true } : {}) }
  }

  return {
    async maybeCompact(session: Session): Promise<CompactionResult> {
      if (activeTokens(session) < contextWindow * config.thresholdRatio) {
        return { compacted: false, shadowedSeqs: [] }
      }
      // Re-fire guard: with `retainTokens 0` and a large `maxTokens`, the
      // summary alone can re-cross the threshold, re-triggering the summarizer
      // (and re-rendering the whole non-marker log) at every step boundary.
      // Only re-compact once NEW non-marker events appear past the last
      // `compaction/end`. `compact()` (explicit) stays ungated.
      const last = lastCompactionEndSeq(session)
      if (last >= 0 && !hasNonMarkerEventsAfter(session, last)) {
        return { compacted: false, shadowedSeqs: [] } // no new work since the last compaction
      }
      return compactOnce(session, true)
    },
    compact: (session) => compactOnce(session, false),
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
  const keepSeqs = new Set(
    session.events.slice(-retainLast).map((e) => e.seq).filter((s): s is number => s !== undefined),
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

function lastCompactionEndSeq(session: Session): number {
  let last = -1
  for (const ev of session.events) {
    if (ev.type === "compaction/end" && ev.seq !== undefined) last = ev.seq
  }
  return last
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
