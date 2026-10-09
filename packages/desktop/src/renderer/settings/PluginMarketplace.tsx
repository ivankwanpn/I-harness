import { useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { PluginCommand } from "@i-harness/desktop-gateway/src/plugins.ts"
import { useText } from "../design/i18n.ts"
import { SettingsGroup, SettingsRow } from "../vendor/zcode/SettingsRow.tsx"
import { SearchInput } from "../vendor/zcode/SearchInput.tsx"
import { Puzzle } from "lucide-react"
interface Plugin { id: string; name: string; description?: string; installed: boolean; enabled: boolean; capabilities?: Record<string, boolean>; conflicts?: { name: string; reason: string }[] }
interface State { sources: { name: string; source: string; error?: string }[]; plugins: Plugin[]; diagnostics?: Record<string, string[]>; refreshError?: string }
function descriptionPreview(value: string): string {
  const characters = Array.from(value.trim())
  return characters.length > 120 ? `${characters.slice(0, 120).join("").trimEnd()}…` : value
}
export function PluginMarketplace({ bridge, workspaceId, embedded = false, initialQuery = "", queryRequest }: { bridge: DesktopBridge; workspaceId: string; embedded?: boolean; initialQuery?: string; queryRequest?: { value: string; nonce: number } }) {
  const t = useText()
  const [state, setState] = useState<State>()
  const [error, setError] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const [source, setSource] = useState("")
  const [query, setQuery] = useState(initialQuery)
  const [installed, setInstalled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<string>()
  const [expanded, setExpanded] = useState<string>()
  const [reload, setReload] = useState(0)
  const [page, setPage] = useState(0)
  const lock = useRef(false)
  useEffect(() => {
    if (!queryRequest) return
    setQuery(queryRequest.value); setPage(0)
  }, [queryRequest?.nonce])
  useEffect(() => {
    let active = true
    void bridge.request({ kind: "desktop/plugins/state", workspaceId }).then((value) => { if (active) { setState(value as State); setLoadError(undefined) } }).catch((reason: unknown) => { if (active) setLoadError(String(reason)) })
    return () => { active = false }
  }, [bridge, workspaceId, reload])
  async function run(command: PluginCommand) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(undefined)
    try {
      await bridge.request({ kind: "desktop/plugins/mutate", workspaceId, command })
      setConfirm(undefined); if (command.action === "source/add") setSource("")
      setReload((value) => value + 1)
    } catch (reason) { setError(String(reason)); setReload((value) => value + 1) }
    finally { lock.current = false; setBusy(false) }
  }
  const remove = (command: PluginCommand, key: string) => confirm === key ? void run(command) : setConfirm(key)
  const rows = state?.plugins.filter((row) => (!installed || row.installed) && `${row.id} ${row.name} ${row.description ?? ""}`.toLowerCase().includes(query.toLowerCase())) ?? []
  return <section className={embedded ? "marketplace-pane settings-embedded" : "marketplace-pane"} aria-label={t("插件市場")}>
    {embedded ? null : <h1>{t("插件市場")}</h1>}
    <p className="muted">{t("插件變更會即時套用到現有 Agent；已開始的操作會依原機制收尾。")}</p>
    {state?.refreshError ? <p role="alert">{state.refreshError}<button disabled={busy} onClick={() => {
      if (lock.current) return
      lock.current = true; setBusy(true); setError(undefined)
      void bridge.request({ kind: "desktop/plugins/refresh", workspaceId }).catch((reason: unknown) => setError(String(reason))).finally(() => { lock.current = false; setBusy(false); setReload((value) => value + 1) })
    }}>{t("重試即時套用")}</button></p> : null}
    {error || loadError ? <p role="alert">{error ?? loadError}<button disabled={busy} onClick={() => setReload(reload + 1)}>{t("重試")}</button></p> : null}
    {busy ? <p role="status">{t("正在處理插件操作…")}</p> : null}
    <details><summary>{t("管理市場來源")}</summary>
      <form className="provider-editor" onSubmit={(event) => { event.preventDefault(); void run({ action: "source/add", source }) }}>
        <label>{t("來源網址或本機路徑")}<input required maxLength={4096} disabled={busy} value={source} onChange={(event) => setSource(event.target.value)} /></label>
        <div className="provider-actions"><button disabled={busy || !source.trim()}>{t("加入來源")}</button><button type="button" disabled={busy} onClick={() => setSource("anthropics/claude-plugins-official")}>{t("填入官方市場來源")}</button></div>
      </form>
      {state?.sources.map((entry) => <SettingsGroup key={entry.name}><SettingsRow label={entry.name} description={entry.source} control={<div className="provider-actions"><button disabled={busy} onClick={() => { void run({ action: "source/refresh", name: entry.name }) }}>{t("重新整理")}</button><button disabled={busy} onClick={() => remove({ action: "source/remove", name: entry.name }, `source:${entry.name}`)}>{t(confirm === `source:${entry.name}` ? "確認移除來源" : "移除來源")}</button></div>} />{entry.error ? <p role="alert">{entry.error}</p> : null}</SettingsGroup>)}
    </details>
    <div className="marketplace-filter"><SearchInput aria-label={t("搜尋插件")} placeholder={t("搜尋插件")} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} clearLabel={t("清除搜尋")} onClear={() => { setQuery(""); setPage(0) }} /><label className="marketplace-installed-filter"><input type="checkbox" checked={installed} onChange={(event) => { setInstalled(event.target.checked); setPage(0) }} />{t("僅顯示已安裝")}</label></div>
    {!state ? !loadError ? <p role="status">{t("正在讀取插件目錄…")}</p> : null : rows.length === 0 ? <p>{t(query.trim() || installed ? "沒有符合的插件" : "尚未加入插件；可先加入市場來源。")}</p> : null}
    {rows.length ? <div className="marketplace-list">{rows.slice(page * 50, (page + 1) * 50).map((plugin) => <article className="marketplace-item" key={plugin.id}>
      <div className="marketplace-item-main">
        <span className="marketplace-item-icon"><Puzzle size={16} aria-hidden="true" /></span>
        <button type="button" className="marketplace-item-summary" aria-label={t("查看插件詳情 {name}", { name: plugin.name })} aria-expanded={expanded === plugin.id} onClick={() => setExpanded(expanded === plugin.id ? undefined : plugin.id)}><strong>{plugin.name}</strong><small>{descriptionPreview(plugin.description ?? plugin.id)}</small>{plugin.capabilities?.hooks ? <small className="marketplace-hook-hint">{t("Hooks 需另行授權")}</small> : null}</button>
        <span className="marketplace-item-status">{t(plugin.enabled ? "已啟用" : plugin.installed ? "已安裝" : "未安裝")}</span>
        <div className="marketplace-item-actions">{plugin.installed ? <><button type="button" disabled={busy} onClick={() => { void run({ action: plugin.enabled ? "disable" : "enable", id: plugin.id }) }}>{t(plugin.enabled ? "停用" : "啟用")}</button><button type="button" disabled={busy} onClick={() => remove({ action: "uninstall", id: plugin.id }, plugin.id)}>{t(confirm === plugin.id ? "確認卸載" : "卸載")}</button></> : <button type="button" disabled={busy} onClick={() => { void run({ action: "install", id: plugin.id }) }}>{t("安裝")}</button>}</div>
      </div>
      {plugin.conflicts?.map((conflict) => <p className="marketplace-conflict error-text" role="alert" key={conflict.name}>{conflict.name}: {conflict.reason}</p>)}
      {expanded === plugin.id ? <div className="marketplace-item-detail"><p>{plugin.description ?? plugin.id}</p><code>{plugin.id}</code>{Object.entries(plugin.capabilities ?? {}).filter(([, value]) => value).length ? <p>{Object.entries(plugin.capabilities ?? {}).filter(([, value]) => value).map(([name]) => name).join(" · ")}</p> : null}{plugin.capabilities?.hooks ? <p className="muted">{t("Hook 仍須通過既有信任檢查，啟用插件不會自動授權。")}</p> : null}</div> : null}
    </article>)}</div> : null}
    {rows.length > 50 ? <div className="provider-actions"><button disabled={page === 0} onClick={() => setPage(page - 1)}>{t("上一頁")}</button><span>{page + 1} / {Math.ceil(rows.length / 50)}</span><button disabled={(page + 1) * 50 >= rows.length} onClick={() => setPage(page + 1)}>{t("下一頁")}</button></div> : null}
    {confirm ? <button disabled={busy} onClick={() => setConfirm(undefined)}>{t("取消")}</button> : null}
    {Object.entries(state?.diagnostics ?? {}).some(([, messages]) => messages.length) ? <details><summary>{t("插件載入診斷")}</summary>{Object.entries(state?.diagnostics ?? {}).map(([session, messages]) => messages.length ? <div key={session}><h3>{session}</h3>{messages.map((message, index) => <p key={index}>{message}</p>)}</div> : null)}</details> : null}
  </section>
}
