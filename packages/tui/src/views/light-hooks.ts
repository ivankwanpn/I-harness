// @i-harness/tui — G2 (M46a): /hooks light panel — 9-event map + per-handler
// trust hash. Data = LoadedHandler[] from @i-harness/hooks (loadHooksConfig +
// verifyHandlerTrust verdicts — the sha256 per configured handler).

import type { LoadedHandler } from "@i-harness/hooks"
import type { LightPanelRow } from "./light-panel.ts"

export const HOOKS_EMPTY = "  no hooks.json handlers (~/.i-harness/hooks.json)"

/** LoadedHandler[] → rows: one header per event name (the 9-event map), then
 * `id` rows with the per-handler hash prefix + trust verdict. */
export function hooksRows(handlers: LoadedHandler[], events: readonly string[]): LightPanelRow[] {
  if (handlers.length === 0) {
    return [{ label: HOOKS_EMPTY.trim() }]
  }
  const out: LightPanelRow[] = []
  for (const event of events) {
    const mine = handlers.filter((h) => h.spec.event === event)
    out.push({ label: event, detail: String(mine.length), header: true })
    for (const h of mine.slice(0, 24)) {
      const hash = h.spec.trust.sha256.slice(0, 8)
      const verdict = h.valid === false ? "invalid" : h.trustError !== undefined ? "untrusted" : "ok"
      out.push({ label: h.spec.id, detail: `${hash} · ${verdict}` })
    }
  }
  return out
}
