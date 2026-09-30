import { useEffect, useState } from "react"
import { RotateCcw, Save } from "lucide-react"
import { useText } from "../design/i18n.ts"
import "./review-editor.css"

export type ReviewSaveResult =
  | { kind: "saved"; revision: string; bytes: number }
  | { kind: "conflict" }
  | { kind: "unavailable"; reason: string }

export type EditableSource =
  | { kind: "text"; text: string; truncated: boolean; bytes: number; revision?: string }
  | { kind: "unavailable"; reason: string }

interface Draft { text: string; original: string; revision: string; crlf: boolean }
const normalize = (text: string) => text.replaceAll("\r\n", "\n")
const draftFrom = (value: Extract<EditableSource, { kind: "text" }>): Draft => ({
  text: normalize(value.text), original: normalize(value.text), revision: value.revision!,
  crlf: value.text.includes("\r\n") && !/(?<!\r)\n/.test(value.text),
})

/** Source styling follows ZCode CodeContent: monospace, line gutter, and a
 * compact toolbar. Drafts stay local until an explicit, revision-checked save. */
export function SourceFileEditor({ path, value, onSave, onReload }: {
  path: string
  value?: EditableSource
  onSave(path: string, text: string, expectedRevision: string): Promise<ReviewSaveResult>
  onReload(path: string): void
}) {
  const t = useText()
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [saving, setSaving] = useState<string>()
  const [scrollTop, setScrollTop] = useState(0)
  const [feedback, setFeedback] = useState<Record<string, { error?: string; saved?: boolean }>>({})
  const complete = value?.kind === "text" && !value.truncated && value.revision !== undefined
  const draft = drafts[path] ?? (complete ? draftFrom(value) : undefined)
  const dirty = draft !== undefined && draft.text !== draft.original
  const lineCount = draft?.text.split("\n").length ?? 0
  const firstVisibleLine = Math.floor(scrollTop / 20)

  useEffect(() => {
    setScrollTop(0)
  }, [path])

  useEffect(() => {
    if (!complete) return
    setDrafts((current) => {
      const previous = current[path]
      if (previous && previous.text !== previous.original) return current
      if (previous?.revision === value.revision) return current
      return { ...current, [path]: draftFrom(value) }
    })
  }, [path, value])

  async function save() {
    if (!draft || !dirty || saving !== undefined) return
    const savingPath = path
    const snapshot = draft
    setSaving(savingPath)
    setFeedback((current) => ({ ...current, [savingPath]: {} }))
    try {
      const text = snapshot.crlf ? snapshot.text.replaceAll("\n", "\r\n") : snapshot.text
      const result = await onSave(savingPath, text, snapshot.revision)
      if (result.kind === "saved") {
        setDrafts((current) => ({ ...current, [savingPath]: { ...snapshot, original: snapshot.text, revision: result.revision } }))
        setFeedback((current) => ({ ...current, [savingPath]: { saved: true } }))
      } else {
        const error = result.kind === "conflict" ? t("檔案已在外部變更，編輯內容已保留。請重新讀取後合併變更。")
          : result.reason === "too-large" ? t("檔案過大，僅供預覽，無法儲存")
          : result.reason === "binary" ? t("二進位內容不顯示")
          : result.reason === "not-found" ? t("找不到檔案") : t("無法儲存檔案")
        setFeedback((current) => ({ ...current, [savingPath]: { error } }))
      }
    } catch (error) {
      setFeedback((current) => ({ ...current, [savingPath]: { error: error instanceof Error ? error.message : String(error) } }))
    } finally { setSaving(undefined) }
  }

  function reload() {
    setDrafts((current) => {
      const next = { ...current }
      delete next[path]
      return next
    })
    setFeedback((current) => ({ ...current, [path]: {} }))
    onReload(path)
  }

  if (!draft) {
    if (value === undefined) return <p className="muted">{t("正在讀取…")}</p>
    if (value.kind === "unavailable") return <p className="notice">{value.reason === "binary" ? t("二進位內容不顯示") : value.reason === "deleted" ? t("檔案已刪除") : t("找不到檔案")}</p>
    return <div className="review-text"><p className="notice">{value.truncated ? t("檔案過大，僅供預覽，無法儲存") : t("無法取得完整檔案版本，僅供預覽")}</p><pre className="tool-output review-code">{value.text}</pre></div>
  }

  return <section className="source-editor" aria-label={path}>
    <div className="source-editor-toolbar">
      <span className="row-meta">{dirty ? t("尚未儲存") : `${lineCount} · ${draft.crlf ? "CRLF" : "LF"}`}</span>
      <button type="button" className="link-button" disabled={saving !== undefined} onClick={reload} title={dirty ? t("捨棄編輯並重新讀取") : t("重新讀取檔案")}><RotateCcw size={14} />{dirty ? t("捨棄編輯並重新讀取") : t("重新讀取檔案")}</button>
      <button type="button" className="link-button" disabled={!dirty || saving !== undefined} onClick={() => void save()}><Save size={14} />{saving === path ? t("儲存中…") : t("儲存檔案")}</button>
    </div>
    {feedback[path]?.error ? <p role="alert" className="notice error-text">{feedback[path].error}</p> : null}
    {feedback[path]?.saved && !dirty ? <p role="status" className="row-meta">{t("檔案已儲存")}</p> : null}
    <div className="source-editor-body">
      <div className="source-editor-lines" aria-hidden="true" style={{ width: `${String(lineCount).length + 2}ch` }}><div style={{ transform: `translateY(-${scrollTop % 20}px)` }}>{Array.from({ length: Math.max(0, Math.min(32, lineCount - firstVisibleLine)) }, (_, index) => <span key={firstVisibleLine + index}>{firstVisibleLine + index + 1}</span>)}</div></div>
      <textarea aria-label={t("來源檔案內容")} value={draft.text} spellCheck={false} wrap="off" disabled={saving === path}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onChange={(event) => {
          setDrafts((current) => ({ ...current, [path]: { ...draft, text: event.target.value } }))
          setFeedback((current) => ({ ...current, [path]: {} }))
        }}
        onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save() } }} />
    </div>
  </section>
}
