import { useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useText } from "../design/i18n.ts"

interface Note { id: string; title: string; text?: string; snippet?: string }

/** Workspace-scoped management; the gateway remains the memory authority. */
export function MemoryPane({ bridge, workspaceId }: { bridge: DesktopBridge; workspaceId: string }) {
  const t = useText()
  const [enabled, setEnabled] = useState<boolean>()
  const [notes, setNotes] = useState<Note[]>([])
  const [selected, setSelected] = useState<Note>()
  const [query, setQuery] = useState("")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [summary, setSummary] = useState<string>()
  const lock = useRef(false)

  useEffect(() => {
    let active = true
    void Promise.all([
      bridge.request({ kind: "desktop/memory/state", workspaceId }),
      bridge.request({ kind: "desktop/memory/list", workspaceId, limit: 100 }),
    ]).then(([state, result]) => {
      if (!active) return
      setEnabled((state as { enabled: boolean }).enabled)
      setNotes((result as { notes: Note[] }).notes)
    }).catch((reason: unknown) => {
      if (active) setError(String(reason))
    }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [bridge, workspaceId])

  async function run(action: () => Promise<void>) {
    if (lock.current || busy) return
    lock.current = true
    setBusy(true)
    setError(undefined)
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { lock.current = false; setBusy(false) }
  }

  async function refresh() {
    const result = await bridge.request({ kind: "desktop/memory/list", workspaceId, limit: 100 }) as { notes: Note[] }
    setNotes(result.notes)
    setQuery("")
    setSummary(undefined)
  }

  return <section className="memory-pane" aria-label={t("工作區記憶")}>
    <h1>{t("工作區記憶")}</h1>
    <p className="muted">{t("筆記保存在此工作區，可供不同會話查找。目前不會自動生成記憶。")}</p>
    {error === undefined ? null : <p role="alert" className="error-text">{error}</p>}
    <label className="memory-switch"><input type="checkbox" checked={enabled === true} disabled={busy || enabled === undefined}
      onChange={(event) => { const next = event.target.checked; void run(async () => {
        const result = await bridge.request({ kind: "desktop/memory/configure", workspaceId, enabled: next }) as { enabled: boolean }
        setEnabled(result.enabled)
      }) }} />{t("啟用工作區記憶")}</label>
    <form className="memory-search" onSubmit={(event) => { event.preventDefault(); void run(async () => {
      if (query.trim() === "") return refresh()
      const result = await bridge.request({ kind: "desktop/memory/search", workspaceId, query, limit: 100 }) as { hits: Note[] }
      setNotes(result.hits)
    }) }}>
      <input aria-label={t("搜尋筆記")} placeholder={t("搜尋筆記")} value={query} onChange={(event) => setQuery(event.target.value)} />
      <button className="primary-button" disabled={busy}>{t("搜尋")}</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => { void run(refresh) }}>{t("全部筆記")}</button>
    </form>
    {busy ? <p role="status" className="muted">{t("正在讀取…")}</p> : null}
    <div className="memory-summary"><button type="button" className="primary-button" disabled={busy} onClick={() => { void run(async () => {
      const result = await bridge.request({ kind: "desktop/memory/summary", workspaceId }) as { text: string }
      setSummary(result.text)
    }) }}>{t("查看筆記摘要")}</button>
      <p className="muted">{t("僅擷取已保存筆記，不會呼叫模型。")}</p>
      {summary === undefined ? null : <pre className="tool-output">{summary || t("沒有可顯示的摘要")}</pre>}
    </div>
    <div className="memory-columns">
      <div><p className="muted">{t("最多顯示 100 筆；可搜尋其他筆記。")}</p>
        {!busy && notes.length === 0 ? <p className="muted">{t("沒有符合的筆記")}</p> : null}
        <ul className="session-list">{notes.map((note) => <li key={note.id}>
          <button className="row-button" disabled={busy} aria-current={selected?.id === note.id ? "true" : undefined} onClick={() => { void run(async () => {
            const result = await bridge.request({ kind: "desktop/memory/read", workspaceId, id: note.id }) as { note?: Note }
            setSelected(result.note)
            setConfirmDelete(false)
          }) }}><span className="row-label">{note.title}</span>{note.snippet ? <span className="row-meta">{note.snippet}</span> : null}</button>
        </li>)}</ul>
        {selected === undefined ? null : <article className="memory-detail"><h2>{selected.title}</h2><p>{selected.text}</p>
          <button className="primary-button" disabled={busy} onClick={() => {
            if (!confirmDelete) { setConfirmDelete(true); return }
            void run(async () => {
              await bridge.request({ kind: "desktop/memory/forget", workspaceId, id: selected.id })
              setSelected(undefined); setConfirmDelete(false); await refresh()
            })
          }}>{t(confirmDelete ? "確認刪除此筆記" : "刪除筆記")}</button>
          {confirmDelete ? <button className="link-button" onClick={() => setConfirmDelete(false)}>{t("取消")}</button> : null}
        </article>}
      </div>
      <form className="memory-editor" onSubmit={(event) => { event.preventDefault(); void run(async () => {
        if (!enabled || title.trim() === "" || text.trim() === "") return
        await bridge.request({ kind: "desktop/memory/note", workspaceId, title, text })
        setTitle(""); setText(""); await refresh()
      }) }}>
        <h2>{t("新增筆記")}</h2>
        <label>{t("標題")}<input maxLength={200} disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>{t("內容")}<textarea rows={8} disabled={busy} value={text} onChange={(event) => setText(event.target.value)} /></label>
        <button className="primary-button" disabled={busy || !enabled || title.trim() === "" || text.trim() === ""}>{t("儲存筆記")}</button>
        {enabled === false ? <p className="muted">{t("啟用記憶後才可新增筆記；現有筆記仍可閱讀。")}</p> : null}
      </form>
    </div>
  </section>
}
