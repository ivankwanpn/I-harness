import { useCallback, useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { RuntimeDiagnosticEntry, RuntimeDiagnosticFilter, RuntimeDiagnosticList } from "../../shared/runtime-diagnostics.ts"
import { useText } from "../design/i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { SettingsDialog } from "./SettingsDialog.tsx"
import "./RuntimeLog.css"

type Bridge = Pick<DesktopBridge, "request">
export function RuntimeDetails({ bridge, entry, onClose }: { bridge: Bridge; entry: RuntimeDiagnosticEntry; onClose(): void }) {
  const t = useText()
  const [safeEntry, setSafeEntry] = useState<RuntimeDiagnosticEntry>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    void bridge.request({ kind: "desktop/diagnostics/list", ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}), ...(entry.sessionId ? { sessionId: entry.sessionId } : {}) }).then(value => {
      if (!active) return
      const current = (value as RuntimeDiagnosticList).entries.find(row => row.id === entry.id)
      if (current) setSafeEntry(current)
      else setError(t("記錄已不可用，請重新整理診斷記錄。"))
    }).catch(() => { if (active) setError(t("無法讀取診斷記錄。")) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [bridge, entry.id, entry.workspaceId, entry.sessionId, t])
  async function copy() {
    setBusy(true); setNotice(undefined); setError(undefined)
    try {
      const result = await bridge.request({ kind: "desktop/diagnostics/copy", id: entry.id }) as { copied: boolean }
      if (!result.copied) throw new Error("copy unavailable")
      setNotice(t("已複製安全詳細資料。"))
    } catch { setError(t("無法複製安全詳細資料。")) }
    finally { setBusy(false) }
  }
  return <SettingsDialog title={t("診斷詳細資料")} closeLabel={t("關閉")} initialFocusSelector=".runtime-details-copy" busy={busy} onClose={onClose} className="runtime-details-dialog">
    {loading ? <p role="status">{t("正在讀取…")}</p> : null}
    {safeEntry ? <pre className="runtime-details-json">{JSON.stringify(safeEntry, null, 2)}</pre> : null}
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <Button variant="secondary" className="runtime-details-copy" disabled={!safeEntry || busy} onClick={() => { void copy() }}>{t("複製安全詳細資料")}</Button>
  </SettingsDialog>
}

export function RuntimeLog({ bridge }: { bridge: Bridge }) {
  const t = useText()
  const [entries, setEntries] = useState<RuntimeDiagnosticEntry[]>([])
  const [storageError, setStorageError] = useState<string>()
  const [query, setQuery] = useState("")
  const [sessionId, setSessionId] = useState("")
  const [level, setLevel] = useState<RuntimeDiagnosticFilter["level"]>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [details, setDetails] = useState<RuntimeDiagnosticEntry>()
  const revision = useRef(0)
  const filters = (): RuntimeDiagnosticFilter => ({ ...(query.trim() ? { query: query.trim().slice(0, 256) } : {}), ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}), ...(level ? { level } : {}) })
  const refresh = useCallback(async (filter: RuntimeDiagnosticFilter = {}) => {
    const request = ++revision.current
    setLoading(true); setError(undefined)
    try {
      const value = await bridge.request({ kind: "desktop/diagnostics/list", ...filter }) as RuntimeDiagnosticList
      if (revision.current !== request) return
      setEntries(value.entries); setStorageError(value.storageError)
    } catch { if (revision.current === request) setError(t("無法讀取診斷記錄。")) }
    finally { if (revision.current === request) setLoading(false) }
  }, [bridge, t])
  useEffect(() => { void refresh(); return () => { revision.current++ } }, [refresh])
  async function operation(kind: "desktop/diagnostics/export" | "desktop/diagnostics/reveal") {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const result = await bridge.request(kind === "desktop/diagnostics/export" ? { kind, ...filters() } : { kind }) as { exported?: boolean; count?: number; revealed?: boolean }
      if (kind === "desktop/diagnostics/export") setNotice(result.exported ? t("已匯出 {count} 筆安全記錄。", { count: result.count ?? 0 }) : t("已取消匯出。"))
      else if (result.revealed) setNotice(t("已開啟記錄資料夾。"))
      else throw new Error("reveal unavailable")
    } catch { setError(t(kind === "desktop/diagnostics/export" ? "無法匯出診斷記錄。" : "無法開啟記錄資料夾。")) }
    finally { setBusy(false) }
  }
  return <section className="runtime-log" aria-label={t("診斷記錄")}>
    <p className="muted runtime-log-bound">{t("最多顯示最近 1,000 筆記錄；搜尋、篩選與匯出只套用於此範圍。")}</p>
    <form className="runtime-log-filters" onSubmit={event => { event.preventDefault(); void refresh(filters()) }}>
      <label>{t("搜尋診斷記錄")}<input type="search" maxLength={256} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>{t("嚴重程度")}<select value={level ?? ""} onChange={event => setLevel(event.target.value ? event.target.value as RuntimeDiagnosticFilter["level"] : undefined)}><option value="">{t("全部")}</option><option value="info">{t("資訊")}</option><option value="warning">{t("警告")}</option><option value="error">{t("錯誤")}</option></select></label>
      <label>{t("會話 ID")}<input maxLength={128} value={sessionId} onChange={event => setSessionId(event.target.value)} /></label>
      <Button type="submit" variant="secondary" disabled={loading}>{t("重新整理")}</Button>
    </form>
    <div className="runtime-log-actions"><Button variant="secondary" disabled={busy} onClick={() => { void operation("desktop/diagnostics/export") }}>{t("匯出記錄")}</Button><Button variant="ghost" disabled={busy} onClick={() => { void operation("desktop/diagnostics/reveal") }}>{t("開啟記錄資料夾")}</Button></div>
    {loading ? <p role="status">{t("正在讀取…")}</p> : null}
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {storageError ? <p role="status" className="runtime-log-warning">{storageError}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {!loading && entries.length === 0 && !error ? <p className="muted">{t("沒有符合的診斷記錄。")}</p> : null}
    <ol className="runtime-log-entries">{entries.map(entry => <li key={entry.id} className={`runtime-log-entry runtime-log-${entry.level}`}>
      <div className="runtime-log-entry-meta"><time dateTime={new Date(entry.timestamp).toISOString()}>{new Date(entry.timestamp).toLocaleString()}</time><span>{t(entry.level === "error" ? "錯誤" : entry.level === "warning" ? "警告" : "資訊")}</span><code>{entry.kind}</code></div>
      <p>{entry.message}</p><div className="runtime-log-entry-footer"><small>{entry.sessionId ?? entry.workspaceId ?? t("全域")}{entry.code ? ` · ${entry.code}` : ""}</small><Button variant="ghost" size="small" onClick={() => setDetails(entry)}>{t("詳細資料")}</Button></div>
    </li>)}</ol>
    {details ? <RuntimeDetails key={details.id} bridge={bridge} entry={details} onClose={() => setDetails(undefined)} /> : null}
  </section>
}
