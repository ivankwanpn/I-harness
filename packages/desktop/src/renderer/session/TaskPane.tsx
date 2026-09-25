import type { AgentTaskView, SessionQueueItem } from "@i-harness/sdk"

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
  return (
    <section className="task-pane" aria-label="任務">
      <h3 className="review-title">任務</h3>
      {error === undefined ? null : <p className="notice error-text">{error}</p>}
      {queue === undefined
        ? <p className="muted">佇列狀態未知</p>
        : queue.length === 0
          ? <p className="muted">佇列為空</p>
          : (
            <ul className="task-list">
              {queue.map((row) => (
                <li key={row.id} className="task-row">
                  <span className="row-label">{row.text}</span>
                  <span className="row-meta">
                    {row.state === "running" ? "執行中" : "等候中"}
                    {onCancelQueue === undefined || row.state !== "queued" ? null : (
                      <button type="button" className="link-button" onClick={() => onCancelQueue(row.id)}>取消</button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
      {tasks === undefined
        ? <p className="muted">任務狀態未知</p>
        : tasks.length === 0
          ? <p className="muted">暫無可確認的任務</p>
          : (
            <ul className="task-list">
              {tasks.map((task) => (
                <li key={task.id} className="task-row">
                  <span className="row-label">{task.label}</span>
                  <span className="row-meta">
                    {task.status}
                    {task.canCancel && onCancelTask !== undefined ? (
                      <button type="button" className="link-button" onClick={() => onCancelTask(task.id)}>取消</button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
    </section>
  )
}
