import type { AgentTaskView, SessionQueueItem } from "@i-harness/sdk"
import { useText, type Message } from "../design/i18n.ts"

export interface TaskPaneProps {
  queue?: SessionQueueItem[]
  tasks?: AgentTaskView[]
  error?: string
  onCancelTask?(taskId: string): void
  onCancelQueue?(queueId: string): void
}

/** Queue/task state straight from the host: absent stays unknown, an empty
 * task list is "nothing to confirm" — never "everything finished". */
export function TaskPane({ queue, tasks, error, onCancelTask, onCancelQueue }: TaskPaneProps) {
  const t = useText()
  const statuses: Record<string, Message> = { running: "執行中", queued: "等候中", completed: "已完成", failed: "已失敗", cancelled: "已取消" }
  return (
    <section className="task-pane" aria-label={t("任務")}>
      <h3 className="review-title">{t("任務")}</h3>
      {error === undefined ? null : <p className="notice error-text">{error}</p>}
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
