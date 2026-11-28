import type { SessionDashboardResult } from "@i-harness/sdk"
import type { ProjectEntry } from "../../main/projects.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { SessionAction } from './SessionActions.tsx'
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { ChevronRight, FolderOpen, Pin, Plus, Settings, SlidersHorizontal } from "lucide-react"
import { useText } from "../design/i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { affectsSessionDashboard } from "../session/notifications.ts"
import { createWorkspaceConnections } from "../session/workspace-connections.ts"
import { useWindowVisibility } from "../window-visibility.tsx"
import { ProjectSessions, WorkspaceCatalogReader, type SidebarReadMode, type SidebarWorkspaceReader, type SidebarWorkspaceSnapshot } from "./ProjectSessions.tsx"
import "./projects-sidebar.css"

export interface ProjectSidebarProps {
  bridge: DesktopBridge
  visible?: boolean
  sessionRevisionsByWorkspace?: ReadonlyMap<string, number>
  onManageSessions?(workspaceId: string, sessionId?: string): void
  projects: ProjectEntry[]
  workspaces: WorkspaceEntry[]
  selectedProjectId?: string
  selectedWorkspaceId?: string
  selectedSessionId?: string
  projectSelectionPending?: boolean
  dashboard?: SessionDashboardResult
  readOpeningDashboard?(workspaceId: string): Promise<unknown> | undefined
  attentionBySession?: Record<string, number>
  canCreate: boolean
  onCreateSession?(workspaceId: string, projectId?: string): void
  onProjects(): void
  onSettings?(): void
  onPlugins?(): void
  onSelectProject(id: string): void
  onSelectWorkspace(workspaceId: string, projectId?: string): void
  onSelectSession(workspaceId: string, sessionId: string, projectId?: string): void
  onManageSession(workspaceId: string, id: string, action: SessionAction | 'delete', title?: string): Promise<void>
  onManageArchived(workspaceId: string): void
}

const projectKey = (id?: string) => JSON.stringify(id === undefined ? ["unassigned"] : ["project", id])

/** Projects are the visible unit. Folder IDs remain native session sources. */
export function ProjectSidebar(props: ProjectSidebarProps) {
  const lastDashboard = useRef(props.dashboard)
  useLayoutEffect(() => { lastDashboard.current = props.dashboard }, [props.dashboard])
  const [source, setSource] = useState<{ bridge: DesktopBridge; version: number; stale?: SessionDashboardResult }>({ bridge: props.bridge, version: 0 })
  if (source.bridge !== props.bridge) {
    // Folder and conversation IDs can repeat in another host. Drop its rows,
    // open actions, and any foreground dashboard still supplied by the caller.
    setSource({ bridge: props.bridge, version: source.version + 1, stale: lastDashboard.current })
  } else if (source.stale && source.stale !== props.dashboard) {
    setSource({ bridge: source.bridge, version: source.version })
  }
  return <ProjectTree key={source.version} {...props} dashboard={props.dashboard === source.stale ? undefined : props.dashboard} />
}

