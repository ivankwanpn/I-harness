import type { SessionDashboardResult } from "@i-harness/sdk"

export interface TaskListProps {
  dashboard: SessionDashboardResult
  selectedId?: string
  onSelect(sessionId: string): void
}

/** Sessions with only the fields the host actually reported — never invented. */
export function TaskList({ dashboard, selectedId, onSelect }: TaskListProps) {
  if (dashboard.listingUnavailable === true) {
    return <p className="notice">無法取得會話列表</p>
  }
  if (dashboard.sessions.length === 0) {
    return <p className="notice">尚無會話</p>
  }
  return (
    <ul className="session-list">
      {dashboard.sessions.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            className="row-button"
            aria-current={row.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(row.id)}
          >
            <span className="row-label">{row.title ?? row.id}</span>
            <span className="row-id">{row.id}</span>
            <span className="row-meta">
              {row.running === true ? "執行中" : row.live ? "已載入" : "未載入"}
              {row.turnCount === undefined ? "" : ` · ${row.turnCount} 回合`}
              {row.queued === undefined || row.queued === 0 ? "" : ` · 佇列 ${row.queued}`}
              {row.tasks === undefined || row.tasks === 0 ? "" : ` · 任務 ${row.tasks}`}
              {row.modelLabel === undefined ? "" : ` · ${row.modelLabel}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
