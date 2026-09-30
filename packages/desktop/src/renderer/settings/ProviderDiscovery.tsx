import { useEffect, useRef, useState } from "react"
import { Compass, Plus, LoaderCircle } from "lucide-react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"
import type { EditableModel } from "./ProviderEditor.tsx"
import type { ProviderCommand } from "@i-harness/desktop-gateway/src/provider-wire.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { SearchInput } from "../vendor/zcode/SearchInput.tsx"

export function ProviderDiscovery({ bridge, workspaceId, id, onSave }: { bridge: DesktopBridge; workspaceId: string; id: string; onSave(command: ProviderCommand): Promise<void> }) {
  const t = useText()
  const token = useRef<string | undefined>(undefined)
  const mounted = useRef(true)
  const importing = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [rows, setRows] = useState<EditableModel[]>()
  const [selected, setSelected] = useState<string[]>([])
  const [imported, setImported] = useState(0)
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  const matches = rows?.filter((row) => `${row.id} ${row.name ?? ""}`.toLowerCase().includes(query.toLowerCase())) ?? []
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; if (token.current) void bridge.request({ kind: "desktop/provider/probe/cancel", workspaceId, token: token.current }).catch(() => undefined) }
  }, [bridge, workspaceId])
  const probe = async () => {
    if (token.current || importing.current) return
    const attempt = crypto.randomUUID(); token.current = attempt
    setBusy(true); setError(undefined); setRows(undefined); setSelected([]); setImported(0); setPage(0); setQuery("")
    try {
      const result = await bridge.request({ kind: "desktop/provider/probe", workspaceId, id, token: attempt }) as EditableModel[]
      if (mounted.current && token.current === attempt) setRows(result)
    } catch (reason) { if (mounted.current && token.current === attempt) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (token.current === attempt) token.current = undefined; if (mounted.current) setBusy(false) }
  }
  return <section className="provider-discovery">
    <header className="provider-discovery-heading"><div><h4>{t("模型探索")}</h4><p className="muted">{t("從提供商取得可用模型，選取後加入列表。")}</p></div>
      <div className="provider-actions"><Button variant="secondary" size="small" icon={busy && token.current ? <LoaderCircle size={15} /> : <Compass size={15} />} disabled={busy} onClick={() => { void probe() }}>{t(busy && token.current ? "探索中…" : "探索模型")}</Button>
        {busy && token.current ? <Button variant="ghost" size="small" onClick={() => { if (token.current) void bridge.request({ kind: "desktop/provider/probe/cancel", workspaceId, token: token.current }).catch((reason: unknown) => setError(String(reason))) }}>{t("取消")}</Button> : null}
      </div></header>
    {error ? <div className="provider-discovery-error"><p role="alert">{error}</p><p className="muted">{t("也可以使用新增模型，手動設定模型 ID 與協議。")}</p></div> : null}
    {rows ? <>
      <p className="muted">{t("選取後才加入設定；已有模型的自訂值會保留。")}</p>
      <SearchInput aria-label={t("篩選模型")} placeholder={t("篩選模型")} clearLabel={t("清除模型搜尋")} onClear={() => { setQuery(""); setPage(0) }} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} />
      {matches.length === 0 ? <p>{t("沒有找到模型")}</p> : <div className="provider-discovery-list">{matches.slice(page * 100, (page + 1) * 100).map((row) => <label key={row.id} data-selected={selected.includes(row.id)}><input type="checkbox" disabled={busy} checked={selected.includes(row.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, row.id] : selected.filter((item) => item !== row.id))} /><span>{row.name ?? row.id}<small>{row.id}</small></span></label>)}</div>}
      {matches.length > 100 ? <div className="provider-actions"><button disabled={page === 0} onClick={() => setPage(page - 1)}>{t("上一頁")}</button><span>{page + 1} / {Math.ceil(matches.length / 100)}</span><button disabled={(page + 1) * 100 >= matches.length} onClick={() => setPage(page + 1)}>{t("下一頁")}</button></div> : null}
      <Button variant="secondary" size="small" icon={<Plus size={15} />} disabled={busy || selected.length === 0} onClick={() => {
        if (importing.current) return
        importing.current = true; setBusy(true); setError(undefined); setImported(0)
        void (async () => {
          for (const row of rows.filter((item) => selected.includes(item.id))) {
            if (!mounted.current) break
            const fields = { ...(row.name ? { name: row.name } : {}), ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}), ...(row.maxTokens ? { maxTokens: row.maxTokens } : {}), ...(row.protocol ? { protocol: row.protocol } : {}) }
            await onSave({ action: "model/add", id, model: row.id, fields })
            if (mounted.current) { setImported((value) => value + 1); setSelected((values) => values.filter((value) => value !== row.id)) }
          }
        })().catch((reason: unknown) => { if (mounted.current) setError(String(reason)) }).finally(() => { importing.current = false; if (mounted.current) setBusy(false) })
      }}>{t("加入所選模型")}</Button>
    </> : null}
    {imported > 0 ? <p role="status">{t("已加入 {count} 個模型", { count: imported })}</p> : null}
  </section>
}
