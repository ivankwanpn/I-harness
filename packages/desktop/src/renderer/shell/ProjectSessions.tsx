import { displayError } from "../design/error-display.ts"
import type { SessionDashboardResult } from "@i-harness/sdk"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useCallback, useEffect, useRef, useState } from "react"
import { useLocale, useText } from "../design/i18n.ts"
import { createRefreshScheduler } from "../session/refresh-scheduler.ts"
import { affectsSessionDashboard } from "../session/notifications.ts"
import type { ProjectSidebarProps } from "./ProjectSidebar.tsx"
import { TaskList, type TaskRowScope } from "./TaskList.tsx"
import { collectProjectSessions, confirmedSessionNavigation, isSessionNavigationState, projectSessionKey, type WorkspaceSessionSnapshot } from "./project-sessions.ts"

interface ProjectSessionsProps {
  bridge: DesktopBridge
  revision?: number
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
  onOwners?(workspaceId: string, owners: (string | undefined)[]): void
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
  return { ...dashboard, sessions: dashboard.sessions.map(row => rows.get(row.id) ?? row) }
}

/** One visible list, with source identity retained for every native operation. */
export function ProjectSessions(props: ProjectSessionsProps) {
  const t = useText()
  const en = useLocale(state => state.locale) === "en"
  const { bridge, workspaces, selectedWorkspaceId, selectedSessionId } = props
  const [snapshots, setSnapshots] = useState<Record<string, WorkspaceSessionSnapshot>>({})

  const workspaceKey = JSON.stringify(workspaces.map(row => row.id))
  const active = useRef(false)
  const epoch = useRef(0)
  const tickets = useRef<Record<string, number>>({})
  const readers = useRef(new Map<string, ReturnType<typeof createRefreshScheduler>>())
  const currentSnapshots = useRef(snapshots)
  currentSnapshots.current = snapshots
  const supplied = useRef({ workspaceId: selectedWorkspaceId, dashboard: props.dashboard })
  supplied.current = { workspaceId: selectedWorkspaceId, dashboard: props.dashboard }

  const read = useCallback(async (workspaceId: string, initial: boolean) => {
    if (!active.current) return
    const scope = epoch.current
    const ticket = tickets.current[workspaceId] = (tickets.current[workspaceId] ?? 0) + 1
    const current = () => active.current && scope === epoch.current && ticket === tickets.current[workspaceId]
    const initialDashboard = initial && supplied.current.workspaceId === workspaceId ? supplied.current.dashboard : undefined
    const [sessions] = await Promise.allSettled([
      initialDashboard ?? bridge.request({ kind: "session/dashboard", workspaceId }),
    ] as const)
    if (!current()) return
    // A newly listed conversation may have been created during an expensive
    // dashboard read. Observe its saved owner after the dashboard settles.
    const [navigation] = await Promise.allSettled([bridge.request({ kind: "desktop/session/navigation/state", workspaceId })] as const)
    if (!current()) return
    const dashboard = sessions.status === "fulfilled" && confirmedDashboard(sessions.value) ? sessions.value : undefined
    const confirmedNavigation = navigation.status === "fulfilled" && isSessionNavigationState(navigation.value) ? navigation.value : undefined
    if (confirmedNavigation) props.onOwners?.(workspaceId, [...new Set(Object.values(confirmedNavigation).flatMap(row => confirmedSessionNavigation(row) ? [row.projectId] : []))])
    const failed = [sessions, navigation].find(result => result.status === "rejected")
    setSnapshots(previous => ({ ...previous, [workspaceId]: {
      dashboard,
      navigation: confirmedNavigation,
      error: failed?.status === "rejected" ? failed.reason instanceof Error ? failed.reason.message : String(failed.reason)
        : !dashboard ? en ? "Conversation list is unavailable" : "無法取得會話列表"
          : confirmedNavigation ? undefined : en ? "Conversation ownership is unavailable" : "會話分組狀態無法確認",
    } }))
  }, [bridge, en, props.onOwners])

  useEffect(() => {
    active.current = true
    epoch.current++
    const ids = new Set(workspaces.map(row => row.id))
    setSnapshots(current => Object.keys(current).every(id => ids.has(id)) ? current
      : Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))))
    const refreshers = new Map(workspaces.map(workspace => {
      let initial = true
      return [workspace.id, createRefreshScheduler(() => {
        const job = read(workspace.id, initial)
        initial = false
        return job
      })] as const
    }))
    readers.current = refreshers
    const unsubscribe = bridge.onEvent(event => {
      if (event.kind === "window/state" || event.kind === "runtime/diagnostic" || event.kind === "runtime/activity" || !ids.has(event.workspaceId)) return
      if (event.kind === "sdk/disconnected") {
        tickets.current[event.workspaceId] = (tickets.current[event.workspaceId] ?? 0) + 1
        setSnapshots(current => ({ ...current, [event.workspaceId]: { ...current[event.workspaceId], navigation: undefined, error: event.message } }))
        refreshers.get(event.workspaceId)?.schedule()
        return
      }
      if (event.kind === "sdk/ready") { refreshers.get(event.workspaceId)?.schedule(); return }
      if (affectsSessionDashboard(event.method, event.params)) refreshers.get(event.workspaceId)?.schedule()
    })
    for (const refresh of refreshers.values()) refresh.schedule(0)
    // Native session changes publish notifications. Reconcile out-of-process
    // changes when the user returns to this window.
    const refreshOnReturn = () => {
      if (document.visibilityState === "hidden") return
      const id = supplied.current.workspaceId
      if (id) refreshers.get(id)?.schedule()
    }
    window.addEventListener("focus", refreshOnReturn)
    document.addEventListener("visibilitychange", refreshOnReturn)
    return () => {
      active.current = false
      epoch.current++
      window.removeEventListener("focus", refreshOnReturn)
      document.removeEventListener("visibilitychange", refreshOnReturn)
      for (const refresh of refreshers.values()) refresh.dispose()
      unsubscribe()
    }
  }, [bridge, workspaceKey, read, props.revision])

  useEffect(() => {
    const details = props.dashboard
    if (!selectedWorkspaceId || !details || details.listingUnavailable) return
    const paired = currentSnapshots.current[selectedWorkspaceId]?.dashboard
    if (!paired || paired.listingUnavailable) return
    const ids = new Set(paired.sessions.map(row => row.id))
    if (details.sessions.some(row => !ids.has(row.id))) readers.current.get(selectedWorkspaceId)?.schedule()
    setSnapshots(current => {
      const snapshot = current[selectedWorkspaceId]
      return snapshot?.dashboard ? { ...current, [selectedWorkspaceId]: {
        ...snapshot, dashboard: withDashboardDetails(snapshot.dashboard, details),
      } } : current
    })
  }, [selectedWorkspaceId, props.dashboard])
  const views = { ...snapshots }
  if (selectedWorkspaceId && (views[selectedWorkspaceId] || props.dashboard?.listingUnavailable)) views[selectedWorkspaceId] = {
    ...views[selectedWorkspaceId], dashboard: props.dashboard?.listingUnavailable ? props.dashboard
      : withDashboardDetails(views[selectedWorkspaceId]?.dashboard, props.dashboard),
  }
  const rows = collectProjectSessions({ ...props, snapshots: views })
  const rowScopes = Object.fromEntries(rows.map(row => [row.key, row.source]))
  const navigation = Object.fromEntries(rows.map(row => [row.key, row.navigation]))
  const attentionCounts = Object.fromEntries(rows.filter(row => row.source.workspaceId === selectedWorkspaceId).map(row => [row.key, props.attentionBySession?.[row.source.sessionId] ?? 0]))
  const loading = workspaces.some(row => !views[row.id]?.navigation && !views[row.id]?.error && !views[row.id]?.dashboard?.listingUnavailable)
  const hasError = workspaces.some(row => !!views[row.id]?.error)
  const listingUnavailable = workspaces.filter(row => views[row.id]?.dashboard?.listingUnavailable)
  const ownershipUnavailable = workspaces.filter(workspace => {
    const snapshot = views[workspace.id]
    return snapshot?.navigation && !snapshot.dashboard?.listingUnavailable && snapshot.dashboard?.sessions.some(session =>
      !Object.hasOwn(snapshot.navigation!, session.id) || !confirmedSessionNavigation(snapshot.navigation![session.id]))
  })
  const showList = rows.length > 0 || !loading && !hasError && listingUnavailable.length === 0 && ownershipUnavailable.length === 0

  async function manage(source: TaskRowScope, action: Parameters<ProjectSidebarProps["onManageSession"]>[2], title?: string) {
    const scope = epoch.current
    await props.onManageSession(source.workspaceId, source.sessionId, action, title)
    if (active.current && scope === epoch.current) readers.current.get(source.workspaceId)?.schedule()
  }

  return <div className="project-sidebar-sessions">
    {workspaces.filter(row => views[row.id]?.error).map(workspace => <p key={workspace.id} role="alert" className="notice error-text">
      {workspaces.length > 1 ? <span>{workspace.label} · </span> : null}<span title={views[workspace.id]!.error}>{displayError(views[workspace.id]!.error).summary}</span>
      <button type="button" className="link-button" onClick={() => readers.current.get(workspace.id)?.schedule()}>{t("重試")}</button>
    </p>)}
    {listingUnavailable.map(workspace => <p key={workspace.id} className="notice">{workspaces.length > 1 ? `${workspace.label} · ` : ""}{t("無法取得會話列表")}</p>)}
    {ownershipUnavailable.map(workspace => <p key={workspace.id} role="alert" className="notice error-text">
      {workspaces.length > 1 ? `${workspace.label} · ` : ""}{en ? "Conversation ownership is unavailable" : "會話分組狀態無法確認"}
      <button type="button" className="link-button" onClick={() => readers.current.get(workspace.id)?.schedule()}>{t("重試")}</button>
    </p>)}
    {loading ? <p className="notice">{t("正在讀取會話…")}</p> : null}
    {showList ? <TaskList dashboard={{ sessions: rows.map(row => ({ ...row.session, id: row.key })) }} rowScopes={rowScopes} navigation={navigation} showBatchManagement={false}
      selectedId={selectedWorkspaceId && selectedSessionId ? projectSessionKey(selectedWorkspaceId, selectedSessionId) : undefined} attentionCounts={attentionCounts}
      onSelect={(id, source) => {
        if (!source) return
        const scope = epoch.current
        props.onSelectSession(source.workspaceId, id, props.projectId)
        if (navigation[projectSessionKey(source.workspaceId, id)]?.unread !== true) return
        void (async () => {
          try {
            await props.onManageSession(source.workspaceId, id, "read")
            if (active.current && scope === epoch.current) readers.current.get(source.workspaceId)?.schedule()
          } catch (reason) {
            if (active.current && scope === epoch.current) setSnapshots(current => ({ ...current, [source.workspaceId]: { ...current[source.workspaceId], error: reason instanceof Error ? reason.message : String(reason) } }))
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
