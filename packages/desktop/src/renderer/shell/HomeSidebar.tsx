import type { DashboardSessionRow, SessionDashboardResult } from "@i-harness/sdk"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { ProjectEntry } from "../../main/projects.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useCallback, useEffect, useRef, useState } from "react"
import { FolderKanban, Pin, Plus, Search, X } from "lucide-react"
import { useLocale, useText } from "../design/i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { SearchInput } from "../vendor/zcode/SearchInput.tsx"
import { createRefreshScheduler } from "../session/refresh-scheduler.ts"
import { classifyNotification } from "../session/notifications.ts"
import { confirmedSessionNavigation, isSessionNavigationState, projectSessionKey, type ProjectSessionNavigation } from "./project-sessions.ts"
import { relativeActivity } from "./relative-activity.ts"
import "./home-sidebar.css"

export interface HomeSidebarProps {
  bridge: DesktopBridge
  revision?: number
  workspaces: WorkspaceEntry[]
  projects?: ProjectEntry[]
  selectedWorkspaceId?: string
  selectedSessionId?: string
  dashboard?: SessionDashboardResult
  canCreate: boolean
  onCreate(): void
  onSelectSession(workspaceId: string, sessionId: string, projectId?: string): void
  onProjects?(): void
  onManageSessions?(): void
  onManageArchived?(): void
  onClose(): void
}

interface HomeSnapshot {
  dashboard?: SessionDashboardResult
  navigation?: Record<string, ProjectSessionNavigation>
  pending?: boolean
  problem?: "dashboard" | "navigation" | "disconnected"
  error?: string
}
interface HomeCache { bridge: DesktopBridge; workspaceKey: string; snapshots: Record<string, HomeSnapshot> }

function confirmedDashboard(value: unknown): value is SessionDashboardResult {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as SessionDashboardResult).sessions)) return false
  return (value as SessionDashboardResult).sessions.every(row => row && typeof row === "object" && typeof row.id === "string" && row.id !== ""
    && typeof row.live === "boolean" && (row.title === undefined || typeof row.title === "string"))
}

