import { useEffect, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useLocale, useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
export function NativeSettings({ bridge, section = "all" }: { bridge: DesktopBridge; section?: "all" | "window" | "notifications" }) {
  const t = useText()
  const locale = useLocale((state) => state.locale)
  const [value, setValue] = useState<{ notifications: boolean; notificationsSupported: boolean }>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void bridge.request({ kind: "desktop/local/state" }).then((result) => {
      if (!active) return
      if (!result || typeof (result as { notifications?: unknown }).notifications !== "boolean") throw new Error("Native preferences unavailable")
      setValue(result as { notifications: boolean; notificationsSupported: boolean })
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [bridge])
  return <>{section === "all" ? <h2>{t("視窗與通知")}</h2> : null}<SettingsGroup>
    {section !== "window" ? <SettingsRow label={t("背景待處理通知")} description={t(value?.notificationsSupported === false ? "此系統不支援桌面通知。" : "視窗不在前景時，有審批或問題需要處理便通知。")}
      control={<input type="checkbox" aria-label={t("背景待處理通知")} checked={value?.notifications === true} disabled={busy || !value?.notificationsSupported} onChange={(event) => {
        setBusy(true); setError(undefined)
        void bridge.request({ kind: "desktop/local/configure", notifications: event.target.checked, locale }).then((result) => setValue(result as typeof value)).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false))
      }} />} /> : null}
    {section !== "notifications" ? <SettingsRow label={t("視窗位置與大小")} description={t("關閉時保存，下次啟動恢復。")}
      control={<button className="primary-button" disabled={busy} onClick={() => { setBusy(true); setError(undefined); void bridge.request({ kind: "window/reset-bounds" }).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false)) }}>{t("重設視窗")}</button>} /> : null}
  </SettingsGroup>{error ? <p role="alert" className="error-text">{error}</p> : null}</>
}
