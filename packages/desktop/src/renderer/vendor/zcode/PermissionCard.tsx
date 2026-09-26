/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 packages/ui/src/PermissionDialog.tsx.
 * Modified 2026-09-26: extracted prop-only UI, native radios, explicit confirm.
 * Attribution and original notices: packages/desktop/licenses/zcode/.
 */
import { Info } from "lucide-react"
import type { ReactNode } from "react"

export function PermissionCard({ requestId, title, preview, options, selectedId, responding, hint, confirmLabel, onSelect, onConfirm }: {
  requestId: string; title: string; preview: ReactNode;
  options: { id: string; label: string; description: string }[];
  selectedId: string; responding: boolean; hint: string; confirmLabel: string;
  onSelect(id: string): void; onConfirm(): void
}) {
  return (
    <div className="zc-permission w-full shrink-0 relative z-1">
      <form onSubmit={(event) => { event.preventDefault(); if (!responding) onConfirm() }} className="w-full overflow-hidden rounded-2xl border border-border bg-popover shadow-xs">
        <div className="flex flex-col gap-3 p-3">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-ui-base font-medium leading-tight text-foreground-subtle">{title}</p>
            </div>
            {preview}
          </div>
          <div className="space-y-1">
            <div role="radiogroup" aria-label={title} className="space-y-1">
              {options.map((option, index) => {
                const isSelected = option.id === selectedId
                return (
                  <label key={option.id} className={`zc-permission-option flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none transition-colors ${isSelected ? "bg-selected" : "hover:bg-hover"}`}>
                    <input type="radio" name={`permission-${requestId}`} value={option.id} checked={isSelected} disabled={responding} onChange={() => onSelect(option.id)} />
                    <span aria-hidden="true" className={`w-5 shrink-0 text-ui-base font-medium self-center ${isSelected ? "text-foreground" : "text-foreground-subtlest"}`}>{index + 1}.</span>
                    <span className="min-w-0 flex flex-1 flex-col">
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="text-ui-base font-medium text-foreground">{option.label}</span>
                        <span className="text-ui-base leading-4 text-foreground-subtle">{option.description}</span>
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="flex gap-2 text-ui-base items-center text-foreground-subtle"><Info className="text-foreground size-4 shrink-0" />{hint}</p>
            <button type="submit" disabled={responding} className="zc-confirm inline-flex items-center justify-center h-8 rounded-lg px-2.5 text-ui-base bg-brand text-foreground-inverse hover:bg-brand/80">{confirmLabel}</button>
          </div>
        </div>
      </form>
    </div>
  )
}
