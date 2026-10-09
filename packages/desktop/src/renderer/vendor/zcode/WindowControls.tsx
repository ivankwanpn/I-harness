/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 DesktopWindowControls.tsx.
 * Modified: IH props replace platform services; actual state selects Lucide
 * maximize/restore glyphs and native buttons. See WINDOW_CONTROLS_SOURCES.md.
 */
import { Copy, Minus, Square, X } from "lucide-react"
export function WindowControls({ labels, maximized, onAction }: {
  labels: { minimize: string; maximize: string; close: string };
  maximized?: boolean;
  onAction(action: "minimize" | "toggle-maximize" | "close"): void
}) {
  const items = [
    { id: "minimize", label: labels.minimize, action: "minimize", Icon: Minus },
    { id: "maximize", label: labels.maximize, action: "toggle-maximize", Icon: maximized === true ? Copy : Square },
    { id: "close", label: labels.close, action: "close", Icon: X },
  ] as const
  return <div className="zc-window-controls flex shrink-0 items-center gap-0.5 [app-region:no-drag]">
    {items.map(({ id, label, action, Icon }) => <button key={id} type="button" className={`zc-window-button text-foreground [app-region:no-drag] ${id === "close" ? "zc-window-close" : "hover:bg-hover"}`} aria-label={label} title={label} data-maximized={id === "maximize" ? maximized : undefined} onClick={() => onAction(action)}><Icon className="size-4" aria-hidden="true" focusable="false" /></button>)}
  </div>
}
