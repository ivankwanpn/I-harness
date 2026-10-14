import type { Session, SessionEvent } from "@i-harness/core-session"
import { deriveSearchText, derivePruneSubstitutes, renderPruneSubstitute, rewindCuts, type PruneRecord } from "@i-harness/core-session"

/** Mirror the additive shadow/rewind fold; raw source events remain untouched. */
export function activeEvents(session: Session): SessionEvent[] {
  const hidden = new Set<number>()
  for (const event of session.events) {
    if (event.type === "compaction/summary") for (const seq of event.shadowedSeqs) hidden.add(seq)
    else if (event.type === "compaction/reset") for (const seq of event.removedSeqs ?? []) hidden.add(seq)
  }
  const cuts = rewindCuts(session)
  return session.events.filter(event => event.seq === undefined || !hidden.has(event.seq) && !cuts.some(cut => event.seq! >= cut.cutFrom && event.seq! < cut.markerSeq))
}

export function activeSummary(session: Session) {
  return activeEvents(session).findLast(event => event.type === "compaction/summary") as Extract<SessionEvent, { type: "compaction/summary" }> | undefined
}

export function renderShadowed(session: Session, shadowedSeqs: number[], pruneRecords: PruneRecord[] = []): string {
  const set = new Set(shadowedSeqs)
  // M33: summary-input substitution — the shadow region's pruned results are
  // rendered as substitutes so the summarizer never pays for the removed
  // middle (design 裁定 ①).
  const prunedByCall = derivePruneSubstitutes(session)
  for (const record of pruneRecords) prunedByCall.set(record.callId, record)
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
