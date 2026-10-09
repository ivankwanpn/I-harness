import type { SessionDashboardResult } from "@i-harness/sdk"
import type { ProjectEntry } from "../../main/projects.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { SessionManagementAction } from "@i-harness/desktop-gateway/src/session-management.ts"
import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronRight, Folder, FolderOpen, Pin, Plus, Puzzle, Settings } from "lucide-react"
import { useText, useLocale } from "../design/i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { TaskList } from "./TaskList.tsx"
import type { SessionNavigation } from "./SessionActions.tsx"
import { createRefreshScheduler } from "../session/refresh-scheduler.ts"
import { classifyNotification } from "../session/notifications.ts"
import "./projects-sidebar.css"

export interface ProjectSidebarProps {
  bridge: DesktopBridge
  revision?: number
  onManageSessions?(workspaceId: string, sessionId?: string): void
  projects: ProjectEntry[]
  workspaces: WorkspaceEntry[]
  selectedProjectId?: string
  selectedWorkspaceId?: string
  selectedSessionId?: string
  dashboard?: SessionDashboardResult
  attentionBySession?: Record<string, number>
  canCreate: boolean
  onCreate(): void
  onOpenWorkspace(): void
  onProjects(): void
  onSettings?(): void
  onPlugins?(): void
  onSelectProject(id: string): void
  onSelectWorkspace(workspaceId: string, projectId?: string): void
  onSelectSession(workspaceId: string, sessionId: string, projectId?: string): void
  onManageSession(workspaceId: string, id: string, action: SessionManagementAction, title?: string): Promise<void>
  onManageArchived(workspaceId: string): void
}

type FolderNavigation = SessionNavigation & { projectId?: string }
const confirmedNavigation = (row: unknown): row is FolderNavigation => !!row && typeof row === "object"
  && typeof (row as FolderNavigation).pinned === "boolean" && typeof (row as FolderNavigation).unread === "boolean"
  && ((row as FolderNavigation).projectId === undefined || typeof (row as FolderNavigation).projectId === "string" && (row as FolderNavigation).projectId !== "")

