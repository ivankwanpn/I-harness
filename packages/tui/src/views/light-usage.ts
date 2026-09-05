// @i-harness/tui — G2 (M46a): /usage light panel — the token meter (context
// used/total from BackendClient.context + remaining/percentage — the
// get_context_remaining projection: used = activeTokens(deriveMessages),
// total = the context window; remaining = total - used when both known).

import type { LightPanelRow } from "./light-panel.ts"

export const USAGE_EMPTY = "  no context usage available (backend probe absent)"

export interface UsageProbe {
  used: number
  total?: number
}

/** UsageProbe → rows: used, total (when known), remaining + % (when known). */
export function usageRows(u: UsageProbe): LightPanelRow[] {
  const out: LightPanelRow[] = [
    { label: "context used", detail: String(u.used) },
  ]
  if (u.total !== undefined && u.total > 0) {
    out.push({ label: "context window", detail: String(u.total) })
    out.push({ label: "context remaining", detail: String(Math.max(0, u.total - u.used)) })
    const pct = Math.round((Math.max(0, u.total - u.used) / u.total) * 100)
    out.push({ label: "remaining", detail: `${pct}%` })
  }
  return out
}
