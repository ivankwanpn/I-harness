// @i-harness/tui — G2 (M46a): /jump light panel — turn list (engine turn
// anchors: the display line of each User-prompt block — the picker's data is
// resolved by the loop's lineBlock walk). Selecting a row jumps the viewport
// to that line (the loop's onSelect).

import type { LightPanelRow } from "./light-panel.ts"

export const JUMP_EMPTY = "  no turns recorded"

export interface JumpAnchor {
  /** 0-based user-block display line index (the jump target). */
  line: number
  /** Turn ordinal (1-based → "turn N"). */
  n: number
  /** Prompt text (first line, truncated for the row). */
  text?: string
}

export function jumpRows(anchors: JumpAnchor[]): LightPanelRow[] {
  if (anchors.length === 0) {
    return [{ label: JUMP_EMPTY.trim() }]
  }
  return anchors.map((a) => ({ label: `turn ${a.n}`, detail: (a.text ?? "").slice(0, 24) }))
}
