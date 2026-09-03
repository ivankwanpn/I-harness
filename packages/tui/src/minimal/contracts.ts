// @i-harness/tui — minimal-mode shared contracts (M38a).
// G1 (inline engine) implements InlineLiveRegion; G2 (minimal views) consumes
// it. Cross-group imports land HERE only.

import type { StyledRun } from "../contracts.ts"

/** One live-region display line (semantic runs — the resident style vocab). */
export interface RegionLine {
  runs: StyledRun[]
  /** Pinned glyph for this live-region line (e.g. prompt arrow) — drawn by G2. */
  glyph?: string
}

export interface InlineMetrics {
  cols: number
  rows: number
  /** Height of the live region (bottom-anchored). */
  regionRows: number
}

/**
 * The forward (insert_before) engine: owns the live region grid and the
 * terminal scrollback semantics.
 *
 * CONTRACT (the quality red line):
 * - commit() appends `lines` into the NATIVE terminal scrollback and
 *   re-places the live region below it.
 * - Committed content is NEVER rewritten (print-once) — every commit is a
 *   one-time write; observable via the byte-budget ledger.
 * - drawRegion(write) repaints ONLY the region rows.
 */
export interface InlineLiveRegion {
  /** Append committed content above the region (takes semantic lines;
   * G2 resolves them via the ScrollbackEngine pending delta). */
  commit(lines: RegionLine[], write: (bytes: string) => void): void
  /** Repaint the live region (status/prompt rows) — region rows only. */
  drawRegion(write: (bytes: string) => void): void
    /** Resize geometry (grow/shrink) — recomputes internal grid; next
   * drawRegion full-repaints the region. */
  resize(cols: number, rows: number): void
  /** Rows of the live region at the current geometry. */
  regionRows(): number
  /** Transcript of live-region rows (testing mirror). */
  regionLines(): RegionLine[]
  /** M38a harmonization seam (G2→G1): plants the composed live-region
   * content (tail window + todos + status + prompt) for the next
   * drawRegion. Optional — engines may repaint their own commit window. */
  setRegion?(lines: RegionLine[]): void
}
