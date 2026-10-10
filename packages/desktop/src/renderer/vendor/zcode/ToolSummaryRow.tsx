/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 ToolCallBlocks/ToolSummaryRow.tsx.
 * Modified: native button, prop-only family icon/summary/state, no runtime services.
 */
import type { ReactNode } from "react"
import { ChevronRight, Wrench } from "lucide-react"
import "../../session/tool-output.css"

export function ToolSummaryRow({ name, title, summary, icon, state, status, expanded, label, onToggle }: {
  name: string; title?: string; summary?: string; icon?: ReactNode; state?: string; status: string; expanded: boolean; label: string; onToggle(): void
}) {
  return <button type="button" aria-expanded={expanded} aria-label={label} onClick={onToggle}
    className="zc-tool-summary" title={summary ? `${name} · ${summary}` : name}>
    <span className="tool-summary-icon" aria-hidden="true">{icon ?? <Wrench size={15} />}</span>
    <span className="tool-summary-kind-label">{title ?? name}</span>
    {summary ? <span className="tool-summary-primary">{summary}</span> : null}
    <span className="tool-summary-status" data-state={state}>{status}</span>
    <ChevronRight aria-hidden size={14} className={`tool-summary-chevron ${expanded ? "rotate-90" : "rotate-0"}`} />
  </button>
}
