// @i-harness/tui — G2 (M46a): /session-info light panel — session facts the
// app/backend really know: title, model label, turn count, context usage,
// display lines, session id (the honest runtime one when the backend has no
// canonical store id — embedded sessions are in-process; persisted ids arrive
// with the coordinator wiring M38).

import type { LightPanelRow } from "./light-panel.ts"

export interface SessionInfoProbe {
  id?: string
  title: string
  model: string
  turns: number
  lines: number
  used?: number
  total?: number
}

/** Probe → rows (turns/context from the backend; the panel never fabricates). */
export function sessionInfoRows(info: SessionInfoProbe): LightPanelRow[] {
  const out: LightPanelRow[] = [{ label: "title", detail: info.title }]
  if (info.id !== undefined) out.push({ label: "id", detail: info.id })
  out.push({ label: "model", detail: info.model })
  out.push({ label: "turns", detail: String(info.turns) })
  out.push({ label: "display lines", detail: String(info.lines) })
  if (info.used !== undefined) out.push({ label: "context used", detail: String(info.used) })
  if (info.total !== undefined && info.total > 0) out.push({ label: "context window", detail: String(info.total) })
  return out
}