function ProjectTree(props: ProjectSidebarProps) {
  const t = useText()
  const windowVisible = useWindowVisibility()
  const visible = windowVisible && props.visible !== false
  const { projects, workspaces, selectedProjectId, selectedWorkspaceId, selectedSessionId, bridge } = props
  const [snapshots, setSnapshots] = useState<Record<string, SidebarWorkspaceSnapshot>>({})
  const readers = useRef(new Map<string, SidebarWorkspaceReader>())
  const foreground = useRef(selectedWorkspaceId)
  foreground.current = selectedWorkspaceId
  const [search, setSearch] = useState("")
  const workspaceKey = JSON.stringify(workspaces.map(row => row.id))
  useEffect(() => {
    const ids = new Set(workspaces.map(row => row.id))
    setSnapshots(previous => Object.keys(previous).every(id => ids.has(id)) ? previous
      : Object.fromEntries(Object.entries(previous).filter(([id]) => ids.has(id))))
  }, [workspaceKey])
  useEffect(() => {
    const connections = createWorkspaceConnections()
    const unsubscribe = bridge.onEvent(event => {
      if (event.kind === "window/state" || event.kind === "runtime/diagnostic" || event.kind === "runtime/activity") return
      if (!connections.observe(event)) return
      const reader = readers.current.get(event.workspaceId)
      if (!reader) return
      if (event.kind === "sdk/idle") { reader.standby(); return }
      if (event.kind === "sdk/disconnected") { reader.disconnect(event.message); return }
      if (event.method === "desktop/session/navigation/changed") { reader.refresh(true); return }
      if (reader.mode === "owners") return
      if (event.kind === "sdk/ready") { reader.ready(); return }
      // App refreshes the foreground dashboard for status/activity changes.
      // Newly listed or removed sessions trigger a paired read in the reader.
      if (affectsSessionDashboard(event.method, event.params) &&
          !reader.followsForeground((event.params as { sessionId?: unknown } | null)?.sessionId)) reader.refresh()
    })
    const refreshOnReturn = () => {
      if (document.visibilityState === "hidden" || !foreground.current) return
      const reader = readers.current.get(foreground.current)
      if (reader && reader.mode !== "owners") reader.refresh()
    }
    window.addEventListener("focus", refreshOnReturn)
    document.addEventListener("visibilitychange", refreshOnReturn)
    return () => {
      unsubscribe()
      window.removeEventListener("focus", refreshOnReturn)
      document.removeEventListener("visibilitychange", refreshOnReturn)
    }
  }, [bridge])
  const knownProjectIds = new Set(projects.map(project => project.id))
  const assigned = new Set([
    ...projects.flatMap(project => project.workspaceIds),
    ...workspaces.filter(row => row.worktree && knownProjectIds.has(row.worktree.projectId)).map(row => row.id),
  ])
  const unassigned = workspaces.filter((workspace) => !assigned.has(workspace.id) || [...(snapshots[workspace.id]?.owners ?? [])].some(id => id === undefined || !knownProjectIds.has(id)))
  const managementWorkspace = workspaces.find(workspace => workspace.id === selectedWorkspaceId) ?? workspaces[0]
  const effectiveProjectId = selectedProjectId && knownProjectIds.has(selectedProjectId) ? selectedProjectId : undefined
  const hasProjectSelection = !props.projectSelectionPending && !!(selectedWorkspaceId || selectedProjectId)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set(hasProjectSelection ? [projectKey(effectiveProjectId)] : []))

  useEffect(() => {
    if (!hasProjectSelection) return
    const key = projectKey(effectiveProjectId)
    setExpandedProjects(current => current.has(key) ? current : new Set(current).add(key))
  }, [hasProjectSelection, selectedWorkspaceId, effectiveProjectId])

  const expanded = (id?: string) => expandedProjects.has(projectKey(id)) || search.trim() !== ""
  const members = new Map(projects.map(project => [
    project.id, workspaces.filter(workspace => project.workspaceIds.includes(workspace.id)
      || workspace.worktree?.projectId === project.id || snapshots[workspace.id]?.owners?.has(project.id)),
  ]))
  const readModes = new Map<string, SidebarReadMode>()
  function include(folders: WorkspaceEntry[], projectId?: string) {
    if (!expanded(projectId)) return
    for (const folder of folders) {
      // Project ownership determines grouping and selection, while the
      // foreground dashboard belongs to the workspace throughout that check.
      readModes.set(folder.id, folder.id === selectedWorkspaceId ? "foreground" : "sessions")
    }
  }
  for (const project of projects) include(members.get(project.id)!, project.id)
  include(unassigned)
  const ownerError = workspaces.find(folder => !readModes.has(folder.id) && snapshots[folder.id]?.error)

  function toggleProject(key: string) {
    setExpandedProjects(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }

  function createControl(folder: WorkspaceEntry | undefined, project?: ProjectEntry) {
    const create = props.onCreateSession
    if (!props.canCreate || !create || !folder) return null
    const label = t("在 {name} 開啟新會話", { name: project?.name ?? t("未分類會話") })
    return <button type="button" className="project-sidebar-new" aria-label={label} title={label}
      onClick={() => { setExpandedProjects(current => new Set(current).add(projectKey(project?.id))); create(folder.id, project?.id) }}>
      <Plus size={15} aria-hidden="true" />
    </button>
  }

  function renderSessions(folders: WorkspaceEntry[], project?: ProjectEntry) {
    if (folders.length === 0) return <p className="notice project-sidebar-empty">{t("尚未加入資料夾")}</p>
    const selected = hasProjectSelection && project?.id === effectiveProjectId
    return <ProjectSessions bridge={bridge} workspaces={folders} projectId={project?.id} snapshots={snapshots} readers={readers}
      memberWorkspaceIds={new Set(project?.workspaceIds ?? [])} assignedWorkspaceIds={assigned} knownProjectIds={knownProjectIds}
      selectedWorkspaceId={selected ? selectedWorkspaceId : undefined} selectedSessionId={selected ? selectedSessionId : undefined}
      dashboard={selected ? props.dashboard : undefined} attentionBySession={selected ? props.attentionBySession : undefined}
      onSelectSession={props.onSelectSession} onManageSession={props.onManageSession} onManageArchived={props.onManageArchived} onManageSessions={props.onManageSessions} filter={search} />
  }

  return <nav className="sidebar project-sidebar" aria-label={t("專案")}>
    {workspaces.map(folder => <WorkspaceCatalogReader key={folder.id} bridge={bridge} workspaceId={folder.id} visible={visible}
      mode={readModes.get(folder.id) ?? "owners"} revision={props.sessionRevisionsByWorkspace?.get(folder.id)} readers={readers} setSnapshots={setSnapshots} snapshot={snapshots[folder.id]}
      readOpeningDashboard={props.readOpeningDashboard}
      details={folder.id === selectedWorkspaceId ? props.dashboard : undefined} />)}
    <div className="sidebar-header">
    <div className="brand">I-harness</div>
    <input className="project-sidebar-search" type="search" aria-label={t("搜尋會話")} placeholder={t("搜尋會話")} value={search} onChange={event => setSearch(event.target.value)} />
    <div className="project-sidebar-heading"><h2 className="sidebar-title">{t("專案")}</h2><Button variant="ghost" size="small" className="project-sidebar-manage" icon={<SlidersHorizontal size={14} />} onClick={props.onProjects}>{t("管理專案")}</Button></div>
    </div>
    <div className="sidebar-scroll">
    {ownerError ? <p role="alert" className="notice error-text">{snapshots[ownerError.id]?.error} <button type="button" className="link-button" onClick={() => readers.current.get(ownerError.id)?.refresh()}>{t("重試")}</button></p> : null}
    <ul className="project-sidebar-tree">
      {[...projects].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)).map((project) => {
        const key = projectKey(project.id)
        const open = expanded(project.id)
        // Moved history can appear in this project while its original folder
        // remains outside the project's new-conversation scope.
        const creationFolders = project.workspaceIds.map(id => workspaces.find(workspace => workspace.id === id)).filter(row => row !== undefined)
        const creationFolder = creationFolders.find(folder => folder.id === project.primaryWorkspaceId) ?? creationFolders[0]
        return <li key={project.id}>
          <div className={`project-sidebar-project-row${project.id === effectiveProjectId ? " is-selected" : ""}`}>
            <button type="button" className="project-sidebar-expander" aria-expanded={open} aria-label={t(open ? "收合專案 {name}" : "展開專案 {name}", { name: project.name })}
              onClick={() => toggleProject(key)}><ChevronRight size={14} aria-hidden="true" /></button>
            <button type="button" className="project-sidebar-project-select" aria-current={project.id === effectiveProjectId ? "true" : undefined}
              onClick={() => { setExpandedProjects((current) => new Set(current).add(key)); props.onSelectProject(project.id) }}>
              <FolderOpen size={15} aria-hidden="true" /><span className="project-sidebar-project-name">{project.name}</span>
            </button>
            {project.pinned ? <Pin size={12} className="project-sidebar-pin" aria-label={t("已釘選")} /> : null}
            {createControl(creationFolder, project)}
          </div>
          {open ? renderSessions(members.get(project.id)!, project) : null}
        </li>
      })}
      {unassigned.length === 0 ? null : <li className="project-sidebar-unassigned">
        <div className="project-sidebar-project-row">
          <button type="button" className="project-sidebar-unassigned-toggle" aria-expanded={expanded()} onClick={() => toggleProject(projectKey())}>
            <ChevronRight size={14} aria-hidden="true" /><span>{t("未分類會話")}</span>
          </button>
          {createControl(unassigned.find(folder => folder.id === selectedWorkspaceId) ?? unassigned[0])}
        </div>
        {expanded() ? renderSessions(unassigned) : null}
      </li>}
    </ul>
    {workspaces.length === 0 && projects.length === 0 ? <p className="notice">{t("尚未開啟專案")}</p> : null}
    </div>
    {managementWorkspace ? <div className="project-sidebar-management">
      {props.onManageSessions
        ? <button type="button" className="session-archived-button" onClick={() => props.onManageSessions!(managementWorkspace.id, undefined)}>{t("管理會話…")}</button>
        : <button type="button" className="session-archived-button" onClick={() => props.onManageArchived(managementWorkspace.id)}>{t("管理已封存會話")}</button>}
    </div> : null}
    {props.onSettings ? <div className="sidebar-footer"><Button variant="ghost" className="sidebar-open" icon={<Settings size={17} />} onClick={props.onSettings}>{t("設定")}</Button></div> : null}
  </nav>
}
