import type { DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"
import { ChevronRight, ListTodo } from "lucide-react"
import { useText } from "../design/i18n.ts"
import "./TodoProgress.css"

export interface TodoProgressProps {
  todos?: DesktopWorkStateView["todos"]
  error?: string
  onOpenTasks(): void
}

/** The Work pane owns the full list, including completed items. */
export function TodoProgress({ todos, error, onOpenTasks }: TodoProgressProps) {
  const t = useText()
  if (error !== undefined || !todos?.length) return null
  const current = todos.find(item => item.status === "in_progress") ?? todos.find(item => item.status !== "completed")
  if (!current) return null
  const completed = todos.filter(item => item.status === "completed").length
  const name = t("待辦進度")
  return <button type="button" className="todo-progress-summary" title={current.content} onClick={onOpenTasks}
    aria-label={`${name} · ${t("已完成 {count}/{total}", { count: completed, total: todos.length })} · ${current.content}`}>
    <ListTodo size={15} aria-hidden="true" />
    <span className="todo-progress-count">{completed}/{todos.length}</span>
    <span className="todo-progress-current">{current.content}</span>
    <ChevronRight size={14} aria-hidden="true" />
  </button>
}
