import { useState, type ReactNode } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { WindowControls } from "../vendor/zcode/WindowControls.tsx"
export function TitleBar({ bridge, title = "I-harness Desktop", leading, children }: { bridge: DesktopBridge; title?: string; leading?: ReactNode; children?: ReactNode }) {
  const t = useText()
  const [error, setError] = useState<string>()
  function control(action: "minimize" | "toggle-maximize" | "close") {
    setError(undefined)
    void bridge.request({ kind: "window/control", action }).catch((reason: unknown) => setError(String(reason)))
  }
  return <header className="session-header desktop-titlebar" data-testid="session-header">
    {leading}
    <span className="desktop-drag-title header-title" title={title} onDoubleClick={() => control("toggle-maximize")}>{title}</span>
    <div className="desktop-header-actions">{children}</div>
    {error ? <span className="native-error" role="alert">{error}</span> : null}
    <WindowControls labels={{ minimize: t("最小化視窗"), maximize: t("最大化或還原視窗"), close: t("關閉視窗") }} onAction={control} />
  </header>
}
