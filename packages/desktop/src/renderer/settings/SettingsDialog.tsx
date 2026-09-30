import { useEffect, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"

/** A small Desktop-owned settings dialog. Its caller owns restoring focus to
 * the trigger because that element may move when a successful save reloads a
 * settings list. */
export function SettingsDialog({ title, closeLabel, busy = false, initialFocusSelector, onClose, children }: {
  title: string
  closeLabel: string
  busy?: boolean
  initialFocusSelector: string
  onClose(): void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const background = document.querySelector(".settings-pane")
    const wasInert = background?.hasAttribute("inert") ?? false
    background?.setAttribute("inert", "")
    const frame = requestAnimationFrame(() => {
      const target = dialog.current?.querySelector<HTMLElement>(initialFocusSelector)
        ?? dialog.current?.querySelector<HTMLElement>(".settings-dialog-header button:not(:disabled)")
      target?.focus()
    })
    return () => { cancelAnimationFrame(frame); if (!wasInert) background?.removeAttribute("inert") }
  }, [initialFocusSelector])
  return createPortal(<div className="settings-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={dialog} className="settings-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); if (!busy) onClose(); return }
      if (event.key !== "Tab") return
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])") ?? [])
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus() }
    }}>
      <header className="settings-dialog-header"><h2>{title}</h2><button type="button" aria-label={closeLabel} disabled={busy} onClick={onClose}>×</button></header>
      {children}
    </div>
  </div>, document.body)
}
