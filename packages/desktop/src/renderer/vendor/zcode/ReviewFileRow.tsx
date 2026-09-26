/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 GitPaneChangeCard.tsx (file header presentation).
 * Modified: prop-only path/status, no invented line counts, no Git mutations.
 */
import { ChevronRight, FileText } from "lucide-react"

export function ReviewFileRow({ path, status, selected, disabled, onSelect }: {
  path: string; status: string; selected: boolean; disabled: boolean; onSelect(): void
}) {
  const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  const name = path.slice(split + 1)
  const directory = split < 0 ? "" : path.slice(0, split)
  return <button type="button" aria-label={`${path} · ${status}`} aria-current={selected ? "true" : undefined}
    disabled={disabled} title={path} onClick={onSelect}
    className={`zc-review-file flex h-8 w-full items-center gap-3 bg-background px-3 text-left transition-colors hover:bg-hover ${selected ? "bg-selected" : ""}`}>
    <div className="min-w-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <FileText className="size-4 shrink-0 text-foreground-subtle" />
        <span className="truncate text-ui-base text-foreground">{name}</span>
        {directory ? <span className="truncate text-ui-base text-foreground-subtlest">{directory}</span> : null}
      </div>
    </div>
    <div className="flex shrink-0 items-center justify-end gap-3 pl-3">
      <span className="shrink-0 whitespace-nowrap text-ui-base text-foreground-subtle">{status}</span>
      <ChevronRight className="size-4 shrink-0 text-foreground-subtle" />
    </div>
  </button>
}
