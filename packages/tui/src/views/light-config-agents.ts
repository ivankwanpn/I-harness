// @i-harness/tui — G2 (M46a): /config-agents light panel — the subagent role
// table (builtinRoles() - names + descriptions + tool counts). Real registry
// data (createRoleRegistry/builtinRoles), read-only listing (the editing
// surface is v2 per spec).

import type { SubagentRole } from "@i-harness/subagent"
import type { LightPanelRow } from "./light-panel.ts"

export const CONFIG_AGENTS_EMPTY = "  no subagent roles registered"

export function configAgentRows(roles: SubagentRole[]): LightPanelRow[] {
  if (roles.length === 0) {
    return [{ label: CONFIG_AGENTS_EMPTY.trim() }]
  }
  return roles.map((r) => ({ label: r.name, detail: `${r.tools.length} tools` }))
}
