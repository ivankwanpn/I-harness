/* SPDX-License-Identifier: MIT
 * Dialog composition adapted from OpenCode 1.18.30 V2 and DSH 0.2.0-rc.2.
 * React/native IH modal semantics. See ../design/CONTROL_SOURCES.md.
 */
import { useId, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { Button } from "../vendor/opencode/Button.tsx"
import { useModalLayer } from "../design/useModalLayer.ts"

/** Desktop dialog with shared keyboard ownership and focus restoration. */
export function SettingsDialog({ title, closeLabel, busy = false, active = true, initialFocusSelector, className, onClose, children }: {
  title: string
  closeLabel: string
  busy?: boolean
  active?: boolean
  initialFocusSelector: string
  className?: string
  onClose(): void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const requestClose = useModalLayer(dialog, { initialFocusSelector, busy, active, onClose })
  return createPortal(<div className="settings-dialog-backdrop" hidden={!active} inert={!active} onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>
    <div ref={dialog} className={`settings-dialog${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined} tabIndex={-1}>
      <header className="settings-dialog-header"><h2 id={titleId}>{title}</h2><Button variant="ghost" size="small" className="settings-dialog-close" aria-label={closeLabel} disabled={busy} icon={<X size={16} />} onClick={requestClose} /></header>
      <div className="settings-dialog-content">{children}</div>
    </div>
  </div>, document.body)
}
