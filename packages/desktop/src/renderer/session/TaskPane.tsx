import type { AgentTaskView, SessionQueueItem } from "@i-harness/sdk"
import type { DesktopTodoWriteInput, DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"
import { useText, type Message } from "../design/i18n.ts"
import { TodoSection } from "./TodoSection.tsx"
import { useRef } from "react"
import { SettingsDraftScope } from "../settings/settings-drafts.tsx"

export interface TaskPaneProps {
  draftOwner?: object
  workspaceId?: string
  sessionId?: string
  queue?: SessionQueueItem[]
  tasks?: AgentTaskView[]
  error?: string
  workStateEnabled?: boolean
  workState?: DesktopWorkStateView
  workStateError?: string
  onRetryWorkState?(): void
  onWriteTodos?(input: DesktopTodoWriteInput): Promise<void>
  onCancelTask?(taskId: string): void
  onCancelQueue?(queueId: string): void
  queueResumable?: boolean
  onResumeQueue?(): Promise<void>
}

/** Queue/task state straight from the host: absent stays unknown, an empty
 * task list is "nothing to confirm" — never "everything finished". */
export function TaskPane(props: TaskPaneProps) {
  const fallback = useRef({})
  return <SettingsDraftScope owner={props.draftOwner ?? fallback.current}><TaskPaneContent {...props} /></SettingsDraftScope>
}
function TaskPaneContent({ workspaceId, sessionId, queue, tasks, error, workStateEnabled = false, workState, workStateError, onRetryWorkState, onWriteTodos, onCancelTask, onCancelQueue, queueResumable, onResumeQueue }: TaskPaneProps) {
  const t = useText()
  const statuses: Record<string, Message> = { running: "執行中", queued: "等候中", completed: "已完成", failed: "已失敗", cancelled: "已取消" }
  return (
    <section className="task-pane" aria-label={t("任務")}>
      <h3 className="review-title">{t("任務")}</h3>
      {error === undefined ? null : <p role="alert" className="notice error-text">{error}</p>}
      {queueResumable && onResumeQueue ? <button type="button" className="link-button" onClick={() => { void onResumeQueue().catch(() => undefined) }}>{t("繼續佇列")}</button> : null}
      {workStateEnabled ? <TodoSection workspaceId={workspaceId} sessionId={sessionId} workState={workState} error={workStateError} onRetry={onRetryWorkState} onWrite={onWriteTodos} /> : null}
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
