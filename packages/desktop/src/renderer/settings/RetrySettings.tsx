import { useEffect, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { GlobalRetryState } from "../../shared/runtime-diagnostics.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import "./RuntimeLog.css"

export function RetrySettings({ bridge }: { bridge: Pick<DesktopBridge, "request"> }) {
  const t = useText()
  const [draft, setDraft] = useState("")
  const [saved, setSaved] = useState<number>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true); setError(undefined)
    void bridge.request({ kind: "desktop/global-retry/state" }).then(value => {
      if (!active) return
      const state = value as GlobalRetryState
      if (!Number.isInteger(state.maxRetries) || state.maxRetries < 0 || state.maxRetries > 100) throw new Error("invalid retry state")
      setSaved(state.maxRetries); setDraft(String(state.maxRetries))
    }).catch(() => { if (active) setError(t("無法讀取重試設定。")) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [bridge, reload, t])
  async function save() {
    const maxRetries = Number(draft)
    if (!draft.trim() || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 100) { setError(t("請輸入 0 到 100 的整數；0 停用重試。")); return }
    setBusy(true); setError(undefined)
    try {
      const state = await bridge.request({ kind: "desktop/global-retry/configure", maxRetries }) as GlobalRetryState
      if (!Number.isInteger(state.maxRetries) || state.maxRetries < 0 || state.maxRetries > 100) throw new Error("invalid retry state")
      setSaved(state.maxRetries); setDraft(String(state.maxRetries))
    } catch { setError(t("無法儲存重試設定；輸入仍保留。")) }
    finally { setBusy(false) }
  }
  return <section aria-label={t("模型自動重試")}>
    <h2>{t("模型自動重試")}</h2>
    <SettingsGroup><SettingsRow label={t("模型重試次數")} description={t("預設 5 次；0 停用。儲存後套用於下一次模型請求，不會改變正在執行的重試。")}
      control={<input className="retry-settings-count" type="number" min={0} max={100} step={1} aria-label={t("模型重試次數")} value={draft} disabled={loading || busy || saved === undefined} onChange={event => setDraft(event.target.value)} />} /></SettingsGroup>
    <div className="retry-settings-actions"><Button variant="secondary" disabled={loading || busy || saved === undefined} onClick={() => { void save() }}>{t("儲存重試設定")}</Button>{saved !== undefined ? <small className="muted">{t("已儲存重試次數：{count}", { count: saved })}</small> : null}{!loading && saved === undefined ? <Button variant="ghost" onClick={() => setReload(value => value + 1)}>{t("重試")}</Button> : null}</div>
    {loading ? <p role="status" className="muted">{t("正在讀取…")}</p> : null}{error ? <p role="alert" className="error-text">{error}</p> : null}
  </section>
}
