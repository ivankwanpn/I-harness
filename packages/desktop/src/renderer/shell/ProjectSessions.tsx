import { displayError } from "../design/error-display.ts"
import type { SessionDashboardResult } from "@i-harness/sdk"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react"
import { useLocale, useText } from "../design/i18n.ts"
import { createRefreshScheduler } from "../session/refresh-scheduler.ts"
import type { ProjectSidebarProps } from "./ProjectSidebar.tsx"
import { TaskList, type TaskRowScope } from "./TaskList.tsx"
import { collectProjectSessions, confirmedSessionNavigation, isSessionNavigationState, projectSessionKey, type WorkspaceSessionSnapshot } from "./project-sessions.ts"

interface ProjectSessionsProps {
  bridge: DesktopBridge
  snapshots: Record<string, WorkspaceSessionSnapshot>
  readers: RefObject<Map<string, SidebarWorkspaceReader>>
  workspaces: WorkspaceEntry[]
  projectId?: string
  memberWorkspaceIds: ReadonlySet<string>
  assignedWorkspaceIds: ReadonlySet<string>
  knownProjectIds: ReadonlySet<string>
  selectedWorkspaceId?: string
  selectedSessionId?: string
  dashboard?: SessionDashboardResult
  attentionBySession?: Record<string, number>
  onSelectSession: ProjectSidebarProps["onSelectSession"]
  onManageSession: ProjectSidebarProps["onManageSession"]
  onManageArchived: ProjectSidebarProps["onManageArchived"]
  onManageSessions?: ProjectSidebarProps["onManageSessions"]
  filter?: string
}

function confirmedDashboard(value: unknown): value is SessionDashboardResult {
  return !!value && typeof value === "object" && Array.isArray((value as SessionDashboardResult).sessions)
    && (value as SessionDashboardResult).sessions.every(row => row && typeof row.id === "string" && row.id !== "" && typeof row.live === "boolean")
}

function withDashboardDetails(dashboard: SessionDashboardResult | undefined, details: SessionDashboardResult | undefined) {
  if (!dashboard || dashboard.listingUnavailable || !details || details.listingUnavailable || dashboard === details) return dashboard
  // The paired sidebar snapshot owns membership. Foreground reads can update
  // presentation for its rows while a newly listed session awaits its owner.
  const rows = new Map(details.sessions.map(row => [row.id, row]))
  if (!dashboard.sessions.some(row => rows.has(row.id) && rows.get(row.id) !== row)) return dashboard
  return { ...dashboard, sessions: dashboard.sessions.map(row => rows.get(row.id) ?? row) }
}

export type SidebarReadMode = "owners" | "foreground" | "sessions"
export interface SidebarWorkspaceSnapshot extends WorkspaceSessionSnapshot {
  owners?: ReadonlySet<string | undefined>
}
export interface SidebarWorkspaceReader {
  mode: SidebarReadMode
  followsForeground(sessionId: unknown): boolean
  refresh(): void
  standby(): void
  disconnect(message: string): void
  reportError(reason: unknown): void
}

