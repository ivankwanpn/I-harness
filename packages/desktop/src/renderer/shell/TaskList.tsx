import type { SessionDashboardResult } from "@i-harness/sdk"
import { useText } from "../design/i18n.ts"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { MoreHorizontal, Pin } from "lucide-react"
import { SessionActions, type SessionAction, type SessionNavigation } from "./SessionActions.tsx"

/** A project list uses an opaque UI row key; native calls keep this source. */
export interface TaskRowScope { workspaceId: string; sessionId: string; projectId?: string }

export interface TaskListProps {
  dashboard: SessionDashboardResult
  selectedId?: string
  attentionCounts?: Record<string, number>
  workspaceId?: string
  rowScopes?: Record<string, TaskRowScope>
  navigation?: Record<string, SessionNavigation>
  onManage?(sessionId: string, action: SessionAction, title?: string, scope?: TaskRowScope): Promise<void>
  onCopyId?(sessionId: string, scope?: TaskRowScope): Promise<void>
  onOpenFolder?(scope?: TaskRowScope): Promise<void>
  onManageArchived?(): void
  onManageSessions?(sessionId?: string, scope?: TaskRowScope): void
  showBatchManagement?: boolean
  onSelect(sessionId: string, scope?: TaskRowScope): void
  filter?: string
}

/** Sessions with only the fields the host actually reported — never invented. */
export function TaskList({ dashboard, selectedId, onSelect, attentionCounts, workspaceId, rowScopes, navigation, onManage, onCopyId, onOpenFolder, onManageArchived, onManageSessions, showBatchManagement = true, filter }: TaskListProps) {
  const t = useText()
  const [menu, setMenu] = useState<{ id: string; workspaceId?: string; source?: TaskRowScope; x: number; y: number; element: HTMLElement }>()
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const locks = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const actionKey = (id: string) => JSON.stringify([rowScopes?.[id]?.workspaceId ?? workspaceId, rowScopes?.[id]?.sessionId ?? id])
  async function guarded(id: string, action: () => Promise<void>): Promise<void> {
    const key = actionKey(id)
    if (locks.current.has(key)) throw new Error("Session action is already in progress")
    locks.current.add(key); setBusy((current) => ({ ...current, [key]: true }))
    try { await action() }
    finally { locks.current.delete(key); if (mounted.current) setBusy((current) => ({ ...current, [key]: false })) }
  }
  useLayoutEffect(() => { setMenu(undefined) }, [workspaceId, selectedId])
  const active = menu?.workspaceId === workspaceId ? dashboard.sessions.find((row) => row.id === menu?.id
    && rowScopes?.[row.id]?.workspaceId === menu.source?.workspaceId && rowScopes?.[row.id]?.sessionId === menu.source?.sessionId
    && rowScopes?.[row.id]?.projectId === menu.source?.projectId) : undefined
  const activeScope = active ? rowScopes?.[active.id] : undefined
  const canManage = !!(onManage || onCopyId || onOpenFolder || onManageSessions)
  const showMenu = (id: string, element: HTMLElement, point?: { x: number; y: number }) => {
    if (!canManage || locks.current.has(actionKey(id))) return
    const rect = element.getBoundingClientRect()
    setMenu({ id, workspaceId, source: rowScopes?.[id], element, x: point?.x ?? rect.left, y: point?.y ?? rect.bottom })
  }
  if (dashboard.listingUnavailable === true) {
    return <p className="notice">{t("無法取得會話列表")}</p>
  }
  const needle = filter?.trim().toLowerCase() ?? ""
  const visibleSessions = needle ? dashboard.sessions.filter(row => (row.title ?? "").toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle)) : dashboard.sessions
  if (dashboard.sessions.length === 0) {
    return <><p className="notice">{t("尚無會話")}</p>{onManageArchived ? <button type="button" className="session-archived-button" onClick={onManageArchived}>{t("管理已封存會話")}</button> : null}</>
  }
  if (visibleSessions.length === 0) return <p className="notice">{t("沒有符合的會話")}</p>
  const ordered = [...visibleSessions].sort((a, b) => Number(navigation?.[b.id]?.pinned === true) - Number(navigation?.[a.id]?.pinned === true) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return (
    <>{onManageSessions && showBatchManagement ? <button type="button" className="session-archived-button" onClick={() => onManageSessions()}>{t("批次管理會話")}</button> : null}<ul className="session-list">
      {ordered.map(row => {
        const metadata = navigation?.[row.id]
        const title = row.title ?? t("未命名會話")
        const count = attentionCounts?.[row.id] ?? 0
        const attention = count > 0 ? `${t("待人處理")} · ${count}` : undefined
        return <li key={row.id} className="session-list-row" onContextMenu={(event) => { if (canManage) { event.preventDefault(); const element = event.currentTarget.querySelector<HTMLButtonElement>(".row-button")!; showMenu(row.id, element, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined) } }}>
          <button
            type="button"
            className="row-button"
            aria-current={row.id === selectedId ? "true" : undefined}
            onClick={() => { const scope = rowScopes?.[row.id]; if (scope) onSelect(scope.sessionId, scope); else onSelect(row.id) }}
            onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); showMenu(row.id, event.currentTarget) } }}
          >
            <span className="row-title">
              {metadata?.unread ? <span role="img" className="session-unread-dot" aria-label={t("未讀")} title={t("未讀")} /> : null}
              {metadata?.pinned ? <Pin size={12} role="img" aria-label={t("已釘選")} /> : null}
              <span className="row-label" title={title}>{title}</span>
            </span>
            {row.running ? <span role="img" className="session-running-indicator" aria-label={t("執行中")} title={t("執行中")} /> : null}
            {attention ? <span role="img" className="attention-badge" aria-label={attention} title={attention}>{count}</span> : null}
          </button>
          {canManage ? <button type="button" className="session-row-more" disabled={busy[actionKey(row.id)] === true} aria-label={t("更多會話操作 {title}", { title })} aria-haspopup="menu" aria-expanded={active?.id === row.id} onClick={(event) => { if (active?.id === row.id) setMenu(undefined); else showMenu(row.id, event.currentTarget) }}><MoreHorizontal size={16} /></button> : null}
        </li>
      })}
    </ul>
    {onManageArchived ? <button type="button" className="session-archived-button" onClick={onManageArchived}>{t("管理已封存會話")}</button> : null}
    {active && menu ? <SessionActions key={JSON.stringify([activeScope?.workspaceId ?? workspaceId, activeScope?.sessionId ?? active.id])} session={activeScope ? { ...active, id: activeScope.sessionId, pending: attentionCounts?.[active.id] ?? 0 } : { ...active, pending: attentionCounts?.[active.id] ?? 0 }} navigation={navigation?.[active.id]} anchor={menu}
      onManage={onManage ? (id, action, title) => guarded(active.id, () => activeScope ? onManage(id, action, title, activeScope) : onManage(id, action, title)) : undefined}
      onCopyId={onCopyId ? (id) => guarded(active.id, () => activeScope ? onCopyId(id, activeScope) : onCopyId(id)) : undefined}
      onOpenFolder={onOpenFolder ? () => guarded(active.id, () => activeScope ? onOpenFolder(activeScope) : onOpenFolder()) : undefined}
      onManageSession={onManageSessions ? id => { if (activeScope) onManageSessions(id, activeScope); else onManageSessions(id) } : undefined}
      onClose={() => setMenu(undefined)} /> : null}
    </>
  )
}
