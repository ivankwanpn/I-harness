/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 ToolCallBlocks/ToolSummaryRow.tsx.
 * Modified: native button, prop-only text and state, no animation/store services.
 */
import { ChevronRight, Terminal } from "lucide-react"

export function ToolSummaryRow({ name, status, expanded, label, onToggle }: {
  name: string; status: string; expanded: boolean; label: string; onToggle(): void
}) {
  return <button type="button" aria-expanded={expanded} aria-label={label} onClick={onToggle}
    className="zc-tool-summary group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors">
    <span className="shrink-0 text-foreground-subtlest"><Terminal className="size-4" /></span>
    <span className="tool-summary-kind-label font-medium whitespace-nowrap shrink-0 text-foreground-subtle">{name}</span>
    <div className="tool-summary-content min-w-0 flex max-w-full items-center gap-2 text-foreground-subtlest">
      <span className="min-w-0 truncate">{status}</span>
    </div>
    <ChevronRight aria-hidden className={`size-4 text-foreground-subtlest shrink-0 transition-transform ${expanded ? "rotate-90" : "rotate-0"}`} />
  </button>
}
