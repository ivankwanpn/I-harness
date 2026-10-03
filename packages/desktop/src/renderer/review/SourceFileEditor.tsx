import { useEffect, useState, useSyncExternalStore } from "react"
import { RotateCcw, Save } from "lucide-react"
import { useText } from "../design/i18n.ts"
import { EditorDraftStore, editorDraftKey, getEditorDraftStore, isDraftDirty } from "./editor-drafts.ts"
import { useProjectFilesText } from "./project-files-text.ts"
import "./review-editor.css"

export type ReviewSaveResult =
  | { kind: "saved"; revision: string; bytes: number }
  | { kind: "conflict" }
  | { kind: "unavailable"; reason: string }
export type EditableSource =
  | { kind: "text"; text: string; truncated: boolean; bytes: number; revision?: string }
  | { kind: "unavailable"; reason: string }

/** External draft ownership survives panel unmounts and folder switches. */
export function SourceFileEditor({ workspaceId, path, value, store: suppliedStore, available = true, onSave, onReload }: {
  workspaceId?: string
  path: string
  value?: EditableSource
  store?: EditorDraftStore
  available?: boolean
  onSave(path: string, text: string, expectedRevision: string): Promise<ReviewSaveResult>
  onReload(path: string): void
}) {
  const t = useText()
  const pf = useProjectFilesText()
  const [localStore] = useState(() => new EditorDraftStore())
  const store = suppliedStore ?? (workspaceId ? getEditorDraftStore() : localStore)
  const ref = { workspaceId: workspaceId ?? "legacy", path }, key = editorDraftKey(ref)
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [saving, setSaving] = useState<string>()
  const [reloadChoice, setReloadChoice] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const complete = value?.kind === "text" && !value.truncated && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision)
  const draft = state.drafts[key]
  const dirty = isDraftDirty(draft)
  const writable = available && complete
  const lineCount = draft?.text.split("\n").length ?? 0
  const firstVisibleLine = Math.floor(scrollTop / 20)
  useEffect(() => { setScrollTop(0); setReloadChoice(false) }, [key])
  useEffect(() => { if (available) store.ingest(ref, value) }, [store, key, value, available, !!draft])

  async function save() {
    if (!draft || !dirty || !writable || saving !== undefined) return
    setSaving(key)
    try { await store.save(ref, (text, revision) => onSave(path, text, revision)) }
    catch (error) { store.feedback(ref, error instanceof Error ? error.message : String(error)) }
    finally { setSaving(undefined) }
  }
  function discardReload() {
    store.discard(ref, available ? value : undefined)
    setReloadChoice(false)
    onReload(path)
  }
  function reload() {
    if (dirty && workspaceId) setReloadChoice(true)
    else discardReload()
  }
  if (!draft) {
    if (value === undefined) return <p className="muted">{t("正在讀取…")}</p>
    if (value.kind === "unavailable") return <p className="notice">{value.reason === "binary" ? t("二進位內容不顯示") : value.reason === "deleted" ? t("檔案已刪除") : t("找不到檔案")}</p>
    return <div className="review-text"><p className="notice">{value.truncated ? t("檔案過大，僅供預覽，無法儲存") : t("無法取得完整檔案版本，僅供預覽")}</p><pre className="tool-output review-code">{value.text}</pre></div>
  }
  return <section className="source-editor" aria-label={workspaceId ? `${workspaceId}/${path}` : path}>
    <div className="source-editor-toolbar">
      <span className="row-meta">{dirty ? t("尚未儲存") : `${lineCount} · ${draft.crlf ? "CRLF" : "LF"}${draft.bom ? " · BOM" : ""}`}</span>
      <button type="button" className="link-button" disabled={!available || saving !== undefined} onClick={reload}><RotateCcw size={14} />{dirty ? t("捨棄編輯並重新讀取") : t("重新讀取檔案")}</button>
      <button type="button" className="link-button" disabled={!dirty || !writable || saving !== undefined || !!draft.external} onClick={() => void save()}><Save size={14} />{saving === key ? t("儲存中…") : t("儲存檔案")}</button>
    </div>
    {!available ? <p role="alert" className="notice error-text">{pf("資料夾已移出目前專案；草稿已保留，無法讀取或儲存。")}</p> : !writable ? <p role="alert" className="notice error-text">{value?.kind === "unavailable" ? pf("無法讀取檔案 ({reason})；草稿已保留。", { reason: value.reason }) : pf("正在確認完整檔案版本；草稿已保留。")}</p> : null}
    {state.persistenceError ? <p role="alert" className="notice error-text">{state.persistenceError}</p> : null}
    {draft.error ? <p role="alert" className="notice error-text">{pf(draft.error)}</p> : null}
    {draft.saved && !dirty ? <p role="status" className="row-meta">{t("檔案已儲存")}</p> : null}
    {reloadChoice ? <div role="dialog" aria-label={pf("重新讀取未儲存檔案")} className="editor-close-choice">
      <p>{pf("重新讀取前選擇如何處理未儲存內容。")}</p>
      <button type="button" onClick={() => { setReloadChoice(false); onReload(path) }}>{pf("保留草稿並讀取外部版本")}</button>
      <button type="button" onClick={discardReload}>{pf("捨棄草稿並重新讀取")}</button>
      <button type="button" onClick={() => setReloadChoice(false)}>{pf("取消")}</button>
    </div> : null}
    {draft.external ? <div className="editor-conflict">
      <details><summary>{pf("檢視外部版本")}</summary><pre className="tool-output review-code">{draft.external.text}</pre></details>
      <button type="button" disabled={!writable} onClick={() => store.rebase(ref)}>{pf("已合併變更，使用此版本作為儲存基準")}</button>
      <button type="button" disabled={!writable} onClick={() => store.discard(ref, draft.external)}>{pf("捨棄草稿並採用外部版本")}</button>
    </div> : null}
    <div className="source-editor-body">
      <div className="source-editor-lines" aria-hidden="true" style={{ width: `${String(lineCount).length + 2}ch` }}><div style={{ transform: `translateY(-${scrollTop % 20}px)` }}>{Array.from({ length: Math.max(0, Math.min(32, lineCount - firstVisibleLine)) }, (_, index) => <span key={firstVisibleLine + index}>{firstVisibleLine + index + 1}</span>)}</div></div>
      <textarea aria-label={t("來源檔案內容")} value={draft.text} spellCheck={false} wrap="off" disabled={!writable || saving === key}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onChange={(event) => store.edit(ref, event.target.value)}
        onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save() } }} />
    </div>
  </section>
}
