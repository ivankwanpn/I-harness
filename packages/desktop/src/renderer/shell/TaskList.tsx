import type { SessionDashboardResult } from "@i-harness/sdk"
import { useLocale, useText } from "../design/i18n.ts"
import { relativeActivity } from "./relative-activity.ts"

export interface TaskListProps {
  dashboard: SessionDashboardResult
  selectedId?: string
  attentionCounts?: Record<string, number>
  onSelect(sessionId: string): void
}

/** Sessions with only the fields the host actually reported — never invented. */
export function TaskList({ dashboard, selectedId, onSelect, attentionCounts }: TaskListProps) {
  const t = useText()
  const locale = useLocale((state) => state.locale)
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
            {(attentionCounts?.[row.id] ?? 0) > 0 ? <span className="attention-badge">{t("待人處理")} · {attentionCounts![row.id]}</span> : null}
            <span className="row-meta">
              {row.running === true ? t("執行中") : ""}
              {row.updatedAt === undefined ? "" : ` · ${t("最後活動")} ${relativeActivity(row.updatedAt, locale)}`}
              {row.turnCount === undefined ? "" : ` · ${row.turnCount} ${t("回合")}`}
              {row.queued === undefined || row.queued === 0 ? "" : ` · ${t("佇列")} ${row.queued}`}
              {row.tasks === undefined || row.tasks === 0 ? "" : ` · ${t("任務")} ${row.tasks}`}
              {row.modelLabel === undefined ? "" : ` · ${row.modelLabel}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
