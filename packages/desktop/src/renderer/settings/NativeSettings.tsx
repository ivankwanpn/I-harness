import { useEffect, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale, useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import type { TerminalShellChoice } from "../../shared/bridge.ts"
type NativeState = { notifications: boolean; notificationsSupported: boolean; terminalShell?: TerminalShellChoice }
type ShellOption = { id: TerminalShellChoice; label: string }
export function NativeSettings({ bridge, section = "all", workspaceId }: { bridge: DesktopBridge; section?: "all" | "window" | "notifications"; workspaceId?: string }) {
  const t = useText()
  const locale = useLocale((state) => state.locale)
  const [value, setValue] = useState<NativeState>()
  const [shells, setShells] = useState<ShellOption[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void bridge.request({ kind: "desktop/local/state" }).then((result) => {
      if (!active) return
      if (!result || typeof (result as { notifications?: unknown }).notifications !== "boolean") throw new Error("Native preferences unavailable")
      setValue(result as NativeState)
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge])
  useEffect(() => {
    if (!workspaceId || section === "notifications") return
    let active = true
    void bridge.request({ kind: "desktop/terminal/options", workspaceId }).then((result) => {
      if (active) setShells(result as ShellOption[])
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge, section, workspaceId])
  const selectedShell = value?.terminalShell ?? "auto"
  const visibleShells = shells.some((option) => option.id === selectedShell)
    ? shells
    : [...shells, { id: selectedShell, label: t("已選擇的 Shell 目前不可用") }]
  return <>{section === "all" ? <h2>{t("視窗與通知")}</h2> : null}<SettingsGroup>
    {section !== "window" ? <SettingsRow label={t("背景待處理通知")} description={t(value?.notificationsSupported === false ? "此系統不支援桌面通知。" : "視窗不在前景時，有審批或問題需要處理便通知。")}
      control={<input type="checkbox" aria-label={t("背景待處理通知")} checked={value?.notifications === true} disabled={busy || !value?.notificationsSupported} onChange={(event) => {
        setBusy(true); setError(undefined)
        void bridge.request({ kind: "desktop/local/configure", notifications: event.target.checked, locale }).then((result) => setValue(result as typeof value)).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false))
      }} />} /> : null}
    {section !== "notifications" ? <SettingsRow label={t("視窗位置與大小")} description={t("關閉時保存，下次啟動恢復。")}
      control={<button className="primary-button" disabled={busy} onClick={() => { setBusy(true); setError(undefined); void bridge.request({ kind: "window/reset-bounds" }).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false)) }}>{t("重設視窗")}</button>} /> : null}
    {section !== "notifications" && workspaceId ? <SettingsRow label={t("整合終端 Shell")} description={t("只影響新開的內建終端；Windows 自動優先 Git Bash，找不到則使用 CMD。既有終端保持目前 Shell；Agent 的 bash、pwsh 工具各自使用同名 Shell。")}
      control={<select aria-label={t("整合終端 Shell")} value={selectedShell} disabled={busy || !value || shells.length === 0} onChange={(event) => {
        const terminalShell = event.target.value as TerminalShellChoice
        setBusy(true); setError(undefined)
        void bridge.request({ kind: "desktop/local/configure", terminalShell }).then((result) => setValue(result as NativeState)).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false))
      }}>{visibleShells.map((option) => <option key={option.id} value={option.id}>{option.id === "auto" ? t("自動選擇") : option.label}</option>)}</select>} /> : null}
  </SettingsGroup>{error ? <p role="alert" className="error-text">{error}</p> : null}</>
}
