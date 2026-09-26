/* SPDX-License-Identifier: Apache-2.0
 * Adapted from ZCode 3.14.0 DesktopWindowControls.tsx.
 * Modified: props replace platform services; native buttons and generic maximize/restore label.
 */
import { Minus, Square, X } from "lucide-react"
export function WindowControls({ labels, onAction }: {
  labels: { minimize: string; maximize: string; close: string };
  onAction(action: "minimize" | "toggle-maximize" | "close"): void
}) {
  const items = [
    { id: "minimize", label: labels.minimize, action: "minimize", Icon: Minus },
    { id: "maximize", label: labels.maximize, action: "toggle-maximize", Icon: Square },
    { id: "close", label: labels.close, action: "close", Icon: X },
  ] as const
  return <div className="zc-window-controls flex shrink-0 items-center gap-0.5 [app-region:no-drag]">
    {items.map(({ id, label, action, Icon }) => <button key={id} type="button" className={`zc-window-button text-foreground [app-region:no-drag] ${id === "close" ? "zc-window-close" : "hover:bg-hover"}`} aria-label={label} title={label} onClick={() => onAction(action)}><Icon className="size-4" /></button>)}
  </div>
}
