import { useEffect, useId, useRef, useSyncExternalStore } from "react"
import { Check, Circle, CircleDot, Pencil, Plus, Trash2 } from "lucide-react"
import type { DesktopTodoWriteInput, DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"
import { useText } from "../design/i18n.ts"
import { useSettingsDraftMap } from "../settings/settings-drafts.tsx"
import { TodoEditorStore, type TodoDraft } from "./todo-drafts.ts"
import "./TodoSection.css"

type TodoItem = NonNullable<DesktopWorkStateView["todos"]>[number]

interface TodoSectionProps {
  workspaceId?: string
  sessionId?: string
  workState?: DesktopWorkStateView
  error?: string
  onRetry?(): void
  onWrite?(input: DesktopTodoWriteInput): Promise<void>
}

const TODO_PAGE_SIZE = 8
const copyItems = (items: TodoItem[]) => items.map((item) => ({ ...item }))

/** Compact status markers and completed/total progress follow the inspected
 * DSH TodoPanel and ZCode Todo renderer. This editor uses the local snapshot
 * contract; no reference implementation source is copied. */
export function TodoSection({ workspaceId, sessionId, workState, error, onRetry, onWrite }: TodoSectionProps) {
  const t = useText()
  const states = useSettingsDraftMap<TodoEditorStore>(["todos", workspaceId ?? "local", sessionId ?? "local"])
  if (!states.has("editor")) states.set("editor", new TodoEditorStore())
  const store = states.get("editor")!
  const { pageOverride, draft, saving, error: writeError } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const setPageOverride = (pageOverride: number | null) => store.update({ pageOverride })
  const setDraft = (draft: TodoDraft | null) => store.update({ draft })
  const setWriteError = (error: string | undefined) => store.update({ error })
  const composing = useRef(false), endedComposition = useRef(false), editId = useId()
  const todos = workState?.todos
  const revision = workState?.todosRevision
  const editable = todos !== undefined && revision !== undefined && onWrite !== undefined && !error
  const staleDraft = draft !== null && draft.expectedRevision !== revision && !saving
  const snapshotIdentity = JSON.stringify([revision, todos])
  useEffect(() => { if (todos !== undefined && store.getSnapshot().snapshotIdentity !== snapshotIdentity) store.update({ snapshotIdentity, pageOverride: null }) }, [store, snapshotIdentity, todos === undefined])
  const focusIndex = todos?.findIndex((item) => item.status === "in_progress") ?? -1
  const firstUnfinished = todos?.findIndex((item) => item.status !== "completed") ?? -1
  const defaultPage = todos && todos.length > 0 ? Math.floor((focusIndex >= 0 ? focusIndex : firstUnfinished >= 0 ? firstUnfinished : todos.length - 1) / TODO_PAGE_SIZE) : 0
  const pageCount = todos ? Math.ceil(todos.length / TODO_PAGE_SIZE) : 0
  const page = Math.max(0, Math.min(pageOverride ?? defaultPage, Math.max(0, pageCount - 1)))
  const completed = todos?.filter((item) => item.status === "completed").length ?? 0
  const statusLabel = (status: TodoItem["status"]) => t(status === "completed" ? "已完成" : status === "in_progress" ? "進行中" : "待開始")

  function beginEdit(index: number | null) {
    if (!editable || store.getSnapshot().saving) return
    setWriteError(undefined)
    setDraft({ items: copyItems(todos ?? []), expectedRevision: revision!, index, content: index === null ? "" : todos![index]!.content })
  }

  async function write(input: DesktopTodoWriteInput, closeDraft = false) {
    if (!onWrite || store.getSnapshot().saving) return
    const submitted = store.getSnapshot().draft
    store.update({ saving: true })
    setWriteError(undefined)
    try {
      await onWrite(input)
      if (closeDraft && store.getSnapshot().draft === submitted) setDraft(null)
    } catch (reason) {
      setWriteError(reason instanceof Error ? reason.message : t("無法儲存待辦。"))
    } finally {
      store.update({ saving: false })
    }
  }

  function saveDraft() {
    if (!draft || staleDraft || !editable) return
    const content = draft.content.trim()
    if (!content) return
    if (draft.items.some((item, index) => index !== draft.index && item.content === content)) {
      setWriteError(t("待辦內容不可重複。"))
      return
    }
    const items = copyItems(draft.items)
    if (draft.index === null) items.push({ content, status: "pending" })
    else items[draft.index] = { ...items[draft.index]!, content }
    void write({ items, expectedRevision: draft.expectedRevision }, true)
  }

  function changeStatus(index: number, status: TodoItem["status"]) {
    if (!editable || draft || store.getSnapshot().saving) return
    const items = copyItems(todos ?? []).map((item, itemIndex) => ({ ...item, status: itemIndex === index ? status : status === "in_progress" && item.status === "in_progress" ? "pending" as const : item.status }))
    void write({ items, expectedRevision: revision! })
  }

  return <div className="todo-section">
    <div className="todo-heading">
      <h4>{t("待辦")}</h4>
      {todos && todos.length > 0 ? <span>{t("已完成 {count}/{total}", { count: completed, total: todos.length })}</span> : null}
      {editable ? <button type="button" className="todo-add-button" disabled={saving || draft !== null} onClick={() => beginEdit(null)}><Plus size={14} aria-hidden="true" />{t("新增待辦")}</button> : null}
    </div>
    {error ? <p role="alert" className="notice error-text">{error}{onRetry ? <button type="button" className="link-button" onClick={onRetry}>{t("重試")}</button> : null}</p> : null}
    {todos === undefined ? error ? null : <p className="muted">{t("正在載入待辦…")}</p>
      : todos === null ? <p className="muted">{t("尚未建立待辦清單")}</p>
        : todos.length === 0 ? <p className="muted">{t("待辦清單已清空")}</p>
          : <><ul className="todo-list">{todos.slice(page * TODO_PAGE_SIZE, (page + 1) * TODO_PAGE_SIZE).map((item, offset) => {
            const index = page * TODO_PAGE_SIZE + offset
            return <li key={`${index}:${item.content}`} className={`todo-row${editable ? " todo-row-editable" : ""}`} data-status={item.status} aria-label={`${item.content} · ${statusLabel(item.status)}`}>
              {item.status === "completed" ? <Check size={15} aria-hidden="true" /> : item.status === "in_progress" ? <CircleDot size={15} aria-hidden="true" /> : <Circle size={15} aria-hidden="true" />}
              <span className="todo-item-content">{item.content}</span>
              {editable ? <div className="todo-row-actions">
                <select aria-label={t("{content} 的狀態", { content: item.content })} value={item.status} disabled={saving || draft !== null} onChange={(event) => changeStatus(index, event.target.value as TodoItem["status"])}>
                  <option value="pending">{t("待開始")}</option><option value="in_progress">{t("進行中")}</option><option value="completed">{t("已完成")}</option>
                </select>
                <button type="button" aria-label={t("編輯待辦 {content}", { content: item.content })} title={t("編輯待辦 {content}", { content: item.content })} disabled={saving || draft !== null} onClick={() => beginEdit(index)}><Pencil size={13} aria-hidden="true" /></button>
                <button type="button" aria-label={t("刪除待辦 {content}", { content: item.content })} title={t("刪除待辦 {content}", { content: item.content })} disabled={saving || draft !== null} onClick={() => { void write({ items: copyItems(todos).filter((_item, itemIndex) => itemIndex !== index), expectedRevision: revision! }) }}><Trash2 size={13} aria-hidden="true" /></button>
              </div> : null}
            </li>
          })}</ul>
            {pageCount > 1 ? <div className="todo-pager"><button type="button" className="link-button" disabled={page === 0} onClick={() => setPageOverride(page - 1)}>{t("上一頁")}</button><span>{t("第 {page} / {total} 頁", { page: page + 1, total: pageCount })}</span><button type="button" className="link-button" disabled={page + 1 >= pageCount} onClick={() => setPageOverride(page + 1)}>{t("下一頁")}</button></div> : null}</>}
    {draft ? <form className="todo-edit-form" onSubmit={(event) => { event.preventDefault(); saveDraft() }}>
      <label htmlFor={editId}>{t("待辦內容")}</label>
      <input id={editId} className="todo-edit-input" autoFocus value={draft.content} placeholder={t("有哪些待辦事項？")} disabled={saving} onChange={(event) => setDraft({ ...draft, content: event.target.value })}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; endedComposition.current = true }} onKeyUp={() => { endedComposition.current = false }}
        onKeyDown={(event) => { const guarded = composing.current || endedComposition.current || event.nativeEvent.isComposing || event.keyCode === 229; endedComposition.current = false; if (guarded) { if (event.key === "Enter") event.preventDefault(); return } if (event.key === "Escape" && !saving) { event.preventDefault(); setDraft(null); setWriteError(undefined) } }} />
      <div className="todo-edit-actions"><button type="submit" className="todo-save-button" disabled={saving || staleDraft || !editable || !draft.content.trim()}>{saving ? t("儲存中…") : t("儲存待辦")}</button><button type="button" className="link-button" disabled={saving} onClick={() => { setDraft(null); setWriteError(undefined) }}>{t("取消編輯")}</button></div>
    </form> : null}
    {staleDraft || writeError ? <p role="alert" className="notice error-text">{staleDraft ? t("待辦清單已變更。請取消編輯後重試。") : writeError}</p> : null}
  </div>
}
