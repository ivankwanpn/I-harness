import { useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { WindowControls } from "../vendor/zcode/WindowControls.tsx"
export function TitleBar({ bridge }: { bridge: DesktopBridge }) {
  const t = useText()
  const [error, setError] = useState<string>()
  function control(action: "minimize" | "toggle-maximize" | "close") {
    setError(undefined)
    void bridge.request({ kind: "window/control", action }).catch((reason: unknown) => setError(String(reason)))
  }
  return <header className="desktop-titlebar"><span className="desktop-drag-title" onDoubleClick={() => control("toggle-maximize")}>I-harness Desktop</span>
    {error ? <span className="native-error" role="alert">{error}</span> : null}
    <WindowControls labels={{ minimize: t("最小化視窗"), maximize: t("最大化或還原視窗"), close: t("關閉視窗") }} onAction={control} />
  </header>
}
