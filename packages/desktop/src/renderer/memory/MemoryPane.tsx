import { useEffect, useRef, useState } from "react"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useAuthoringText } from "../settings/resource-authoring-text.ts"
import type { MemoryAuthoringRequest, MemoryAuthoringRequestHandler } from "@i-harness/desktop-gateway/src/memory-wire.ts"
export type { MemoryAuthoringRequest, MemoryAuthoringRequestHandler } from "@i-harness/desktop-gateway/src/memory-wire.ts"

interface Note { id: string; title: string; text?: string; snippet?: string; revision?: string }

/** Workspace-scoped management; the gateway remains the memory authority. */
export function MemoryPane({ bridge, workspaceId, embedded = false, onAuthoringRequest }: { bridge: DesktopBridge; workspaceId: string; embedded?: boolean; onAuthoringRequest?: MemoryAuthoringRequestHandler }) {
  const t = useAuthoringText()
  const [enabled, setEnabled] = useState<boolean>()
  const [notes, setNotes] = useState<Note[]>([])
  const [selected, setSelected] = useState<Note>()
  const [query, setQuery] = useState("")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [summary, setSummary] = useState<string>()
  const [editing, setEditing] = useState<Note>()
  const [checked, setChecked] = useState<Record<string, string>>({})
  const [confirmBatch, setConfirmBatch] = useState(false)
  const [conflictNote, setConflictNote] = useState<Note>()
  const lock = useRef(false)
  const scope = useRef(workspaceId), epoch = useRef(0)
  if (scope.current !== workspaceId) { scope.current = workspaceId; ++epoch.current }
  const generation = epoch.current
  const drafts = useRef(new Map<string, { title: string; text: string }>())
  const draftKey = `${workspaceId}:${editing?.id ?? "new"}`
  function updateDraft(patch: { title?: string; text?: string }) {
    const next = { title, text, ...patch }
    setTitle(next.title); setText(next.text); drafts.current.set(draftKey, next)
  }
  async function scopedRequest(request: Parameters<DesktopBridge["request"]>[0]) {
    const result = await bridge.request(request)
    if (epoch.current !== generation) throw new Error("Workspace changed")
    return result
  }
  async function authorRequest(request: MemoryAuthoringRequest) {
    if (!onAuthoringRequest) throw new Error("Memory authoring unavailable")
    const result = await onAuthoringRequest(request)
    if (epoch.current !== generation) throw new Error("Workspace changed")
    return result
  }

  useEffect(() => {
    let active = true
    lock.current = true; setBusy(true); setEnabled(undefined); setNotes([]); setSelected(undefined); setEditing(undefined); setChecked({}); setConfirmBatch(false); setConfirmDelete(false); setSummary(undefined); setCreating(false); setError(undefined); setQuery(""); setConflictNote(undefined)
    const draft = drafts.current.get(`${workspaceId}:new`)
    setTitle(draft?.title ?? ""); setText(draft?.text ?? "")
    void Promise.all([
      bridge.request({ kind: "desktop/memory/state", workspaceId }),
      bridge.request({ kind: "desktop/memory/list", workspaceId, limit: 100 }),
    ]).then(([state, result]) => {
      if (!active) return
      setEnabled((state as { enabled: boolean }).enabled)
      setNotes((result as { notes: Note[] }).notes)
    }).catch((reason: unknown) => {
      if (active) setError(String(reason))
    }).finally(() => { if (active) { lock.current = false; setBusy(false) } })
    return () => { active = false }
  }, [bridge, workspaceId])

  async function run(action: () => Promise<void>) {
    if (lock.current || busy) return
    lock.current = true
    setBusy(true)
    setError(undefined)
    try { await action() } catch (reason) { if (epoch.current === generation) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (epoch.current === generation) { lock.current = false; setBusy(false) } }
  }

  async function refresh() {
    const result = await scopedRequest({ kind: "desktop/memory/list", workspaceId, limit: 100 }) as { notes: Note[] }
    setNotes(result.notes)
    setQuery("")
    setSummary(undefined)
  }

  return <section className={embedded ? "memory-pane settings-embedded" : "memory-pane"} aria-label={t("工作區記憶")}>
    {embedded ? null : <h1>{t("工作區記憶")}</h1>}
    <p className="muted">{t("筆記保存在此工作區，可供不同會話查找。目前不會自動生成記憶。")}</p>
    {error === undefined ? null : <p role="alert" className="error-text">{error}</p>}
    <label className="memory-switch"><input type="checkbox" checked={enabled === true} disabled={busy || enabled === undefined}
      onChange={(event) => { const next = event.target.checked; void run(async () => {
        const result = await scopedRequest({ kind: "desktop/memory/configure", workspaceId, enabled: next }) as { enabled: boolean }
        setEnabled(result.enabled)
      }) }} />{t("啟用工作區記憶")}</label>
    <form className="memory-search" onSubmit={(event) => { event.preventDefault(); void run(async () => {
      if (query.trim() === "") return refresh()
      const result = await scopedRequest({ kind: "desktop/memory/search", workspaceId, query, limit: 100 }) as { hits: Note[] }
      setNotes(result.hits)
    }) }}>
      <input maxLength={1024} aria-label={t("搜尋筆記")} placeholder={t("搜尋筆記")} value={query} onChange={(event) => setQuery(event.target.value)} />
      <button className="primary-button" disabled={busy}>{t("搜尋")}</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => { void run(refresh) }}>{t("全部筆記")}</button>
    </form>
    {busy ? <p role="status" className="muted">{t("正在讀取…")}</p> : null}
    <div className="memory-summary"><button type="button" className="primary-button" disabled={busy} onClick={() => { void run(async () => {
      const result = await scopedRequest({ kind: "desktop/memory/summary", workspaceId }) as { text: string }
      setSummary(result.text)
    }) }}>{t("查看筆記摘要")}</button>
      <p className="muted">{t("僅擷取已保存筆記，不會呼叫模型。")}</p>
      {summary === undefined ? null : <pre className="tool-output">{summary || t("沒有可顯示的摘要")}</pre>}
    </div>
    <div className="memory-columns">
      <div><div className="memory-notes-header"><p className="muted">{t("最多顯示 100 筆；可搜尋其他筆記。")}</p>{enabled === true && !creating ? <button type="button" className="primary-button" disabled={busy} onClick={() => { setEditing(undefined); const draft = drafts.current.get(`${workspaceId}:new`); setTitle(draft?.title ?? ""); setText(draft?.text ?? ""); setCreating(true) }}>{t("新增筆記")}</button> : null}</div>
        {onAuthoringRequest && Object.keys(checked).length ? <div className="provider-actions"><button disabled={busy} onClick={() => setConfirmBatch(true)}>{t("批次刪除（{count}）", { count: Object.keys(checked).length })}</button><button disabled={busy} onClick={() => { setChecked({}); setConfirmBatch(false) }}>{t("清除選取")}</button></div> : null}
        {confirmBatch ? <div role="group" aria-label={t("確認刪除選取筆記")}><p>{t("永久刪除選取筆記；若其中一筆已變更，整批會保留。")}</p><button disabled={busy} onClick={() => { void run(async () => {
          const result = await authorRequest({ kind: "desktop/memory/forget-many", workspaceId, confirmed: true, targets: Object.entries(checked).map(([id, expectedRevision]) => ({ id, expectedRevision })) }) as { kind: string }
          if (result.kind === "conflict") throw new Error(t("筆記已變更；整批已保留。請重新讀取後選取。"))
          if (result.kind !== "forgotten") throw new Error(t("未收到已刪除的結果"))
          setSelected(undefined); setChecked({}); setConfirmBatch(false); await refresh()
        }) }}>{t("確認刪除選取筆記")}</button><button disabled={busy} onClick={() => setConfirmBatch(false)}>{t("取消")}</button></div> : null}
        {!busy && notes.length === 0 ? <p className="muted">{t("沒有符合的筆記")}</p> : null}
        <ul className="session-list">{notes.map((note) => <li key={note.id}>
          {onAuthoringRequest && note.revision ? <input type="checkbox" aria-label={t("選取 {title}", { title: note.title })} disabled={busy} checked={note.id in checked} onChange={event => { const next = { ...checked }; if (event.target.checked) next[note.id] = note.revision!; else delete next[note.id]; setChecked(next); setConfirmBatch(false) }} /> : null}
          <button className="row-button" disabled={busy} aria-current={selected?.id === note.id ? "true" : undefined} onClick={() => { void run(async () => {
            const result = await scopedRequest({ kind: "desktop/memory/read", workspaceId, id: note.id }) as { note?: Note }
            setSelected(result.note)
            setConfirmDelete(false)
          }) }}><span className="row-label">{note.title}</span>{note.snippet ? <span className="row-meta">{note.snippet}</span> : null}</button>
        </li>)}</ul>
        {selected === undefined ? null : <article className="memory-detail"><h2>{selected.title}</h2><p>{selected.text}</p>
          {onAuthoringRequest && selected.revision ? <button disabled={busy} onClick={() => { const draft = drafts.current.get(`${workspaceId}:${selected.id}`); setEditing(selected); setCreating(false); setTitle(draft?.title ?? selected.title); setText(draft?.text ?? selected.text ?? "") }}>{t("編輯筆記")}</button> : null}
          <button className="primary-button" disabled={busy} onClick={() => {
            if (!confirmDelete) { setConfirmDelete(true); return }
            void run(async () => {
              await scopedRequest({ kind: "desktop/memory/forget", workspaceId, id: selected.id })
              setSelected(undefined); setConfirmDelete(false); await refresh()
            })
          }}>{t(confirmDelete ? "確認刪除此筆記" : "刪除筆記")}</button>
          {confirmDelete ? <button className="link-button" onClick={() => setConfirmDelete(false)}>{t("取消")}</button> : null}
        </article>}
      </div>
      {(creating && enabled === true) || editing ? <form className="memory-editor" onSubmit={(event) => { event.preventDefault(); void run(async () => {
        if ((!enabled && !editing) || title.trim() === "" || text.trim() === "") return
        if (editing?.revision) {
          const result = await authorRequest({ kind: "desktop/memory/update", workspaceId, id: editing.id, title, text, expectedRevision: editing.revision }) as { kind: string; note: Note }
          if (result.kind === "conflict") { setConflictNote(result.note); throw new Error(t("筆記已變更；草稿已保留。請重新讀取並比較內容。")) }
          if (result.kind !== "saved") throw new Error(t("未收到已保存的結果"))
          setSelected(result.note)
        } else await scopedRequest({ kind: "desktop/memory/note", workspaceId, title, text })
        drafts.current.delete(draftKey); setTitle(""); setText(""); setCreating(false); setEditing(undefined); await refresh()
      }) }}>
        <h2>{t(editing ? "編輯筆記" : "新增筆記")}</h2>
        <label>{t("標題")}<input autoFocus maxLength={200} disabled={busy} value={title} onChange={(event) => updateDraft({ title: event.target.value })} /></label>
        <label>{t("內容")}<textarea rows={8} maxLength={16384} disabled={busy} value={text} onChange={(event) => updateDraft({ text: event.target.value })} /></label>
        {editing && conflictNote?.id === editing.id ? <div><h3>{t("目前保存的筆記")}</h3><p>{conflictNote.title}</p><pre className="tool-output">{conflictNote.text}</pre><button type="button" disabled={busy} onClick={() => { setEditing(conflictNote); setConflictNote(undefined); setError(undefined) }}>{t("保留草稿並採用此筆記修訂")}</button></div> : null}
        <div className="provider-actions"><button className="primary-button" disabled={busy || title.trim() === "" || text.trim() === ""}>{t(editing ? "儲存變更" : "儲存筆記")}</button><button type="button" disabled={busy} onClick={() => { setCreating(false); setEditing(undefined) }}>{t("取消")}</button></div>
      </form> : null}
    </div>
    {enabled === false ? <p className="muted">{t("啟用記憶後才可新增筆記；現有筆記仍可閱讀。")}</p> : null}
  </section>
}
