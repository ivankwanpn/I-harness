import { useEffect, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale, useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import type { TerminalShellChoice } from "../../shared/bridge.ts"
type NativeState = { notifications: boolean; notificationsSupported: boolean; terminalShell?: TerminalShellChoice; terminalFontFamily?: string }
type ShellOption = { id: TerminalShellChoice; label: string; command?: string }
export function NativeSettings({ bridge, section = "all" }: { bridge: DesktopBridge; section?: "all" | "window" | "notifications" }) {
  const t = useText()
  const locale = useLocale((state) => state.locale)
  const [value, setValue] = useState<NativeState>()
  const [shells, setShells] = useState<ShellOption[]>([])
  const [fontDraft, setFontDraft] = useState("")
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void bridge.request({ kind: "desktop/local/state" }).then((result) => {
      if (!active) return
      if (!result || typeof (result as { notifications?: unknown }).notifications !== "boolean") throw new Error("Native preferences unavailable")
      setValue(result as NativeState)
      setFontDraft((result as NativeState).terminalFontFamily ?? "")
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge])
  useEffect(() => {
    if (section === "notifications") return
    let active = true
    void bridge.request({ kind: "desktop/terminal/options" }).then((result) => {
      if (!Array.isArray(result)) throw new Error("Terminal shell options unavailable")
      if (active) setShells(result as ShellOption[])
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge, section])
  const selectedShell = value?.terminalShell ?? "auto"
  const visibleShells = shells.some((option) => option.id === selectedShell)
    ? shells
    : [...shells, { id: selectedShell, label: t("已選擇的 Shell 目前不可用") }]
  const selectedCommand = visibleShells.find((option) => option.id === selectedShell)?.command
  const normalizedFont = fontDraft.trim()
  const fontDirty = value !== undefined && normalizedFont !== (value.terminalFontFamily ?? "")
  return <>{section === "all" ? <h2>{t("視窗與通知")}</h2> : null}<SettingsGroup>
    {section !== "window" ? <SettingsRow label={t("背景待處理通知")} description={t(value?.notificationsSupported === false ? "此系統不支援桌面通知。" : "視窗不在前景時，有審批或問題需要處理便通知。")}
      control={<input type="checkbox" aria-label={t("背景待處理通知")} checked={value?.notifications === true} disabled={busy || !value?.notificationsSupported} onChange={(event) => {
        setBusy(true); setError(undefined)
        void bridge.request({ kind: "desktop/local/configure", notifications: event.target.checked, locale }).then((result) => setValue(result as typeof value)).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false))
      }} />} /> : null}
    {section !== "notifications" ? <SettingsRow label={t("視窗位置與大小")} description={t("關閉時保存，下次啟動恢復。")}
      control={<button className="primary-button" disabled={busy} onClick={() => { setBusy(true); setError(undefined); void bridge.request({ kind: "window/reset-bounds" }).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false)) }}>{t("重設視窗")}</button>} /> : null}
  </SettingsGroup>{section !== "notifications" ? <><h2>{t("終端")}</h2><SettingsGroup><SettingsRow label={t("整合終端 Shell")} description={t("只影響新開的內建終端；Windows 自動優先 Git Bash，找不到則使用 CMD。既有終端保持目前 Shell；Agent 的 bash、pwsh 工具各自使用同名 Shell。")}
      control={<select aria-label={t("整合終端 Shell")} value={selectedShell} disabled={busy || !value || shells.length === 0} onChange={(event) => {
        const terminalShell = event.target.value as TerminalShellChoice
        setBusy(true); setError(undefined)
        void bridge.request({ kind: "desktop/local/configure", terminalShell }).then((result) => setValue(result as NativeState)).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false))
      }}>{visibleShells.map((option) => <option key={option.id} value={option.id}>{option.id === "auto" ? t("自動選擇") : option.label}</option>)}</select>} />{selectedCommand ? <p className="settings-shell-path" role="status">{t("目前執行檔")}：<code>{selectedCommand}</code></p> : null}
      <SettingsRow label={t("終端字體")} description={t("留空使用內建預設字體；返回終端畫面後套用，不改變已啟動的 Shell。")}
        control={<button aria-label={t("儲存終端字體")} disabled={busy || !fontDirty} onClick={() => {
          setBusy(true); setError(undefined)
          void bridge.request({ kind: "desktop/local/configure", terminalFontFamily: normalizedFont }).then((result) => { const next = result as NativeState; setValue(next); setFontDraft(next.terminalFontFamily ?? "") }).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false))
        }}>{t("儲存")}</button>}
        detail={<input className="settings-terminal-font-input" aria-label={t("終端字體")} placeholder={t("例如 Cascadia Code, monospace")} value={fontDraft} maxLength={128} disabled={busy || !value} onChange={(event) => setFontDraft(event.target.value)} />} />
    </SettingsGroup></> : null}{error ? <p role="alert" className="error-text">{error}</p> : null}</>
}
