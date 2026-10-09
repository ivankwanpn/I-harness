import { useEffect, useRef, useState } from "react"
import { BookOpen, Command, Puzzle, RefreshCw, ArrowRight } from "lucide-react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ResourceKind, ResourceList, ResourceDetail, ResourceSummary, ResourceAuthoringRequestHandler } from "@i-harness/desktop-gateway/src/resources.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useAuthoringText } from "./resource-authoring-text.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { SearchInput } from "../vendor/zcode/SearchInput.tsx"
import { SettingsDialog } from "./SettingsDialog.tsx"
import { ResourceAuthoringEditor, type ResourceDraft } from "./ResourceAuthoringEditor.tsx"
import { SettingsDraftScope, useSettingsDraft, useSettingsDraftMap } from "./settings-drafts.tsx"

interface ResourceSettingsProps { bridge: DesktopBridge; workspaceId: string; resourceKind: ResourceKind; onUse?(prefix: string): void; onManagePlugins?(id?: string): void; onAuthoringRequest?: ResourceAuthoringRequestHandler; active?: boolean }
export function ResourceSettings(props: ResourceSettingsProps) {
  return <SettingsDraftScope owner={props.bridge}><ResourceSettingsContent key={JSON.stringify([props.workspaceId, props.resourceKind])} {...props} /></SettingsDraftScope>
}
function ResourceSettingsContent({ bridge, workspaceId, resourceKind, onUse, onManagePlugins, onAuthoringRequest, active = true }: ResourceSettingsProps) {
  const t = useAuthoringText()
  const [query, setQuery] = useSettingsDraft(["resources", workspaceId, resourceKind, "query"], "")
  const [search, setSearch] = useSettingsDraft(["resources", workspaceId, resourceKind, "search"], { query: "", offset: 0, revision: 0 })
  const [list, setList] = useState<ResourceList>()
  const [detail, setDetail] = useState<ResourceDetail>()
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [editor, setEditor] = useSettingsDraft<{ key: string; detail?: ResourceDetail } | undefined>(["resources", workspaceId, resourceKind, "editor"], undefined)
  const [editorBusy, setEditorBusy] = useState(false)
  const drafts = useSettingsDraftMap<ResourceDraft>(["resources", workspaceId, resourceKind, "drafts"])
  const scope = `${workspaceId}:${resourceKind}`
  const scopeRef = useRef(scope), epoch = useRef(0)
  if (scopeRef.current !== scope) { scopeRef.current = scope; ++epoch.current }
  const selectedIdentity = useRef<ResourceSummary | undefined>(undefined)
  const readVersion = useRef(0)
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    let active = true
    ++readVersion.current; setList(undefined); setDetail(undefined); setSelected(undefined); setError(undefined); setLoading(false)
    const command = { kind: "desktop/resources/list" as const, workspaceId, resourceKind, query: search.query, offset: search.offset, includeShadowed: true }
    void bridge.request(command).then((value) => {
      if (!active) return
      const result = value as ResourceList
      if (search.offset > 0 && search.offset >= result.total) { setSearch({ ...search, offset: Math.max(0, Math.floor((result.total - 1) / 50) * 50) }); return }
      setList(result)
    }).catch((reason: unknown) => { if (active) setError(String(reason)) })
    return () => { active = false; ++readVersion.current }
  }, [bridge, workspaceId, resourceKind, search])
  function closeDetail() {
    ++readVersion.current; setSelected(undefined); setDetail(undefined); setLoading(false); setError(undefined)
    setTimeout(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus() }, 0)
  }
  async function select(row: ResourceSummary) {
    const { name } = row
    selectedIdentity.current = row
    const version = ++readVersion.current
    setSelected(name); setDetail(undefined); setLoading(true); setError(undefined)
    try {
      const command = { kind: "desktop/resources/read" as const, workspaceId, resourceKind, name, source: row.source, ...(row.pluginId ? { pluginId: row.pluginId } : {}) }
      const value = await bridge.request(command)
      if (version !== readVersion.current) return
      if (!value) throw new Error(t("項目已不可用，請重新整理。"))
      setDetail(value as ResourceDetail)
    } catch (reason) { if (version === readVersion.current) setError(String(reason)) }
    finally { if (version === readVersion.current) setLoading(false) }
  }
  const source = { workspace: "工作區", global: "全域", plugin: "插件" } as const
  const Icon = resourceKind === "skills" ? BookOpen : Command
  return <section className="resource-settings" aria-label={t(resourceKind === "skills" ? "技能" : "命令")}>
    <p className="settings-description">{t(resourceKind === "skills" ? "顯示後端有效技能；同名項目的優先順序為工作區、插件、全域。選取後才載入內容。" : "顯示有效命令；同名項目的優先順序為工作區、插件、全域。帶入輸入框後由你送出。")}</p>
    <form className="resource-search" onSubmit={(event) => { event.preventDefault(); setSearch({ query, offset: 0, revision: search.revision + 1 }) }}>
      <SearchInput aria-label={t("搜尋名稱或描述")} placeholder={t("搜尋名稱或描述")} maxLength={512} value={query} onChange={(event) => setQuery(event.target.value)} clearLabel={t("清除搜尋")} onClear={() => { setQuery(""); setSearch({ query: "", offset: 0, revision: search.revision + 1 }) }} />
      <Button type="submit" variant="secondary" size="small">{t("搜尋")}</Button>
      <Button variant="ghost" size="small" icon={<RefreshCw size={15} />} onClick={() => setSearch({ ...search, revision: search.revision + 1 })}>{t("重新整理")}</Button>
      {onManagePlugins ? <Button variant="secondary" size="small" icon={<Puzzle size={15} />} onClick={() => onManagePlugins()}>{t("管理插件")}</Button> : null}
      {onAuthoringRequest ? <><Button size="small" onClick={() => { setSelected(undefined); setEditor({ key: `${scope}:new` }) }}>{t("建立資源")}</Button>{resourceKind === "skills" ? <Button size="small" variant="secondary" onClick={() => {
        const captured = epoch.current
        void onAuthoringRequest({ kind: "desktop/resources/import", workspaceId, source: "workspace" }).then(value => {
          if (captured !== epoch.current || !value) return
          const imported = value as { name: string; body: string; source: "workspace" | "global" }
          const key = `${scope}:import`
          drafts.set(key, { ...imported, revision: null, existing: false }); setSelected(undefined); setEditor({ key })
        }).catch(reason => { if (captured === epoch.current) setError(String(reason)) })
      }}>{t("匯入 SKILL.md")}</Button> : null}</> : null}
    </form>
    {error && !selected ? <p role="alert" className="error-text">{error}</p> : null}
    {!list && !error ? <p role="status">{t("正在讀取…")}</p> : null}
    {list?.diagnostics.length ? <details className="resource-diagnostics"><summary>{t("載入診斷")}</summary>{list.diagnostics.map((message, index) => <p key={index}>{message}</p>)}</details> : null}
    {list ? <>
      <div className="resource-list-heading"><h2>{t(resourceKind === "skills" ? "技能列表" : "命令列表")}</h2><span className="muted">{t("共 {count} 項", { count: list.total })}</span></div>
      {list.items.length === 0 ? <div className="resource-empty"><Icon size={28} aria-hidden="true" /><p>{t(search.query.trim() ? "沒有符合的項目" : resourceKind === "skills" ? "尚未建立技能" : "尚未建立命令")}</p></div> : <ul className="resource-cards" aria-label={t(resourceKind === "skills" ? "技能列表" : "命令列表")}>
        {list.items.map((row) => <li key={`${row.source}:${row.pluginId ?? ""}:${row.name}`}><button className="resource-card" type="button" aria-label={row.name} onClick={(event) => { returnFocus.current = event.currentTarget; void select(row) }}>
          <div className="resource-card-top"><span className="resource-card-icon"><Icon size={18} aria-hidden="true" /></span><span className="resource-source-badge">{t(source[row.source])}</span></div>
          <strong>{resourceKind === "commands" ? "/" : "$"}{row.name}</strong>
          <p>{row.description || t("選取以查看內容")}</p>
          <div className="resource-card-footer"><span title={row.pluginId}>{row.pluginId ?? t(source[row.source])}{row.effective === false ? ` · ${t("被同名資源覆蓋")}` : ""}</span><ArrowRight size={15} aria-hidden="true" /></div>
        </button></li>)}
      </ul>}
      {list.total > 50 ? <div className="resource-pagination"><Button size="small" disabled={search.offset === 0} onClick={() => setSearch({ ...search, offset: search.offset - 50 })}>{t("上一頁")}</Button><span>{Math.floor(search.offset / 50) + 1} / {Math.ceil(list.total / 50)}</span><Button size="small" disabled={search.offset + 50 >= list.total} onClick={() => setSearch({ ...search, offset: search.offset + 50 })}>{t("下一頁")}</Button></div> : null}
    </> : null}
    {editor && onAuthoringRequest ? <SettingsDialog active={active} busy={editorBusy} title={t("資源編輯器")} closeLabel={t("關閉資源編輯器")} onClose={() => { if (!editorBusy) setEditor(undefined) }} initialFocusSelector="textarea"><ResourceAuthoringEditor key={`${scope}:${editor.key}`} workspaceId={workspaceId} resourceKind={resourceKind} detail={editor.detail} request={onAuthoringRequest} reload={async (source, name) => { const command = { kind: "desktop/resources/read" as const, workspaceId, resourceKind, source, name }; return await bridge.request(command) as ResourceDetail | undefined }} draft={drafts.get(editor.key)} onDraft={draft => drafts.set(editor.key, draft)} onBusyChange={setEditorBusy} onClose={() => { if (!editorBusy) setEditor(undefined) }} onSaved={() => { drafts.delete(editor.key); setEditor(undefined); setSearch({ ...search, revision: search.revision + 1 }) }} /></SettingsDialog> : null}
    {selected ? <SettingsDialog active={active} title={selected} closeLabel={t("關閉內容預覽")} onClose={closeDetail} initialFocusSelector=".resource-detail button:not(:disabled)">
      <div className="resource-detail">
        {loading ? <p role="status">{t("正在讀取…")}</p> : error ? <p role="alert" className="error-text">{error}<Button variant="ghost" size="small" onClick={() => { if (selectedIdentity.current) void select(selectedIdentity.current) }}>{t("重試")}</Button></p> : detail ? <>
          <div className="resource-detail-meta"><span className="resource-source-badge">{t(source[detail.source])}</span>{detail.pluginId ? <span className="muted">{detail.pluginId}</span> : null}</div>
          {detail.description ? <p className="muted">{detail.description}</p> : null}
          {detail.path ? <details className="resource-path"><summary>{t("來源檔案")}</summary><code>{detail.path}</code></details> : null}
          {detail.argumentHints ? <p><code>{detail.argumentHints}</code></p> : null}
          {detail.unsupported?.length ? <p className="notice">{t("後端尚未執行的宣告：{fields}", { fields: detail.unsupported.join(", ") })}</p> : null}
          <div className="provider-actions"><Button variant="primary" size="small" disabled={!onUse || detail.effective === false} onClick={() => { try { onUse?.(`${resourceKind === "skills" ? "$" : "/"}${detail.name} `) } catch (reason) { setError(String(reason)) } }}>{t(resourceKind === "skills" ? "使用此技能" : "帶入此命令")}</Button>{detail.pluginId && onManagePlugins ? <Button variant="secondary" size="small" onClick={() => onManagePlugins(detail.pluginId)}>{t("管理來源插件")}</Button> : null}</div>
          {detail.effective === false ? <p className="notice">{t("目前執行使用其他來源的同名項目。此版本仍可編輯或複製。")}</p> : null}
          {onAuthoringRequest && !detail.truncated && detail.rawBody !== undefined ? <Button onClick={() => { const key = `${scope}:${detail.source}:${detail.pluginId ?? ""}:${detail.name}`; setEditor({ key, detail }); setSelected(undefined) }}>{t(detail.source === "plugin" ? "複製插件到本機" : "編輯本機內容")}</Button> : null}
          {!onUse ? <p className="muted">{t("先選擇會話，再帶入輸入框。")}</p> : null}
          {detail.truncated ? <p className="notice">{t("內容過長，預覽已截斷。")}</p> : null}
          <div className="resource-body"><Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>[{alt}]</span>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{detail.body}</Markdown></div>
        </> : null}
      </div>
    </SettingsDialog> : null}
  </section>
}