function FolderSessions({ bridge, revision, foreign, orphanOnly, onManageSessions, workspaceId, projectId, knownProjectIds, dashboard, selectedSessionId, attentionBySession, onSelectSession, onManageSession, onManageArchived }: {
  bridge: DesktopBridge
  revision?: number
  foreign?: boolean
  orphanOnly?: boolean
  onManageSessions?: ProjectSidebarProps["onManageSessions"]
  workspaceId: string
  projectId?: string
  knownProjectIds: ReadonlySet<string>
  dashboard?: SessionDashboardResult
  selectedSessionId?: string
  attentionBySession?: Record<string, number>
  onSelectSession: ProjectSidebarProps["onSelectSession"]
  onManageSession: ProjectSidebarProps["onManageSession"]
  onManageArchived: ProjectSidebarProps["onManageArchived"]
}) {
  const t = useText()
  const en = useLocale(state => state.locale) === "en"
  const [loaded, setLoaded] = useState<SessionDashboardResult>()
  const [navigation, setNavigation] = useState<Record<string, FolderNavigation>>()
  const [error, setError] = useState<string>()
  const active = useRef(false)
  const epoch = useRef(0)
  const ticket = useRef(0)
  const supplied = useRef(dashboard)
  supplied.current = dashboard

  const read = useCallback(async (loadDashboard = true) => {
    if (!active.current) return
    const scope = epoch.current
    const request = ++ticket.current
    const results = await Promise.allSettled([
      loadDashboard ? bridge.request({ kind: "session/dashboard", workspaceId }) : Promise.resolve(undefined),
      bridge.request({ kind: "desktop/session/navigation/state", workspaceId }),
    ])
    if (!active.current || scope !== epoch.current || request !== ticket.current) return
    const [sessions, nav] = results
    if (sessions.status === "fulfilled" && sessions.value !== undefined) setLoaded(sessions.value as SessionDashboardResult)
    const validNavigation = nav.status === "fulfilled" && !!nav.value && typeof nav.value === "object" && !Array.isArray(nav.value)
    setNavigation(validNavigation ? nav.value as Record<string, FolderNavigation> : undefined)
    const failed = results.find((result) => result.status === "rejected")
    setError(failed?.status === "rejected" ? failed.reason instanceof Error ? failed.reason.message : String(failed.reason) : validNavigation ? undefined : en ? "Conversation ownership is unavailable" : "會話分組狀態無法確認")
  }, [bridge, workspaceId, en])

  useEffect(() => {
    active.current = true
    epoch.current++
    const refresh = createRefreshScheduler(() => read())
    const unsubscribe = bridge.onEvent((event) => {
      if (event.kind === "window/state") return
      if (event.workspaceId !== workspaceId) return
      if (event.kind === "sdk/disconnected") { setError(event.message); return }
      if (event.method === "desktop/session/navigation/changed") { refresh.schedule(); return }
      const kind = classifyNotification(event.method, event.params).kind
      if (kind === "durable" || kind === "status") refresh.schedule()
    })
    void read(supplied.current === undefined)
    return () => { active.current = false; epoch.current++; ticket.current++; refresh.dispose(); unsubscribe() }
  }, [bridge, workspaceId, read, revision])

  const rawView = dashboard ?? loaded
  const view = rawView && navigation ? { ...rawView, sessions: rawView.sessions.filter(session => {
    if (!Object.hasOwn(navigation, session.id) || !confirmedNavigation(navigation[session.id])) return false
    const owner = navigation[session.id]!.projectId
    // This fallback is only a display destination. The saved owner and backend
    // authority remain intact; unknown/failed ownership is never unassigned.
    if (projectId) return owner === projectId || (!foreign && owner === undefined)
    return owner === undefined ? !orphanOnly : !knownProjectIds.has(owner)
  }) } : undefined
  return <div className="project-sidebar-folder-sessions">
    {error ? <p role="alert" className="notice error-text">{error}<button type="button" className="link-button" onClick={() => void read()}>{t("重試")}</button></p> : null}
    {view === undefined ? error ? null : <p className="notice">{t("正在讀取會話…")}</p> : <TaskList
      workspaceId={workspaceId} dashboard={view} navigation={navigation} selectedId={selectedSessionId} attentionCounts={attentionBySession}
      onSelect={(id) => {
        const scope = epoch.current
        onSelectSession(workspaceId, id, projectId)
        void (async () => {
          try {
            await onManageSession(workspaceId, id, "read")
            if (active.current && scope === epoch.current) await read()
          } catch (reason) {
            if (active.current && scope === epoch.current) setError(reason instanceof Error ? reason.message : String(reason))
          }
        })()
      }}
      onManage={async (id, action, title) => { const scope = epoch.current; await onManageSession(workspaceId, id, action, title); if (active.current && scope === epoch.current) await read() }}
      onCopyId={async (id) => { await navigator.clipboard.writeText(id) }}
      onOpenFolder={async () => { await bridge.request({ kind: "workspace/reveal", workspaceId }) }}
      onManageSessions={onManageSessions ? id => onManageSessions(workspaceId, id) : undefined}
      onManageArchived={() => onManageArchived(workspaceId)} />}
  </div>
}

const projectKey = (id?: string) => JSON.stringify(id === undefined ? ["unassigned"] : ["project", id])
const folderKey = (workspaceId: string, projectId?: string) => JSON.stringify([projectId ?? null, workspaceId])

/** Project groups reference workspace-owned conversations. Each expanded
 * folder owns its reads/subscription and uses the existing TaskList actions. */
