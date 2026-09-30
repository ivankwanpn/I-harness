import type { SessionDashboardResult } from "@i-harness/sdk"
import { useLocale, useText } from "../design/i18n.ts"
import { relativeActivity } from "./relative-activity.ts"
import { useEffect, useRef, useState } from "react"
import { MoreHorizontal, Pin } from "lucide-react"
import { SessionActions, type SessionAction, type SessionNavigation } from "./SessionActions.tsx"

export interface TaskListProps {
  dashboard: SessionDashboardResult
  selectedId?: string
  attentionCounts?: Record<string, number>
  workspaceId?: string
  navigation?: Record<string, SessionNavigation>
  onManage?(sessionId: string, action: SessionAction, title?: string): Promise<void>
  onCopyId?(sessionId: string): Promise<void>
  onOpenFolder?(): Promise<void>
  onManageArchived?(): void
  onSelect(sessionId: string): void
}

/** Sessions with only the fields the host actually reported — never invented. */
export function TaskList({ dashboard, selectedId, onSelect, attentionCounts, workspaceId, navigation, onManage, onCopyId, onOpenFolder, onManageArchived }: TaskListProps) {
  const t = useText()
  const locale = useLocale((state) => state.locale)
  const [menu, setMenu] = useState<{ id: string; workspaceId?: string; x: number; y: number; element: HTMLElement }>()
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const locks = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const actionKey = (id: string) => JSON.stringify([workspaceId, id])
  async function guarded(id: string, action: () => Promise<void>): Promise<void> {
    const key = actionKey(id)
    if (locks.current.has(key)) throw new Error("Session action is already in progress")
    locks.current.add(key); setBusy((current) => ({ ...current, [key]: true }))
    try { await action() }
    finally { locks.current.delete(key); if (mounted.current) setBusy((current) => ({ ...current, [key]: false })) }
  }
  useEffect(() => { setMenu(undefined) }, [workspaceId, selectedId])
  const active = menu?.workspaceId === workspaceId ? dashboard.sessions.find((row) => row.id === menu?.id) : undefined
  const canManage = !!(onManage || onCopyId || onOpenFolder)
  const showMenu = (id: string, element: HTMLElement, point?: { x: number; y: number }) => {
    if (!canManage || locks.current.has(actionKey(id))) return
    const rect = element.getBoundingClientRect()
    setMenu({ id, workspaceId, element, x: point?.x ?? rect.left, y: point?.y ?? rect.bottom })
  }
  if (dashboard.listingUnavailable === true) {
    return <p className="notice">{t("無法取得會話列表")}</p>
  }
  if (dashboard.sessions.length === 0) {
    return <><p className="notice">{t("尚無會話")}</p>{onManageArchived ? <button type="button" className="session-archived-button" onClick={onManageArchived}>{t("管理已封存會話")}</button> : null}</>
  }
  return (
    <><ul className="session-list">
      {[...dashboard.sessions].sort((a, b) => Number(navigation?.[b.id]?.pinned === true) - Number(navigation?.[a.id]?.pinned === true)).map((row) => (
        <li key={row.id} className="session-list-row" onContextMenu={(event) => { if (canManage) { event.preventDefault(); const element = event.currentTarget.querySelector<HTMLButtonElement>(".row-button")!; showMenu(row.id, element, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined) } }}>
          <button
            type="button"
            className="row-button"
            aria-current={row.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(row.id)}
            onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); showMenu(row.id, event.currentTarget) } }}
          >
            <span className="row-title">{navigation?.[row.id]?.unread ? <span className="session-unread-dot" aria-label={t("未讀")} /> : null}{navigation?.[row.id]?.pinned ? <Pin size={12} aria-label={t("已釘選")} /> : null}<span className="row-label">{row.title ?? t("未命名會話")}</span></span>
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
          {canManage ? <button type="button" className="session-row-more" disabled={busy[actionKey(row.id)] === true} aria-label={t("更多會話操作 {title}", { title: row.title ?? t("未命名會話") })} aria-haspopup="menu" aria-expanded={active?.id === row.id} onClick={(event) => { if (active?.id === row.id) setMenu(undefined); else showMenu(row.id, event.currentTarget) }}><MoreHorizontal size={16} /></button> : null}
        </li>
      ))}
    </ul>
    {onManageArchived ? <button type="button" className="session-archived-button" onClick={onManageArchived}>{t("管理已封存會話")}</button> : null}
    {active && menu ? <SessionActions key={`${workspaceId}:${active.id}`} session={active} navigation={navigation?.[active.id]} anchor={menu}
      onManage={onManage ? (id, action, title) => guarded(id, () => onManage(id, action, title)) : undefined}
      onCopyId={onCopyId ? (id) => guarded(id, () => onCopyId(id)) : undefined}
      onOpenFolder={onOpenFolder ? () => guarded(active.id, onOpenFolder) : undefined}
      onClose={() => setMenu(undefined)} /> : null}
    </>
  )
}
