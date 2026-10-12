import { useEffect, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { GlobalModelWaitState } from "../../shared/runtime-diagnostics.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { Button } from "../vendor/opencode/Button.tsx"
import "./RuntimeLog.css"

const valid = (value: number) => Number.isSafeInteger(value) && (value === 0 || value >= 30 && value <= 3600)
const state = (value: unknown): value is GlobalModelWaitState => value !== null && typeof value === "object"
  && valid((value as GlobalModelWaitState).firstResponseSeconds) && valid((value as GlobalModelWaitState).progressSeconds)

export function ModelWaitSettings({ bridge }: { bridge: Pick<DesktopBridge, "request"> }) {
  const t = useText()
  const [first, setFirst] = useState("")
  const [progress, setProgress] = useState("")
  const [saved, setSaved] = useState<GlobalModelWaitState>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true); setError(undefined)
    void bridge.request({ kind: "desktop/global-model-wait/state" }).then(value => {
      if (!active) return
      if (!state(value)) throw new Error("invalid model wait state")
      setSaved(value); setFirst(String(value.firstResponseSeconds)); setProgress(String(value.progressSeconds))
    }).catch(() => { if (active) setError(t("無法讀取等待設定。")) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [bridge, reload, t])
  async function save() {
    const firstResponseSeconds = Number(first), progressSeconds = Number(progress)
    if (!first.trim() || !progress.trim() || !valid(firstResponseSeconds) || !valid(progressSeconds)) {
      setError(t("請輸入 0 或 30 到 3600 的整數秒數；0 停用該期限。")); return
    }
    setBusy(true); setError(undefined)
    try {
      const value = await bridge.request({ kind: "desktop/global-model-wait/configure", firstResponseSeconds, progressSeconds })
      if (!state(value)) throw new Error("invalid model wait state")
      setSaved(value); setFirst(String(value.firstResponseSeconds)); setProgress(String(value.progressSeconds))
    } catch { setError(t("無法儲存等待設定；輸入仍保留。")) }
    finally { setBusy(false) }
  }
  const disabled = loading || busy || saved === undefined
  return <section aria-label={t("模型等待期限")}>
    <h2>{t("模型等待期限")}</h2>
    <p className="muted">{t("每項預設 300 秒；0 停用。儲存後套用於下一次模型請求。")}</p>
    <SettingsGroup>
      <SettingsRow label={t("首次回應期限（秒）")} control={<input type="number" min={0} max={3600} step={1} aria-label={t("首次回應期限（秒）")} value={first} disabled={disabled} onChange={event => setFirst(event.target.value)} />} />
      <SettingsRow label={t("進度期限（秒）")} control={<input type="number" min={0} max={3600} step={1} aria-label={t("進度期限（秒）")} value={progress} disabled={disabled} onChange={event => setProgress(event.target.value)} />} />
    </SettingsGroup>
    <div className="retry-settings-actions"><Button variant="secondary" disabled={disabled} onClick={() => { void save() }}>{t("儲存等待設定")}</Button>
      {saved ? <small className="muted">{t("已儲存：{first} / {progress} 秒", { first: saved.firstResponseSeconds, progress: saved.progressSeconds })}</small> : null}
      {!loading && !saved ? <Button variant="ghost" onClick={() => setReload(value => value + 1)}>{t("重試")}</Button> : null}
    </div>
    {loading ? <p role="status" className="muted">{t("正在讀取…")}</p> : null}
    {error ? <p role="alert" className="error-text">{error}</p> : null}
  </section>
}
