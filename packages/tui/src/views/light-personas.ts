// @i-harness/tui — G2 (M46a): /personas light panel. The backend has NO
// persona catalog (verified: @i-harness/preset exports parsePreset/mountPreset
// only — a preset is config-time (JSON text), there is no list/registry);
// grok's personas list has no i-harness equivalent. The honest v1:
// /personas shows the built-in role table (shared with /config-agents — the
// subagent role registry IS the real in-session persona set) — the mapper
// takes SubagentRole-ish rows and the panel notes the distinction.

import type { LightPanelRow } from "./light-panel.ts"

export interface PersonaBrief {
  name: string
  description: string
}

export const PERSONAS_EMPTY = "  no personas (presets are config-time — M46b)"

export function personaRows(personas: PersonaBrief[]): LightPanelRow[] {
  if (personas.length === 0) {
    return [{ label: PERSONAS_EMPTY.trim() }]
  }
  return personas.map((p) => ({ label: p.name, detail: p.description.slice(0, 16) }))
}
