import { useEffect, useRef, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ResourceKind, ResourceList, ResourceDetail } from "@i-harness/desktop-gateway/src/resources.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"

export function ResourceSettings({ bridge, workspaceId, resourceKind, onUse, onManagePlugins }: { bridge: DesktopBridge; workspaceId: string; resourceKind: ResourceKind; onUse?(prefix: string): void; onManagePlugins?(id?: string): void }) {
  const t = useText()
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState({ query: "", offset: 0, revision: 0 })
  const [list, setList] = useState<ResourceList>()
  const [detail, setDetail] = useState<ResourceDetail>()
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const readVersion = useRef(0)
  useEffect(() => {
    let active = true
    ++readVersion.current; setList(undefined); setDetail(undefined); setSelected(undefined); setError(undefined); setLoading(false)
    void bridge.request({ kind: "desktop/resources/list", workspaceId, resourceKind, query: search.query, offset: search.offset }).then((value) => {
      if (!active) return
      const result = value as ResourceList
      if (search.offset > 0 && search.offset >= result.total) { setSearch({ ...search, offset: Math.max(0, Math.floor((result.total - 1) / 50) * 50) }); return }
      setList(result)
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false; ++readVersion.current }
  }, [bridge, workspaceId, resourceKind, search])
  async function select(name: string) {
    const version = ++readVersion.current
    setSelected(name); setDetail(undefined); setLoading(true); setError(undefined)
    try {
      const value = await bridge.request({ kind: "desktop/resources/read", workspaceId, resourceKind, name })
      if (version !== readVersion.current) return
      if (!value) throw new Error(t("項目已不可用，請重新整理。"))
      setDetail(value as ResourceDetail)
    } catch (reason) { if (version === readVersion.current) setError(String(reason)) }
    finally { if (version === readVersion.current) setLoading(false) }
  }
  const source = { workspace: "工作區", global: "全域", plugin: "插件" } as const
  return <section aria-label={t(resourceKind === "skills" ? "技能" : "命令")}>
    <p className="settings-description">{t(resourceKind === "skills" ? "顯示後端有效技能；同名項目的優先順序為工作區、插件、全域。選取後才載入內容。" : "顯示已啟用插件提供的提示命令；帶入輸入框後由你送出。")}</p>
    <form className="resource-search" onSubmit={(event) => { event.preventDefault(); setSearch({ query, offset: 0, revision: search.revision + 1 }) }}><input aria-label={t("搜尋名稱或描述")} placeholder={t("搜尋名稱或描述")} maxLength={512} value={query} onChange={(event) => setQuery(event.target.value)} /><button className="primary-button">{t("搜尋")}</button><button type="button" onClick={() => setSearch({ ...search, revision: search.revision + 1 })}>{t("重新整理")}</button>{onManagePlugins ? <button type="button" onClick={() => onManagePlugins()}>{t("管理插件")}</button> : null}</form>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {!list && !error ? <p role="status">{t("正在讀取…")}</p> : null}
    {list?.diagnostics.length ? <details><summary>{t("載入診斷")}</summary>{list.diagnostics.map((message, index) => <p key={index}>{message}</p>)}</details> : null}
    {list ? <div className="resource-layout">
      <div className="resource-list">{list.items.length === 0 ? <p className="muted">{t("沒有符合的項目")}</p> : list.items.map((row) => <button key={row.name} type="button" aria-label={row.name} aria-current={selected === row.name ? "true" : undefined} onClick={() => { void select(row.name) }}><strong>{resourceKind === "commands" ? "/" : "$"}{row.name}</strong><small>{row.description}</small><span className="resource-source">{t(source[row.source])}{row.pluginId ? ` · ${row.pluginId}` : ""}</span></button>)}
        {list.total > 50 ? <div className="provider-actions"><button disabled={search.offset === 0} onClick={() => setSearch({ ...search, offset: search.offset - 50 })}>{t("上一頁")}</button><span>{Math.floor(search.offset / 50) + 1} / {Math.ceil(list.total / 50)}</span><button disabled={search.offset + 50 >= list.total} onClick={() => setSearch({ ...search, offset: search.offset + 50 })}>{t("下一頁")}</button></div> : null}
      </div>
      <div className="resource-detail">{loading ? <p role="status">{t("正在讀取…")}</p> : detail ? <>
        <h2>{detail.name}</h2><p className="muted">{t(source[detail.source])}{detail.path ? ` · ${detail.path}` : ""}{detail.pluginId ? ` · ${detail.pluginId}` : ""}</p>
        {detail.argumentHints ? <p><code>{detail.argumentHints}</code></p> : null}
        {detail.unsupported?.length ? <p className="notice">{t("後端尚未執行的宣告：{fields}", { fields: detail.unsupported.join(", ") })}</p> : null}
        <div className="provider-actions"><button className="primary-button" disabled={!onUse} onClick={() => { try { onUse?.(`${resourceKind === "skills" ? "$" : "/"}${detail.name} `) } catch (reason) { setError(String(reason)) } }}>{t(resourceKind === "skills" ? "使用此技能" : "帶入此命令")}</button>{detail.pluginId && onManagePlugins ? <button onClick={() => onManagePlugins(detail.pluginId)}>{t("管理來源插件")}</button> : null}</div>
        {!onUse ? <p className="muted">{t("先選擇會話，再帶入輸入框。")}</p> : null}
        {detail.truncated ? <p className="notice">{t("內容過長，預覽已截斷。")}</p> : null}
        <div className="resource-body"><Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>[{alt}]</span>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{detail.body}</Markdown></div>
      </> : <p className="muted">{t("選擇項目以查看內容")}</p>}</div>
    </div> : null}
  </section>
}