/** Every project that displays this workspace consumes the same paired snapshot. */
export function WorkspaceCatalogReader({ bridge, workspaceId, mode, revision, details, snapshot, readOpeningDashboard, readers, setSnapshots }: {
  bridge: DesktopBridge
  workspaceId: string
  mode: SidebarReadMode
  revision?: number
  details?: SessionDashboardResult
  snapshot?: SidebarWorkspaceSnapshot
  readOpeningDashboard?: ProjectSidebarProps["readOpeningDashboard"]
  readers: RefObject<Map<string, SidebarWorkspaceReader>>
  setSnapshots: Dispatch<SetStateAction<Record<string, SidebarWorkspaceSnapshot>>>
}) {
  const en = useLocale(state => state.locale) === "en"
  const foreground = useRef(details)
  foreground.current = details
  const retiredOpening = useRef<{ details?: SessionDashboardResult } | undefined>(undefined)
  if (retiredOpening.current && retiredOpening.current.details !== details) retiredOpening.current = undefined
  const latestSnapshot = useRef(snapshot)
  latestSnapshot.current = snapshot
  const paired = useRef<SessionDashboardResult | undefined>(undefined)
  useEffect(() => {
    let active = true
    let generation = 0
    let initial = true
    let confirmedRows: WorkspaceSessionSnapshot["navigation"]
    paired.current = undefined
    if (mode === "owners") {
      setSnapshots(previous => previous[workspaceId]?.dashboard || previous[workspaceId]?.navigation ? {
        ...previous, [workspaceId]: { owners: previous[workspaceId]?.owners },
      } : previous)
    }
    const refresh = createRefreshScheduler(async () => {
      const ticket = generation
      const current = () => active && generation === ticket
      const supplied = foreground.current
      const opening = initial && mode === "foreground" && !retiredOpening.current
      initial = false
      let dashboard: SessionDashboardResult | undefined
      let error: string | undefined
      if (mode !== "owners") {
        try {
          const result = (opening ? supplied : undefined) ?? await (
            (opening ? readOpeningDashboard?.(workspaceId) : undefined) ?? bridge.request({ kind: "session/dashboard", workspaceId })
          )
          if (!confirmedDashboard(result)) throw new Error(en ? "Conversation list is unavailable" : "無法取得會話列表")
          dashboard = result
        } catch (reason) { error = reason instanceof Error ? reason.message : String(reason) }
        if (!current()) return
      }
      // Native creation and moves may finish while the dashboard is loading.
      // Always confirm the owner after reading the list.
      let navigation: WorkspaceSessionSnapshot["navigation"]
      try {
        const result = await bridge.request({ kind: "desktop/session/navigation/state", workspaceId, includeCoverage: true })
        const report = result as { entries?: unknown; partial?: unknown } | undefined
        // Older gateways return the confirmed map directly.
        const entries = typeof report?.partial === "boolean" ? report.entries : result
        if (report?.partial === true || dashboard?.listingPartial) error ??= en ? "Some conversations could not be listed" : "部分會話資料暫時無法讀取"
        if (!isSessionNavigationState(entries)) throw new Error(en ? "Conversation ownership is unavailable" : "會話分組狀態無法確認")
        navigation = entries
      } catch (reason) { error ??= reason instanceof Error ? reason.message : String(reason) }
      if (!current()) return
      paired.current = dashboard
      confirmedRows = dashboard && !dashboard.listingUnavailable ? navigation : undefined
      const owners = navigation && new Set(Object.values(navigation).flatMap(row => confirmedSessionNavigation(row) ? [row.projectId] : []))
      setSnapshots(previous => ({ ...previous, [workspaceId]: {
        // Keep the group's retry control reachable after a failed read. Its
        // conversation rows always require a currently confirmed navigation.
        dashboard: mode === "owners" ? undefined : dashboard ?? previous[workspaceId]?.dashboard,
        navigation: mode === "owners" ? undefined : navigation, owners: owners ?? previous[workspaceId]?.owners, error,
      } }))
      if (dashboard && foreground.current !== supplied && membershipChanged(dashboard, foreground.current)) refresh.schedule()
    })
    const retireReads = () => {
      generation++
      initial = false
      retiredOpening.current = { details: foreground.current }
      return refresh.retire()
    }
    const reader: SidebarWorkspaceReader = {
      mode,
      followsForeground(id) {
        return !!foreground.current && !foreground.current.listingUnavailable && typeof id === "string"
          && confirmedSessionNavigation(confirmedRows?.[id])
      },
      refresh: refresh.schedule,
      standby() {
        if (!active || !retireReads()) return
        const last = latestSnapshot.current
        // IPC has already retired the active route. Only replace interrupted
        // discovery or an unconfirmed open list through the cold catalog.
        if (mode === "owners" || !last?.dashboard || last.dashboard.listingUnavailable || !last.navigation) refresh.schedule(0)
      },
      disconnect(message) {
        if (!active) return
        retireReads()
        confirmedRows = undefined
        setSnapshots(previous => ({ ...previous, [workspaceId]: { ...previous[workspaceId], navigation: undefined, error: message } }))
        refresh.schedule()
      },
      reportError(reason) {
        if (active) setSnapshots(previous => ({ ...previous, [workspaceId]: {
          ...previous[workspaceId], error: reason instanceof Error ? reason.message : String(reason),
        } }))
      },
    }
    readers.current.set(workspaceId, reader)
    refresh.schedule(0)
    return () => { active = false; refresh.dispose(); readers.current.delete(workspaceId) }
  }, [bridge, workspaceId, mode, revision, en, readOpeningDashboard, readers, setSnapshots])

  useEffect(() => {
    if (!details || details.listingUnavailable || !paired.current) return
    if (membershipChanged(paired.current, details)) readers.current.get(workspaceId)?.refresh()
    setSnapshots(previous => {
      const snapshot = previous[workspaceId]
      if (!snapshot?.dashboard) return previous
      const dashboard = withDashboardDetails(snapshot.dashboard, details)
      return dashboard === snapshot.dashboard ? previous : { ...previous, [workspaceId]: { ...snapshot, dashboard } }
    })
  }, [workspaceId, details, readers, setSnapshots])
  return null
}

function membershipChanged(paired: SessionDashboardResult, details?: SessionDashboardResult) {
  if (!details || details.listingUnavailable || paired.listingUnavailable) return false
  if (paired.sessions.length !== details.sessions.length) return true
  const ids = new Set(paired.sessions.map(row => row.id))
  return details.sessions.some(row => !ids.has(row.id))
}

