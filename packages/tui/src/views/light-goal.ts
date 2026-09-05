// @i-harness/tui — G2 (M46a): /goal light panel — the current goal from the
// goal event stream (the loop tracks status.goal label; a state/plan detail
// overlay is v2 — the honest v1 shows what the stream delivered).

import type { LightPanelRow } from "./light-panel.ts"

export const GOAL_EMPTY = "  no active goal (waiting for a plan step)"

export function goalRows(label: string | undefined, state?: string): LightPanelRow[] {
  if (label === undefined || label === "") {
    return [{ label: GOAL_EMPTY.trim() }]
  }
  const out: LightPanelRow[] = [{ label: "goal", detail: label }]
  if (state !== undefined && state !== "") out.push({ label: "state", detail: state })
  return out
}
