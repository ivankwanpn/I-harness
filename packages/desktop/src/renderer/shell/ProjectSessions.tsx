import type { SessionDashboardResult } from "@i-harness/sdk"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { useCallback, useEffect, useRef, useState } from "react"
import { useLocale, useText } from "../design/i18n.ts"
import { createRefreshScheduler } from "../session/refresh-scheduler.ts"
import { classifyNotification } from "../session/notifications.ts"
import type { ProjectSidebarProps } from "./ProjectSidebar.tsx"
import { TaskList, type TaskRowScope } from "./TaskList.tsx"
import { collectProjectSessions, confirmedSessionNavigation, isSessionNavigationState, projectSessionKey, type WorkspaceSessionSnapshot } from "./project-sessions.ts"

interface ProjectSessionsProps {
  bridge: DesktopBridge
  revision?: number
  workspaces: WorkspaceEntry[]
  projectId?: string
  primaryWorkspaceId?: string
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
}

function confirmedDashboard(value: unknown): value is SessionDashboardResult {
  return !!value && typeof value === "object" && Array.isArray((value as SessionDashboardResult).sessions)
    && (value as SessionDashboardResult).sessions.every(row => row && typeof row.id === "string" && row.id !== "" && typeof row.live === "boolean")
}

/** One visible list, with source identity retained for every native operation. */
export function ProjectSessions(props: ProjectSessionsProps) {
  const t = useText()
  const en = useLocale(state => state.locale) === "en"
  const { bridge, workspaces, selectedWorkspaceId, selectedSessionId } = props
  const [snapshots, setSnapshots] = useState<Record<string, WorkspaceSessionSnapshot>>({})
  const [managementSource, setManagementSource] = useState(selectedWorkspaceId ?? props.primaryWorkspaceId)
  const workspaceKey = JSON.stringify(workspaces.map(row => row.id))
  const active = useRef(false)
  const epoch = useRef(0)
  const tickets = useRef<Record<string, number>>({})
  const supplied = useRef({ workspaceId: selectedWorkspaceId, dashboard: props.dashboard })
  supplied.current = { workspaceId: selectedWorkspaceId, dashboard: props.dashboard }

  const read = useCallback(async (workspaceId: string, loadDashboard = true) => {
    if (!active.current) return
    const scope = epoch.current
    const ticket = tickets.current[workspaceId] = (tickets.current[workspaceId] ?? 0) + 1
    const [sessions, navigation] = await Promise.allSettled([
      loadDashboard ? bridge.request({ kind: "session/dashboard", workspaceId }) : Promise.resolve(undefined),
      bridge.request({ kind: "desktop/session/navigation/state", workspaceId }),
    ])
    if (!active.current || scope !== epoch.current || ticket !== tickets.current[workspaceId]) return
    const confirmedNavigation = navigation.status === "fulfilled" && isSessionNavigationState(navigation.value) ? navigation.value : undefined
    const failed = [sessions, navigation].find(result => result.status === "rejected")
    const invalidDashboard = loadDashboard && (sessions.status !== "fulfilled" || !confirmedDashboard(sessions.value))
    setSnapshots(current => ({ ...current, [workspaceId]: {
      dashboard: !loadDashboard ? current[workspaceId]?.dashboard : sessions.status === "fulfilled" && confirmedDashboard(sessions.value) ? sessions.value : undefined,
      navigation: confirmedNavigation,
      error: failed?.status === "rejected" ? failed.reason instanceof Error ? failed.reason.message : String(failed.reason)
        : invalidDashboard ? en ? "Conversation list is unavailable" : "無法取得會話列表"
          : confirmedNavigation ? undefined : en ? "Conversation ownership is unavailable" : "會話分組狀態無法確認",
    } }))
  }, [bridge, en])

  useEffect(() => {
    active.current = true
    epoch.current++
    const ids = new Set(workspaces.map(row => row.id))
    setSnapshots(current => Object.keys(current).every(id => ids.has(id)) ? current
      : Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))))
    const refreshers = new Map(workspaces.map(workspace => [workspace.id, createRefreshScheduler(() => read(workspace.id))]))
    const unsubscribe = bridge.onEvent(event => {
      if (event.kind === "window/state" || !ids.has(event.workspaceId)) return
      if (event.kind === "sdk/disconnected") {
        tickets.current[event.workspaceId] = (tickets.current[event.workspaceId] ?? 0) + 1
        setSnapshots(current => ({ ...current, [event.workspaceId]: { ...current[event.workspaceId], navigation: undefined, error: event.message } }))
        return
      }
      if (event.method === "desktop/session/navigation/changed") { refreshers.get(event.workspaceId)?.schedule(); return }
      const kind = classifyNotification(event.method, event.params).kind
      if (kind === "durable" || kind === "status") refreshers.get(event.workspaceId)?.schedule()
    })
    for (const workspace of workspaces) void read(workspace.id, supplied.current.workspaceId !== workspace.id || supplied.current.dashboard === undefined)
    return () => { active.current = false; epoch.current++; for (const refresh of refreshers.values()) refresh.dispose(); unsubscribe() }
  }, [bridge, workspaceKey, read, props.revision])

  useEffect(() => {
    const dashboard = props.dashboard
    if (!selectedWorkspaceId || !dashboard) return
    setSnapshots(current => current[selectedWorkspaceId]?.dashboard === dashboard ? current : {
      ...current, [selectedWorkspaceId]: { ...current[selectedWorkspaceId], dashboard },
    })
  }, [selectedWorkspaceId, props.dashboard])
  useEffect(() => { if (selectedWorkspaceId) setManagementSource(selectedWorkspaceId) }, [selectedWorkspaceId])
  const views = { ...snapshots }
  if (selectedWorkspaceId && props.dashboard) views[selectedWorkspaceId] = { ...views[selectedWorkspaceId], dashboard: props.dashboard }
  const rows = collectProjectSessions({ ...props, snapshots: views })
  const rowScopes = Object.fromEntries(rows.map(row => [row.key, row.source]))
  const navigation = Object.fromEntries(rows.map(row => [row.key, row.navigation]))
  const attentionCounts = Object.fromEntries(rows.filter(row => row.source.workspaceId === selectedWorkspaceId).map(row => [row.key, props.attentionBySession?.[row.source.sessionId] ?? 0]))
  const managementWorkspace = workspaces.find(row => row.id === managementSource)
    ?? workspaces.find(row => row.id === props.primaryWorkspaceId) ?? workspaces[0]
  const loading = workspaces.some(row => !views[row.id]?.navigation && !views[row.id]?.error)
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
    if (active.current && scope === epoch.current) await read(source.workspaceId)
  }

  return <div className="project-sidebar-sessions">
    {workspaces.filter(row => views[row.id]?.error).map(workspace => <p key={workspace.id} role="alert" className="notice error-text">
      {workspaces.length > 1 ? <span>{workspace.label} · </span> : null}{views[workspace.id]!.error}
      <button type="button" className="link-button" onClick={() => void read(workspace.id)}>{t("重試")}</button>
    </p>)}
    {listingUnavailable.map(workspace => <p key={workspace.id} className="notice">{workspaces.length > 1 ? `${workspace.label} · ` : ""}{t("無法取得會話列表")}</p>)}
    {ownershipUnavailable.map(workspace => <p key={workspace.id} role="alert" className="notice error-text">
      {workspaces.length > 1 ? `${workspace.label} · ` : ""}{en ? "Conversation ownership is unavailable" : "會話分組狀態無法確認"}
      <button type="button" className="link-button" onClick={() => void read(workspace.id)}>{t("重試")}</button>
    </p>)}
    {loading ? <p className="notice">{t("正在讀取會話…")}</p> : null}
    {showList ? <TaskList dashboard={{ sessions: rows.map(row => ({ ...row.session, id: row.key })) }} rowScopes={rowScopes} navigation={navigation} showBatchManagement={false}
      selectedId={selectedWorkspaceId && selectedSessionId ? projectSessionKey(selectedWorkspaceId, selectedSessionId) : undefined} attentionCounts={attentionCounts}
      onSelect={(id, source) => {
        if (!source) return
        const scope = epoch.current
        props.onSelectSession(source.workspaceId, id, props.projectId)
        void (async () => {
          try {
            await props.onManageSession(source.workspaceId, id, "read")
            if (active.current && scope === epoch.current) await read(source.workspaceId)
          } catch (reason) {
            if (active.current && scope === epoch.current) setSnapshots(current => ({ ...current, [source.workspaceId]: { ...current[source.workspaceId], error: reason instanceof Error ? reason.message : String(reason) } }))
          }
        })()
      }}
      onManage={async (_id, action, title, source) => { if (source) await manage(source, action, title) }}
      onCopyId={async id => { await navigator.clipboard.writeText(id) }}
      onOpenFolder={async source => { if (source) await bridge.request({ kind: "workspace/reveal", workspaceId: source.workspaceId }) }}
      onManageSessions={props.onManageSessions ? (id, source) => {
        const workspaceId = source?.workspaceId ?? managementWorkspace?.id
        if (workspaceId) props.onManageSessions!(workspaceId, id)
      } : undefined}
      /> : null}
    {managementWorkspace ? <div className="project-sidebar-management">
      {workspaces.length > 1 ? <label className="project-sidebar-management-source-label">{t("來源資料夾")}
        <select className="project-sidebar-management-source" aria-label={t("選擇來源資料夾")} title={managementWorkspace.path} value={managementWorkspace.id} onChange={event => setManagementSource(event.target.value)}>
          {workspaces.map(workspace => <option key={workspace.id} value={workspace.id} title={workspace.path}>{workspace.label}</option>)}
        </select>
      </label> : null}
      {props.onManageSessions ? <button type="button" className="session-archived-button" onClick={() => props.onManageSessions!(managementWorkspace.id, undefined)}>{t("批次管理會話")}</button> : null}
      <button type="button" className="session-archived-button" onClick={() => props.onManageArchived(managementWorkspace.id)}>{t("管理已封存會話")}</button>
    </div> : null}
  </div>
}
