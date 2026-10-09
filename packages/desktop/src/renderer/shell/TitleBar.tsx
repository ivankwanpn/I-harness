import { useEffect, useRef, useState, type ReactNode } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import { WindowControls } from "../vendor/zcode/WindowControls.tsx"
export function TitleBar({ bridge, title = "I-harness", leading, children }: { bridge: DesktopBridge; title?: string; leading?: ReactNode; children?: ReactNode }) {
  const t = useText()
  const [error, setError] = useState<string>()
  const [maximized, setMaximized] = useState<boolean>()
  const live = useRef<{ active: boolean; stateVersion: number; controlVersion: number }>(undefined)
  // Subscription order and initial-read protection adapted from ZCode 3.14.0
  // DesktopWindowControls.tsx (Apache-2.0). See vendor/zcode/WINDOW_CONTROLS_SOURCES.md.
  useEffect(() => {
    const scope = { active: true, stateVersion: 0, controlVersion: 0 }
    live.current = scope
    setMaximized(undefined)
    setError(undefined)
    const initialVersion = scope.stateVersion
    const unsubscribe = bridge.onEvent((event) => {
      if (!scope.active || event.kind !== "window/state" || typeof event.maximized !== "boolean") return
      scope.stateVersion++
      setMaximized(event.maximized)
    })
    void bridge.request({ kind: "window/state" }).then((reply) => {
      if (!scope.active || scope.stateVersion !== initialVersion) return
      const actual = actualMaximized(reply)
      if (actual !== undefined) setMaximized(actual)
    }).catch(() => { /* Older native bridges may not expose an initial state query. */ })
    return () => { scope.active = false; unsubscribe() }
  }, [bridge])
  function control(action: "minimize" | "toggle-maximize" | "close") {
    const scope = live.current
    if (!scope?.active) return
    setError(undefined)
    const controlVersion = ++scope.controlVersion
    const stateVersion = ++scope.stateVersion
    void bridge.request({ kind: "window/control", action }).then((reply) => {
      if (!scope.active || scope.stateVersion !== stateVersion) return
      const actual = actualMaximized(reply)
      if (actual !== undefined) setMaximized(actual)
    }).catch((reason: unknown) => {
      if (scope.active && scope.controlVersion === controlVersion) setError(String(reason))
    })
  }
  return <header className="session-header desktop-titlebar" data-testid="session-header">
    {leading}
    <span className="desktop-drag-title header-title" title={title} onDoubleClick={() => control("toggle-maximize")}>{title}</span>
    <div className="desktop-header-actions">{children}</div>
    {error ? <span className="native-error" role="alert">{error}</span> : null}
    <WindowControls maximized={maximized} labels={{ minimize: t("最小化視窗"), maximize: t(maximized === undefined ? "最大化或還原視窗" : maximized ? "還原視窗" : "最大化視窗"), close: t("關閉視窗") }} onAction={control} />
  </header>
}

function actualMaximized(value: unknown): boolean | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const maximized = (value as { maximized?: unknown }).maximized
  return typeof maximized === "boolean" ? maximized : undefined
}
