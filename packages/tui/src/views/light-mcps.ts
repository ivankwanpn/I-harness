// @i-harness/tui — G2 (M46a): /mcps light panel — MCP server rows.
// Backend surface: the mcp-client mounts per-server supervisors from plugin
// runtime inputs (mcpServerConfigs) — THERE IS NO AGGREGATED status registry
// (verified: no mcpClient.status() in @i-harness/mcp-client). The honest v1
// lists the CONFIGURED servers; live per-supervisor state is host-mount
// territory (the session assembles them — the panel reports the config the
// session has, not a fabricated online/offline verdict).

import type { LightPanelRow } from "./light-panel.ts"

export interface McpServerBrief {
  /** serverName as configured (the mcpServerConfigs key). */
  name: string
  /** "stdio" | "streamable-http" | unknown — from the config shape. */
  transport: string
}

export const MCPS_EMPTY = "  no MCP servers configured for this session"

export function mcpsRows(servers: McpServerBrief[]): LightPanelRow[] {
  if (servers.length === 0) {
    return [{ label: MCPS_EMPTY.trim() }]
  }
  return servers.map((s) => ({ label: s.name, detail: s.transport }))
}
