/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 app-shell/SidePaneTabTrigger.tsx tab presentation.
 * Modified: native buttons with keyboard navigation; no drag/drop or store imports.
 */
import { useRef } from "react"
export function PaneTabs({ id, items, selected, onSelect, label }: {
  id: string; items: { id: string; label: string }[]; selected: string; onSelect(id: string): void; label: string
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  return <div role="tablist" aria-label={label} className="zc-pane-tabs">
    {items.map((item, index) => <button ref={(element) => { buttons.current[index] = element }} key={item.id} type="button" role="tab" id={`${id}-${item.id}`} aria-controls={`${id}-panel`} aria-selected={selected === item.id} tabIndex={selected === item.id ? 0 : -1}
      onClick={() => onSelect(item.id)} onKeyDown={(event) => {
        let next: number
        if (event.key === "ArrowRight") next = (index + 1) % items.length
        else if (event.key === "ArrowLeft") next = (index + items.length - 1) % items.length
        else if (event.key === "Home") next = 0
        else if (event.key === "End") next = items.length - 1
        else return
        event.preventDefault(); onSelect(items[next]!.id); buttons.current[next]?.focus()
      }} className="zc-pane-tab group relative inline-flex items-center gap-1 flex-[1_1_9.75rem] h-7 min-w-15 max-w-39 justify-start overflow-hidden rounded-lg border px-1.5 pr-2 text-ui-base font-medium whitespace-nowrap transition-colors">{item.label}</button>)}
  </div>
}