/** Project grouping is a presentation of the workspace snapshots. */
export function ProjectSessions(props: ProjectSessionsProps) {
  const t = useText()
  const en = useLocale(state => state.locale) === "en"
  const { bridge, workspaces, selectedWorkspaceId, selectedSessionId, snapshots, readers } = props
  const views = selectedWorkspaceId && props.dashboard ? { ...snapshots, [selectedWorkspaceId]: {
    ...snapshots[selectedWorkspaceId], dashboard: props.dashboard.listingUnavailable ? props.dashboard
      : withDashboardDetails(snapshots[selectedWorkspaceId]?.dashboard, props.dashboard),
  } } : snapshots
  const rows = collectProjectSessions({ ...props, snapshots: views })
  const rowScopes = Object.fromEntries(rows.map(row => [row.key, row.source]))
  const navigation = Object.fromEntries(rows.map(row => [row.key, row.navigation]))
  const attentionCounts = Object.fromEntries(rows.filter(row => row.source.workspaceId === selectedWorkspaceId).map(row => [row.key, props.attentionBySession?.[row.source.sessionId] ?? 0]))
  const loading = workspaces.some(row => {
    const snapshot = views[row.id]
    return !snapshot?.error && !snapshot?.dashboard?.listingUnavailable && (!snapshot?.dashboard || !snapshot.navigation)
  })
  const hasError = workspaces.some(row => !!views[row.id]?.error)
  const listingUnavailable = workspaces.filter(row => views[row.id]?.dashboard?.listingUnavailable)
  const ownershipUnavailable = workspaces.filter(workspace => {
    const snapshot = views[workspace.id]
    return snapshot?.navigation && !snapshot.dashboard?.listingUnavailable && snapshot.dashboard?.sessions.some(session =>
      !Object.hasOwn(snapshot.navigation!, session.id) || !confirmedSessionNavigation(snapshot.navigation![session.id]))
  })
  const showList = rows.length > 0 || !loading && !hasError && listingUnavailable.length === 0 && ownershipUnavailable.length === 0

  async function manage(source: TaskRowScope, action: Parameters<ProjectSidebarProps["onManageSession"]>[2], title?: string) {
    const reader = readers.current.get(source.workspaceId)
    await props.onManageSession(source.workspaceId, source.sessionId, action, title)
    reader?.refresh()
  }

  return <div className="project-sidebar-sessions">
    {workspaces.filter(row => views[row.id]?.error).map(workspace => <p key={workspace.id} role="alert" className="notice error-text">
      {workspaces.length > 1 ? <span>{workspace.label} · </span> : null}<span title={views[workspace.id]!.error}>{displayError(views[workspace.id]!.error).summary}</span>
      <button type="button" className="link-button" onClick={() => readers.current.get(workspace.id)?.refresh()}>{t("重試")}</button>
    </p>)}
    {listingUnavailable.map(workspace => <p key={workspace.id} className="notice">{workspaces.length > 1 ? `${workspace.label} · ` : ""}{t("無法取得會話列表")}</p>)}
    {ownershipUnavailable.map(workspace => <p key={workspace.id} role="alert" className="notice error-text">
      {workspaces.length > 1 ? `${workspace.label} · ` : ""}{en ? "Conversation ownership is unavailable" : "會話分組狀態無法確認"}
      <button type="button" className="link-button" onClick={() => readers.current.get(workspace.id)?.refresh()}>{t("重試")}</button>
    </p>)}
    {loading ? <p className="notice">{t("正在讀取會話…")}</p> : null}
    {showList ? <TaskList dashboard={{ sessions: rows.map(row => ({ ...row.session, id: row.key })) }} rowScopes={rowScopes} navigation={navigation} showBatchManagement={false}
      selectedId={selectedWorkspaceId && selectedSessionId ? projectSessionKey(selectedWorkspaceId, selectedSessionId) : undefined} attentionCounts={attentionCounts}
      onSelect={(id, source) => {
        if (!source) return
        const reader = readers.current.get(source.workspaceId)
        props.onSelectSession(source.workspaceId, id, props.projectId)
        if (navigation[projectSessionKey(source.workspaceId, id)]?.unread !== true) return
        void (async () => {
          try {
            await props.onManageSession(source.workspaceId, id, "read")
            reader?.refresh()
          } catch (reason) {
            reader?.reportError(reason)
          }
        })()
      }}
      onManage={async (_id, action, title, source) => { if (source) await manage(source, action, title) }}
      onCopyId={async id => { await navigator.clipboard.writeText(id) }}
      onOpenFolder={async source => { if (source) await bridge.request({ kind: "workspace/reveal", workspaceId: source.workspaceId }) }}
      onManageSessions={props.onManageSessions ? (id, source) => { if (source) props.onManageSessions!(source.workspaceId, id) } : undefined}
      filter={props.filter}
      /> : null}
  </div>
}
