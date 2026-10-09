import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { RotateCcw, Save } from "lucide-react"
import { useText } from "../design/i18n.ts"
import { usePreferences } from "../design/preferences.ts"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import { EditorDraftStore, editorDraftKey, getEditorDraftStore, isDraftDirty } from "./editor-drafts.ts"
import { useProjectFilesText } from "./project-files-text.ts"
import { displayedNavigationRange, type ProjectFileNavigation } from "../session/file-navigation.ts"
import { SearchPreview } from "./SearchPreview.tsx"
import type { SearchPreview as PreviewValue } from "./content-search-results.ts"
import { ReadonlyFilePreview } from "./ReadonlyFilePreview.tsx"
import "./review-editor.css"

export type ReviewSaveResult =
  | { kind: "saved"; revision: string; bytes: number }
  | { kind: "conflict" }
  | { kind: "unavailable"; reason: string }
export type EditableSource =
  | { kind: "text"; text: string; truncated: boolean; bytes: number; revision?: string; readonly?: boolean; external?: boolean }
  | { kind: "unavailable"; reason: string }

/** External draft ownership survives panel unmounts and folder switches. */
export function SourceFileEditor({ workspaceId, path, value, navigation, preview, store: suppliedStore, available = true, onSave, onReload }: {
  workspaceId?: string
  path: string
  value?: EditableSource
  navigation?: ProjectFileNavigation
  preview?: PreviewValue
  store?: EditorDraftStore
  available?: boolean
  onSave(path: string, text: string, expectedRevision: string): Promise<ReviewSaveResult>
  onReload(path: string): void
}) {
  const t = useText()
  const pf = useProjectFilesText()
  const fontSize = usePreferences(state => state.fontSize)
  const lineHeight = Math.ceil(fontSize * 1.5)
  const [localStore] = useState(() => new EditorDraftStore())
  const store = suppliedStore ?? (workspaceId ? getEditorDraftStore() : localStore)
  const ref = { workspaceId: workspaceId ?? "legacy", path }, key = editorDraftKey(ref)
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [saving, setSaving] = useState<string>()
  const [reloadChoice, setReloadChoice] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const textarea = useRef<HTMLTextAreaElement>(null), revealed = useRef<string | undefined>(undefined)
  const complete = value?.kind === "text" && !value.truncated && typeof value.revision === "string" && /^[a-f0-9]{64}$/.test(value.revision)
  const draft = state.drafts[key]
  const dirty = isDraftDirty(draft)
  const external = value?.kind === "text" && value.external === true || navigation?.external === true || preview?.external === true
  const readonly = external || value?.kind === "text" && value.readonly === true || navigation?.readonly === true || !!preview
  const writable = available && complete && !readonly
  const lineCount = draft?.text.split("\n").length ?? 0
  const firstVisibleLine = Math.floor(scrollTop / lineHeight)
  useEffect(() => { setScrollTop(0); setReloadChoice(false) }, [key])
  useEffect(() => { if (available && !readonly) store.ingest(ref, value) }, [store, key, value, available, !!draft, readonly])
  useEffect(() => {
    const token = navigation ? `${key}:${navigation.nonce}` : ""
    if (!navigation || !available || value === undefined || preview && !dirty || !draft || !textarea.current || revealed.current === token) return
    const range = displayedNavigationRange(draft.text, navigation)
    revealed.current = token
    textarea.current.focus({ preventScroll: true }); textarea.current.setSelectionRange(range.start, range.end)
    textarea.current.scrollTop = Math.max(0, (range.line - 1) * lineHeight - 2 * lineHeight)
    setScrollTop(textarea.current.scrollTop)
  }, [key, navigation, draft?.text, value, available, preview, dirty, lineHeight])

  async function save() {
    if (!draft || !dirty || !writable || saving !== undefined) return
    setSaving(key)
    try { await store.save(ref, (text, revision) => onSave(path, text, revision)) }
    catch (error) { store.feedback(ref, error instanceof Error ? error.message : String(error)) }
    finally { setSaving(undefined) }
  }
  function discardReload() {
    store.discard(ref, available && !readonly ? value : undefined)
    setReloadChoice(false)
    onReload(path)
  }
  function reload() {
    if (dirty && workspaceId) setReloadChoice(true)
    else discardReload()
  }
  if (available && preview && !dirty) return <SearchPreview value={preview} navigation={navigation} />
  if (available && readonly && !dirty && value?.kind === "text") return <ReadonlyFilePreview value={{ ...value, external }} />
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
    {!available ? <p role="alert" className="notice error-text">{pf("資料夾已移出目前專案；草稿已保留，無法讀取或儲存。")}</p> : readonly ? <p className="notice">{pf(external ? "專案外檔案僅供唯讀；草稿已保留。" : "此檔案僅供唯讀；草稿已保留。")}</p> : !writable ? <p role={value === undefined ? "status" : "alert"} className={value === undefined ? "notice muted" : "notice error-text"}>{value?.kind === "unavailable" ? pf("無法讀取檔案 ({reason})；草稿已保留。", { reason: value.reason }) : pf("正在確認完整檔案版本；草稿已保留。")}</p> : null}
    {navigation && dirty ? <p className="notice">{pf("搜尋位置來自磁碟；未儲存草稿的位置可能不同。")}</p> : navigation?.revision && draft.revision !== navigation.revision ? <p className="notice">{pf("檔案已在搜尋後變更；標示位置可能不同。")}</p> : null}
    {state.persistenceError ? <p role="alert" className="notice error-text">{state.persistenceError}</p> : null}
    {draft.error ? <p role="alert" className="notice error-text">{pf(draft.error)}</p> : null}
    {draft.saved && !dirty ? <p role="status" className="row-meta">{t("檔案已儲存")}</p> : null}
    {reloadChoice ? <SettingsDialog title={pf("重新讀取未儲存檔案")} closeLabel={pf("關閉對話框")} initialFocusSelector="button" busy={saving !== undefined} onClose={() => setReloadChoice(false)}>
      <p>{pf("重新讀取前選擇如何處理未儲存內容。")}</p>
      <button type="button" onClick={() => { setReloadChoice(false); onReload(path) }}>{pf("保留草稿並讀取外部版本")}</button>
      <button type="button" onClick={discardReload}>{pf("捨棄草稿並重新讀取")}</button>
      <button type="button" onClick={() => setReloadChoice(false)}>{pf("取消")}</button>
    </SettingsDialog> : null}
    {draft.external ? <div className="editor-conflict">
      <details><summary>{pf("檢視外部版本")}</summary><pre className="tool-output review-code">{draft.external.text}</pre></details>
      <button type="button" disabled={!writable} onClick={() => store.rebase(ref)}>{pf("已合併變更，使用此版本作為儲存基準")}</button>
      <button type="button" disabled={!writable} onClick={() => store.discard(ref, draft.external)}>{pf("捨棄草稿並採用外部版本")}</button>
    </div> : null}
    <div className="source-editor-body" style={{ fontSize: `${fontSize}px`, lineHeight: `${lineHeight}px` }}>
      <div className="source-editor-lines" aria-hidden="true" style={{ width: `${String(lineCount).length + 2}ch` }}><div style={{ transform: `translateY(-${scrollTop % lineHeight}px)` }}>{Array.from({ length: Math.max(0, Math.min(32, lineCount - firstVisibleLine)) }, (_, index) => <span key={firstVisibleLine + index}>{firstVisibleLine + index + 1}</span>)}</div></div>
      <textarea ref={textarea} aria-label={t("來源檔案內容")} value={draft.text} spellCheck={false} wrap="off" disabled={!writable || saving === key}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onChange={(event) => { if (writable && saving !== key) store.edit(ref, event.target.value) }}
        onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save() } }} />
    </div>
  </section>
}
