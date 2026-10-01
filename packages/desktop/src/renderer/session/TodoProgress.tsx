import type { DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"
import { useEffect, useId, useState } from "react"
import { ArrowRight, Circle, CircleCheck, ListTodo, Maximize2 } from "lucide-react"
import { useText } from "../design/i18n.ts"
import "./TodoProgress.css"
export interface TodoProgressProps {
  todos?: DesktopWorkStateView["todos"]
  error?: string
  onOpenTasks(): void
}

const PAGE_SIZE = 8

/** Own markup inspired by the supplied ZCode progress card. This is a view of
 * the host's current Todo snapshot; editing stays in the existing TaskPane. */
export function TodoProgress({ todos, error, onOpenTasks }: TodoProgressProps) {
  const t = useText()
  const listId = useId()
  const [expanded, setExpanded] = useState(true)
  const [pageOverride, setPageOverride] = useState<number | null>(null)
  useEffect(() => setPageOverride(null), [todos])
  if (error !== undefined || !todos?.length) return null

  const completed = todos.filter((item) => item.status === "completed").length
  const activeIndex = todos.findIndex((item) => item.status === "in_progress")
  const firstUnfinished = todos.findIndex((item) => item.status !== "completed")
  const focusIndex = activeIndex >= 0 ? activeIndex : firstUnfinished >= 0 ? firstUnfinished : todos.length - 1
  const pages = Math.ceil(todos.length / PAGE_SIZE)
  const page = Math.min(pageOverride ?? Math.floor(focusIndex / PAGE_SIZE), pages - 1)
  const statusLabel = (status: (typeof todos)[number]["status"]) => t(status === "completed" ? "已完成" : status === "in_progress" ? "進行中" : "待開始")

  return <section className="todo-progress-dock" aria-label={t("待辦進度")} data-complete={completed === todos.length}>
    <header className="todo-progress-header">
      <h3>{t("待辦進度")}</h3>
      <span className="todo-progress-count" aria-live="polite" aria-atomic="true" aria-label={t("已完成 {count}/{total}", { count: completed, total: todos.length })}>{completed}/{todos.length}</span>
      <div className="todo-progress-actions">
        <button type="button" aria-label={t(expanded ? "收合待辦清單" : "展開待辦清單")} title={t(expanded ? "收合待辦清單" : "展開待辦清單")} aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}><ListTodo size={14} aria-hidden="true" /></button>
        <button type="button" aria-label={t("開啟待辦編輯")} title={t("開啟待辦編輯")} onClick={onOpenTasks}><Maximize2 size={13} aria-hidden="true" /></button>
      </div>
    </header>
    {expanded ? <div id={listId} className="todo-progress-body">
      <ul className="todo-progress-list">{todos.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item, offset) => <li key={`${page * PAGE_SIZE + offset}:${item.content}`} data-status={item.status} aria-current={item.status === "in_progress" ? "step" : undefined} aria-label={`${item.content} · ${statusLabel(item.status)}`}>
        {item.status === "completed" ? <CircleCheck size={14} aria-hidden="true" /> : item.status === "in_progress" ? <ArrowRight size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
        {item.status === "completed" ? <s>{item.content}</s> : <span>{item.content}</span>}
      </li>)}</ul>
      {pages > 1 ? <div className="todo-progress-pager">
        <button type="button" disabled={page === 0} onClick={() => setPageOverride(page - 1)}>{t("上一頁")}</button>
        <span>{t("第 {page} / {total} 頁", { page: page + 1, total: pages })}</span>
        <button type="button" disabled={page + 1 === pages} onClick={() => setPageOverride(page + 1)}>{t("下一頁")}</button>
      </div> : null}
    </div> : null}
  </section>
}
