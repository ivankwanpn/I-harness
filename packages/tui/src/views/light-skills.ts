// @i-harness/tui — G2 (M46a): /skills light panel — skills registry rows.
// Data = SkillSummary from @i-harness/skills (workspace + global scan).

import type { SkillSummary } from "@i-harness/skills"
import type { LightPanelRow } from "./light-panel.ts"

export const SKILLS_EMPTY = "  no skills found (workspace + ~/.i-harness/skills)"

/** SkillSummary[] → panel rows (name; detail = the honest source flag). */
export function skillsRows(list: SkillSummary[], max = 64): LightPanelRow[] {
  return list.slice(0, max).map((s) => ({ label: s.name, detail: s.source }))
}