export function HomeSidebar(props: HomeSidebarProps) {
  const { bridge, workspaces, projects = [], selectedWorkspaceId, selectedSessionId, dashboard } = props
  const t = useText()
  const locale = useLocale(state => state.locale)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [cache, setCache] = useState<HomeCache>()
  const workspaceKey = JSON.stringify(workspaces.map(row => [row.id, row.path]))
  const owner = useRef({ bridge, workspaceKey })
  const active = useRef(false), epoch = useRef(0), tickets = useRef<Record<string, number>>({})
  const supplied = useRef({ selectedWorkspaceId, dashboard })
  const lastRevision = useRef(props.revision)
  supplied.current = { selectedWorkspaceId, dashboard }
  if (owner.current.bridge !== bridge || owner.current.workspaceKey !== workspaceKey) {
    owner.current = { bridge, workspaceKey }
    epoch.current++
  }

  const update = useCallback((workspaceId: string, change: (current: HomeSnapshot | undefined) => HomeSnapshot) => {
    setCache(current => {
      const snapshots = current?.bridge === bridge && current.workspaceKey === workspaceKey ? current.snapshots : {}
      return { bridge, workspaceKey, snapshots: { ...snapshots, [workspaceId]: change(snapshots[workspaceId]) } }
    })
  }, [bridge, workspaceKey])

  const read = useCallback(async (workspaceId: string) => {
    if (!active.current || owner.current.bridge !== bridge || owner.current.workspaceKey !== workspaceKey) return
    const scope = epoch.current
    const ticket = tickets.current[workspaceId] = (tickets.current[workspaceId] ?? 0) + 1
    const parent = supplied.current.selectedWorkspaceId === workspaceId && confirmedDashboard(supplied.current.dashboard) ? supplied.current.dashboard : undefined
    update(workspaceId, current => ({ ...current, pending: true, problem: undefined, error: undefined }))
    const [sessions, navigation] = await Promise.allSettled([
      parent ? Promise.resolve(parent) : bridge.request({ kind: "session/dashboard", workspaceId }),
      bridge.request({ kind: "desktop/session/navigation/state", workspaceId }),
    ])
    if (!active.current || scope !== epoch.current || ticket !== tickets.current[workspaceId]) return
    const confirmed = navigation.status === "fulfilled" && isSessionNavigationState(navigation.value) ? navigation.value : undefined
    const loaded = sessions.status === "fulfilled" && confirmedDashboard(sessions.value) ? sessions.value : undefined
    const failed = [sessions, navigation].find(result => result.status === "rejected")
    update(workspaceId, current => {
      const latestParent = supplied.current.selectedWorkspaceId === workspaceId && confirmedDashboard(supplied.current.dashboard) ? supplied.current.dashboard : undefined
      const latest = parent ? latestParent ?? current?.dashboard ?? loaded : loaded
      return {
        dashboard: latest, navigation: confirmed, pending: false,
        ...(!latest ? { problem: "dashboard" as const } : !confirmed ? { problem: "navigation" as const } : {}),
        ...(failed?.status === "rejected" ? { error: failed.reason instanceof Error ? failed.reason.message : String(failed.reason) } : {}),
      }
    })
  }, [bridge, workspaceKey, update])

  useEffect(() => {
    active.current = true
    epoch.current++
    tickets.current = {}
    setCache({ bridge, workspaceKey, snapshots: {} })
    const ids = new Set(workspaces.map(row => row.id))
    const refreshers = new Map(workspaces.map(row => [row.id, createRefreshScheduler(() => read(row.id))]))
    const unsubscribe = bridge.onEvent(event => {
      if (!active.current || owner.current.bridge !== bridge || owner.current.workspaceKey !== workspaceKey || event.kind === "window/state" || !ids.has(event.workspaceId)) return
      if (event.kind === "sdk/disconnected") {
        tickets.current[event.workspaceId] = (tickets.current[event.workspaceId] ?? 0) + 1
        refreshers.get(event.workspaceId)?.dispose()
        refreshers.set(event.workspaceId, createRefreshScheduler(() => read(event.workspaceId)))
        update(event.workspaceId, current => ({ ...current, navigation: undefined, pending: false, problem: "disconnected", error: event.message }))
        return
      }
      const kind = classifyNotification(event.method, event.params).kind
      if (event.method === "desktop/session/navigation/changed" || kind === "durable" || kind === "status") refreshers.get(event.workspaceId)?.schedule()
    })
    void Promise.allSettled(workspaces.map(row => read(row.id)))
    return () => {
      active.current = false
      epoch.current++
      for (const refresh of refreshers.values()) refresh.dispose()
      unsubscribe()
    }
  }, [bridge, workspaceKey, read, update])

  useEffect(() => {
    if (!selectedWorkspaceId || !confirmedDashboard(dashboard) || !workspaces.some(row => row.id === selectedWorkspaceId)) return
    update(selectedWorkspaceId, current => ({ ...current, dashboard, ...(current?.problem === "dashboard" ? { problem: undefined, error: undefined } : {}) }))
  }, [selectedWorkspaceId, dashboard, bridge, workspaceKey, update])

  useEffect(() => {
    if (lastRevision.current === props.revision) return
    lastRevision.current = props.revision
    void Promise.allSettled(workspaces.map(row => read(row.id)))
  }, [props.revision, read, workspaceKey])

  const snapshots = cache?.bridge === bridge && cache.workspaceKey === workspaceKey ? { ...cache.snapshots } : {}
  if (selectedWorkspaceId && confirmedDashboard(dashboard) && workspaces.some(row => row.id === selectedWorkspaceId)) snapshots[selectedWorkspaceId] = { ...snapshots[selectedWorkspaceId], dashboard }
  const projectNames = new Map(projects.map(row => [row.id, row.name]))
  const problems: { workspace: WorkspaceEntry; message: string; pending: boolean }[] = []
  const rows: { key: string; workspaceId: string; session: DashboardSessionRow; navigation: ProjectSessionNavigation; projectName: string }[] = []
  for (const workspace of workspaces) {
    const snapshot = snapshots[workspace.id]
    if (!snapshot) continue
    if (snapshot.error || snapshot.problem || snapshot.dashboard?.listingUnavailable) {
      problems.push({ workspace, pending: snapshot.pending === true, message: snapshot.error || t(snapshot.problem === "navigation" ? "會話分組狀態無法確認" : "無法取得會話列表") })
      continue
    }
    if (!snapshot.dashboard || !snapshot.navigation) continue
    let ownershipUnavailable = false, projectUnavailable = false
    for (const session of snapshot.dashboard.sessions) {
      const navigation = Object.hasOwn(snapshot.navigation, session.id) ? snapshot.navigation[session.id] : undefined
      if (!confirmedSessionNavigation(navigation)) { ownershipUnavailable = true; continue }
      // A confirmed catalog can identify a removed owner. Keep its history
      // discoverable without changing the saved owner used for navigation.
      const projectName = navigation.projectId === undefined ? t("未分類會話")
        : projectNames.get(navigation.projectId) ?? (props.projects === undefined ? undefined : t("未分類會話"))
      if (projectName === undefined) { projectUnavailable = true; continue }
      rows.push({ key: projectSessionKey(workspace.id, session.id), workspaceId: workspace.id, session, navigation, projectName })
    }
    if (ownershipUnavailable || projectUnavailable) problems.push({ workspace, pending: snapshot.pending === true, message: t(ownershipUnavailable ? "會話分組狀態無法確認" : "會話所屬專案無法確認") })
  }
  rows.sort((a, b) => {
    const first = Number.isFinite(a.session.updatedAt) ? a.session.updatedAt! : -Infinity
    const second = Number.isFinite(b.session.updatedAt) ? b.session.updatedAt! : -Infinity
    return first === second ? 0 : second - first
  })
  const filter = query.trim().toLocaleLowerCase(locale)
  const visible = filter ? rows.filter(row => `${row.session.title ?? t("未命名會話")}\n${row.projectName}`.toLocaleLowerCase(locale).includes(filter)) : rows
  const loading = workspaces.some(row => !snapshots[row.id] || snapshots[row.id]!.pending === true)

  return <nav id="home-sidebar" className="home-sidebar ih-control-scope" aria-label={t("首頁側欄")}>
    <header className="home-sidebar-header">
      <strong>I-harness</strong>
      <div className="home-sidebar-header-actions">
        <button type="button" className="home-sidebar-icon" aria-label={t("搜尋最近會話")} title={t("搜尋最近會話")} aria-expanded={searchOpen} aria-controls="home-sidebar-search" onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setQuery("") }}><Search size={17} aria-hidden /></button>
        <button type="button" className="home-sidebar-icon" aria-label={t("關閉首頁側欄")} title={t("關閉首頁側欄")} onClick={props.onClose}><X size={17} aria-hidden /></button>
      </div>
    </header>
    {searchOpen ? <div className="home-sidebar-search"><SearchInput id="home-sidebar-search" aria-label={t("搜尋會話或專案")} placeholder={t("搜尋會話或專案")} value={query} onChange={event => setQuery(event.target.value)} clearLabel={t("清除搜尋")} onClear={() => setQuery("")} autoFocus /></div> : null}
    <div className="home-sidebar-actions">
      <Button variant="ghost" className="home-sidebar-action" icon={<Plus size={17} />} disabled={!props.canCreate} onClick={props.onCreate}>{t("新增會話")}</Button>
      {props.onProjects ? <Button variant="ghost" className="home-sidebar-action" icon={<FolderKanban size={17} />} onClick={props.onProjects}>{t("專案")}</Button> : null}
    </div>
    <h2 className="home-sidebar-recent-heading">{t("最近會話")}</h2>
    <div className="home-sidebar-scroll">
      {problems.map(({ workspace, message, pending }) => <div key={workspace.id} role="alert" className="home-sidebar-notice home-sidebar-error">
        {workspaces.length > 1 ? <span className="home-sidebar-error-source">{t("來源資料夾")} · {workspace.label}</span> : null}<p>{message}</p>
        <Button variant="ghost" size="small" disabled={pending} onClick={() => void read(workspace.id)}>{t("重試")}</Button>
      </div>)}
      {loading ? <p className="home-sidebar-notice" role="status">{t("正在讀取會話…")}</p> : null}
      {visible.length ? <ul className="home-sidebar-conversations" aria-label={t("最近會話")}>
        {visible.map(({ key, workspaceId, session, navigation, projectName }) => <li key={key}>
          <button type="button" className="home-sidebar-conversation" aria-current={workspaceId === selectedWorkspaceId && session.id === selectedSessionId ? "true" : undefined} onClick={() => props.onSelectSession(workspaceId, session.id, navigation.projectId)}>
            <span className="home-sidebar-conversation-title">
              {navigation.unread ? <span className="home-sidebar-unread" aria-label={t("未讀")} /> : null}
              {navigation.pinned ? <Pin size={12} aria-label={t("已釘選")} /> : null}
              <span className="home-sidebar-conversation-name" title={session.title ?? t("未命名會話")}>{session.title ?? t("未命名會話")}</span>
            </span>
            <span className="home-sidebar-conversation-meta">{navigation.projectId && projectNames.has(navigation.projectId) ? <span className="home-sidebar-project-name" title={projectName}>{projectName}</span> : null}{session.running === true ? <span className="home-sidebar-running">{t("執行中")}</span> : null}
            {typeof session.updatedAt === "number" && Number.isFinite(new Date(session.updatedAt).getTime()) ? <time className="home-sidebar-activity" dateTime={new Date(session.updatedAt).toISOString()}>{relativeActivity(session.updatedAt, locale)}</time> : null}</span>
          </button>
        </li>)}
      </ul> : !loading && !problems.length ? <p className="home-sidebar-notice">{t(filter ? "沒有符合的會話" : "尚無會話")}</p> : null}
    </div>
    {props.onManageSessions || props.onManageArchived ? <footer className="home-sidebar-management">
      <span className="home-sidebar-management-source" title={workspaces.find(row => row.id === selectedWorkspaceId)?.path}>{t("來源資料夾")} · {workspaces.find(row => row.id === selectedWorkspaceId)?.label}</span>
      {props.onManageSessions ? <Button variant="ghost" size="small" onClick={props.onManageSessions}>{t("批次管理會話")}</Button> : null}
      {props.onManageArchived ? <Button variant="ghost" size="small" onClick={props.onManageArchived}>{t("管理已封存會話")}</Button> : null}
    </footer> : null}
  </nav>
}