export function ProjectSidebar(props: ProjectSidebarProps) {
  const t = useText()
  const en = useLocale(state => state.locale) === "en"
  const { projects, workspaces, selectedProjectId, selectedWorkspaceId, selectedSessionId, bridge } = props
  const [ownerFolders, setOwnerFolders] = useState<Record<string, string[]>>({})
  const [ownerError, setOwnerError] = useState<string>()
  const workspaceKey = JSON.stringify(workspaces.map(row => row.id))
  useEffect(() => {
    let active = true
    let version = 0
    async function readOwners() {
      const own = ++version
      const results = await Promise.allSettled(workspaces.map(async workspace => {
        const rows = await bridge.request({ kind: "desktop/session/navigation/state", workspaceId: workspace.id }) as Record<string, FolderNavigation>
        if (!rows || typeof rows !== "object" || Array.isArray(rows)) throw new Error(en ? "Conversation ownership is unavailable" : "會話分組狀態無法確認")
        return { workspaceId: workspace.id, projects: [...new Set(Object.values(rows).flatMap(row => confirmedNavigation(row) && row.projectId ? [row.projectId] : []))] }
      }))
      if (!active || own !== version) return
      setOwnerFolders(previous => {
        const next = { ...previous }
        results.forEach((result, index) => { if (result.status === "fulfilled") next[result.value.workspaceId] = result.value.projects; else if (workspaces[index]) next[workspaces[index]!.id] = [] })
        return next
      })
      const failed = results.find(result => result.status === "rejected")
      setOwnerError(failed?.status === "rejected" ? String(failed.reason) : undefined)
    }
    const refresh = createRefreshScheduler(readOwners)
    const unsubscribe = bridge.onEvent(event => { if (event.kind === "sdk/notification" && (event.method === "desktop/session/navigation/changed" || event.method === "session/status")) refresh.schedule() })
    void readOwners()
    return () => { active = false; version++; refresh.dispose(); unsubscribe() }
  }, [bridge, workspaceKey, props.revision, en])
  const assigned = new Set(projects.flatMap((project) => project.workspaceIds))
  const knownProjectIds = new Set(projects.map(project => project.id))
  const unassigned = workspaces.filter((workspace) => !assigned.has(workspace.id) || ownerFolders[workspace.id]?.some(id => !knownProjectIds.has(id)))
  const effectiveProjectId = selectedProjectId ?? projects.find((project) => project.workspaceIds.includes(selectedWorkspaceId ?? ""))?.id
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set(selectedWorkspaceId || selectedProjectId ? [projectKey(effectiveProjectId)] : []))
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(selectedWorkspaceId ? [folderKey(selectedWorkspaceId, effectiveProjectId)] : []))

  useEffect(() => {
    if (selectedProjectId || selectedWorkspaceId) setExpandedProjects((current) => new Set(current).add(projectKey(effectiveProjectId)))
    if (selectedWorkspaceId) setExpandedFolders((current) => new Set(current).add(folderKey(selectedWorkspaceId, effectiveProjectId)))
  }, [selectedProjectId, selectedWorkspaceId, effectiveProjectId])

  function toggle(setter: (update: (current: Set<string>) => Set<string>) => void, key: string) {
    setter((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }

  function renderFolders(folders: WorkspaceEntry[], project?: ProjectEntry) {
    if (folders.length === 0) return <p className="notice project-sidebar-empty">{t("尚未加入資料夾")}</p>
    return <ul className="project-sidebar-folders">
      {folders.map((workspace) => {
        const scope = folderKey(workspace.id, project?.id)
        const expanded = expandedFolders.has(scope)
        const selected = workspace.id === selectedWorkspaceId && project?.id === effectiveProjectId
        return <li key={scope}>
          <div className={`project-sidebar-folder-row${selected ? " is-selected" : ""}`}>
            <button type="button" className="project-sidebar-expander" aria-expanded={expanded} aria-label={t(expanded ? "收合資料夾 {name}" : "展開資料夾 {name}", { name: workspace.label })}
              onClick={() => toggle(setExpandedFolders, scope)}><ChevronRight size={12} aria-hidden="true" /></button>
            <button type="button" className="project-sidebar-folder-select" title={workspace.path} aria-current={selected ? "true" : undefined}
              onClick={() => { setExpandedFolders((current) => new Set(current).add(scope)); props.onSelectWorkspace(workspace.id, project?.id) }}>
              <Folder size={14} aria-hidden="true" /><span>{workspace.label}</span>
            </button>
            {workspace.id === project?.primaryWorkspaceId ? <span className="project-sidebar-primary">{t("主要資料夾")}</span> : null}
          </div>
          {project && !project.workspaceIds.includes(workspace.id) ? <small className="muted">{en ? "Execution starting folder" : "執行起始資料夾"} · {workspace.path}</small> : null}
          {expanded ? <FolderSessions key={scope} bridge={bridge} revision={props.revision} foreign={!!project && !project.workspaceIds.includes(workspace.id)} orphanOnly={!project && assigned.has(workspace.id)} onManageSessions={props.onManageSessions} workspaceId={workspace.id} projectId={project?.id} knownProjectIds={knownProjectIds}
            dashboard={selected ? props.dashboard : undefined} selectedSessionId={selected ? selectedSessionId : undefined}
            attentionBySession={workspace.id === selectedWorkspaceId ? props.attentionBySession : undefined}
            onSelectSession={props.onSelectSession} onManageSession={props.onManageSession} onManageArchived={props.onManageArchived} /> : null}
        </li>
      })}
    </ul>
  }

  return <nav className="sidebar project-sidebar" aria-label={t("專案")}>
    <div className="sidebar-header">
    <div className="brand">I-harness</div>
    <Button variant="ghost" className="sidebar-new" icon={<Plus size={17} />} disabled={!props.canCreate || !selectedWorkspaceId} onClick={props.onCreate}>{t("新增會話")}</Button>
    {props.onPlugins ? <Button variant="ghost" className="sidebar-open" icon={<Puzzle size={16} />} onClick={props.onPlugins}>{t("插件市場")}</Button> : null}
    <div className="project-sidebar-heading"><h2 className="sidebar-title">{t("專案")}</h2><button type="button" className="link-button" onClick={props.onProjects}>{t("管理專案")}</button></div>
    <Button variant="ghost" className="sidebar-open" icon={<FolderOpen size={16} />} onClick={props.onOpenWorkspace}>{t("開啟工作區")}</Button>
    </div>
    <div className="sidebar-scroll">
    {ownerError ? <p role="alert" className="notice error-text">{ownerError}</p> : null}
    <ul className="project-sidebar-tree">
      {[...projects].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)).map((project) => {
        const key = projectKey(project.id)
        const expanded = expandedProjects.has(key)
        const members = workspaces.filter(workspace => project.workspaceIds.includes(workspace.id) || ownerFolders[workspace.id]?.includes(project.id))
        return <li key={project.id}>
          <div className={`project-sidebar-project-row${project.id === effectiveProjectId ? " is-selected" : ""}`}>
            <button type="button" className="project-sidebar-expander" aria-expanded={expanded} aria-label={t(expanded ? "收合專案 {name}" : "展開專案 {name}", { name: project.name })}
              onClick={() => toggle(setExpandedProjects, key)}><ChevronRight size={14} aria-hidden="true" /></button>
            <button type="button" className="project-sidebar-project-select" aria-current={project.id === effectiveProjectId ? "true" : undefined}
              onClick={() => { setExpandedProjects((current) => new Set(current).add(key)); props.onSelectProject(project.id) }}>
              <FolderOpen size={15} aria-hidden="true" /><span className="project-sidebar-project-name">{project.name}</span>
            </button>
            {project.pinned ? <Pin size={12} className="project-sidebar-pin" aria-label={t("已釘選")} /> : null}
          </div>
          {expanded ? renderFolders(members, project) : null}
        </li>
      })}
      {unassigned.length === 0 ? null : <li className="project-sidebar-unassigned">
        <button type="button" className="project-sidebar-unassigned-toggle" aria-expanded={expandedProjects.has(projectKey())} onClick={() => toggle(setExpandedProjects, projectKey())}>
          <ChevronRight size={14} aria-hidden="true" /><span>{t("未分類資料夾")}</span>
        </button>
        {expandedProjects.has(projectKey()) ? renderFolders(unassigned) : null}
      </li>}
    </ul>
    {workspaces.length === 0 && projects.length === 0 ? <p className="notice">{t("尚未開啟工作區")}</p> : null}
    </div>
    {props.onSettings ? <div className="sidebar-footer"><Button variant="ghost" className="sidebar-open" icon={<Settings size={17} />} onClick={props.onSettings}>{t("設定")}</Button></div> : null}
  </nav>
}
