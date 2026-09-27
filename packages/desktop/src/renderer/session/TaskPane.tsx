import { useEffect, useState } from "react"
import { Check, Circle, CircleDot } from "lucide-react"
import type { AgentTaskView, SessionQueueItem } from "@i-harness/sdk"
import type { DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"
import { useText, type Message } from "../design/i18n.ts"

export interface TaskPaneProps {
  queue?: SessionQueueItem[]
  tasks?: AgentTaskView[]
  error?: string
  workStateEnabled?: boolean
  workState?: DesktopWorkStateView
  workStateError?: string
  onRetryWorkState?(): void
  onCancelTask?(taskId: string): void
  onCancelQueue?(queueId: string): void
}

/** Queue/task state straight from the host: absent stays unknown, an empty
 * task list is "nothing to confirm" — never "everything finished". */
const TODO_PAGE_SIZE = 8

export function TaskPane({ queue, tasks, error, workStateEnabled = false, workState, workStateError, onRetryWorkState, onCancelTask, onCancelQueue }: TaskPaneProps) {
  const t = useText()
  const statuses: Record<string, Message> = { running: "執行中", queued: "等候中", completed: "已完成", failed: "已失敗", cancelled: "已取消" }
  const [pageOverride, setPageOverride] = useState<number | null>(null)
  const todos = workState?.todos
  useEffect(() => setPageOverride(null), [todos])
  const focusIndex = todos?.findIndex((item) => item.status === "in_progress") ?? -1
  const firstUnfinished = todos?.findIndex((item) => item.status !== "completed") ?? -1
  const defaultPage = todos && todos.length > 0 ? Math.floor((focusIndex >= 0 ? focusIndex : firstUnfinished >= 0 ? firstUnfinished : todos.length - 1) / TODO_PAGE_SIZE) : 0
  const pageCount = todos ? Math.ceil(todos.length / TODO_PAGE_SIZE) : 0
  const page = Math.max(0, Math.min(pageOverride ?? defaultPage, Math.max(0, pageCount - 1)))
  const visibleTodos = todos?.slice(page * TODO_PAGE_SIZE, (page + 1) * TODO_PAGE_SIZE)
  const completed = todos?.filter((item) => item.status === "completed").length ?? 0
  return (
    <section className="task-pane" aria-label={t("任務")}>
      <h3 className="review-title">{t("任務")}</h3>
      {error === undefined ? null : <p className="notice error-text">{error}</p>}
      {workStateEnabled ? <div className="todo-section">
        <div className="todo-heading"><h4>{t("待辦")}</h4>{todos && todos.length > 0 ? <span>{t("已完成 {count}/{total}", { count: completed, total: todos.length })}</span> : null}</div>
        {workStateError ? <p role="alert" className="notice error-text">{workStateError}{onRetryWorkState ? <button type="button" className="link-button" onClick={onRetryWorkState}>{t("重試")}</button> : null}</p> : null}
        {todos === undefined ? workStateError ? null : <p className="muted">{t("正在載入待辦…")}</p>
          : todos === null ? <p className="muted">{t("尚未建立待辦清單")}</p>
            : todos.length === 0 ? <p className="muted">{t("待辦清單已清空")}</p>
              : <><ul className="todo-list">{visibleTodos?.map((item, index) => <li key={`${page * TODO_PAGE_SIZE + index}:${item.content}`} className="todo-row" data-status={item.status} aria-label={`${item.content} · ${t(item.status === "completed" ? "已完成" : item.status === "in_progress" ? "進行中" : "待開始")}`}>
                {item.status === "completed" ? <Check size={15} aria-hidden="true" /> : item.status === "in_progress" ? <CircleDot size={15} aria-hidden="true" /> : <Circle size={15} aria-hidden="true" />}
                <span>{item.content}</span>
              </li>)}</ul>
                {pageCount > 1 ? <div className="todo-pager"><button type="button" className="link-button" disabled={page === 0} onClick={() => setPageOverride(page - 1)}>{t("上一頁")}</button><span>{t("第 {page} / {total} 頁", { page: page + 1, total: pageCount })}</span><button type="button" className="link-button" disabled={page + 1 >= pageCount} onClick={() => setPageOverride(page + 1)}>{t("下一頁")}</button></div> : null}</>}
      </div> : null}
      {queue === undefined
        ? <p className="muted">{t("佇列狀態未知")}</p>
        : queue.length === 0
          ? <p className="muted">{t("佇列為空")}</p>
          : (
            <ul className="task-list">
              {queue.map((row) => (
                <li key={row.id} className="task-row">
                  <span className="row-label">{row.text}</span>
                  <span className="row-meta">
                    {t(row.state === "running" ? "執行中" : "等候中")}
                    {onCancelQueue === undefined || row.state !== "queued" ? null : (
                      <button type="button" className="link-button" onClick={() => onCancelQueue(row.id)}>{t("取消")}</button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
      {tasks === undefined
        ? <p className="muted">{t("任務狀態未知")}</p>
        : tasks.length === 0
          ? <p className="muted">{t("暫無可確認的任務")}</p>
          : (
            <ul className="task-list">
              {tasks.map((task) => (
                <li key={task.id} className="task-row">
                  <span className="row-label">{task.label}</span>
                  <span className="row-meta">
                    {statuses[task.status] ? t(statuses[task.status]!) : task.status}
                    {task.canCancel && onCancelTask !== undefined ? (
                      <button type="button" className="link-button" onClick={() => onCancelTask(task.id)}>{t("取消")}</button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
    </section>
  )
}
