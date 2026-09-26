import type { SessionDashboardResult } from "@i-harness/sdk"
import { useText } from "../design/i18n.ts"

export interface TaskListProps {
  dashboard: SessionDashboardResult
  selectedId?: string
  onSelect(sessionId: string): void
}

/** Sessions with only the fields the host actually reported — never invented. */
export function TaskList({ dashboard, selectedId, onSelect }: TaskListProps) {
  const t = useText()
  if (dashboard.listingUnavailable === true) {
    return <p className="notice">{t("無法取得會話列表")}</p>
  }
  if (dashboard.sessions.length === 0) {
    return <p className="notice">{t("尚無會話")}</p>
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
            <span className="row-label">{row.title ?? t("未命名會話")}</span>
            <span className="row-meta">
              {row.running === true ? t("執行中") : ""}
              {row.updatedAt === undefined ? "" : ` · ${t("最後活動")} ${new Date(row.updatedAt).toLocaleString()}`}
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
