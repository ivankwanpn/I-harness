import type { SessionDashboardResult } from "@i-harness/sdk"
import type { ProjectEntry } from "../../main/projects.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { SessionAction } from './SessionActions.tsx'
import { useCallback, useEffect, useState } from "react"
import { ChevronRight, FolderOpen, Pin, Plus, Settings, SlidersHorizontal } from "lucide-react"
import { useText, useLocale } from "../design/i18n.ts"
import { Button } from "../vendor/opencode/Button.tsx"
import { createRefreshScheduler } from "../session/refresh-scheduler.ts"
import { ProjectSessions } from "./ProjectSessions.tsx"
import { confirmedSessionNavigation, isSessionNavigationState } from "./project-sessions.ts"
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
  projectSelectionPending?: boolean
  dashboard?: SessionDashboardResult
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
  const t = useText()
  const en = useLocale(state => state.locale) === "en"
  const { projects, workspaces, selectedProjectId, selectedWorkspaceId, selectedSessionId, bridge } = props
  const [ownerStates, setOwnerStates] = useState<Record<string, { owners: (string | undefined)[]; error?: string }>>({})
  const onOwners = useCallback((workspaceId: string, owners: (string | undefined)[], error?: string) => {
    setOwnerStates(previous => {
      const saved = previous[workspaceId]
      if (saved && saved.error === error && JSON.stringify(saved.owners) === JSON.stringify(owners)) return previous
      return { ...previous, [workspaceId]: { owners, error } }
    })
  }, [])
  const [search, setSearch] = useState("")
  const workspaceKey = JSON.stringify(workspaces.map(row => row.id))
  useEffect(() => {
    let active = true
    const ids = new Set(workspaces.map(workspace => workspace.id))
    setOwnerStates(previous => {
      const entries = Object.entries(previous)
      return entries.every(([id]) => ids.has(id)) ? previous : Object.fromEntries(entries.filter(([id]) => ids.has(id)))
    })
    async function readOwners(workspaceId: string) {
      try {
        // Cold folders use the native committed catalog without starting a gateway.
        const rows = await bridge.request({ kind: "desktop/session/navigation/state", workspaceId })
        if (!isSessionNavigationState(rows)) throw new Error(en ? "Conversation ownership is unavailable" : "會話分組狀態無法確認")
        if (active) onOwners(workspaceId, [...new Set(Object.values(rows).flatMap(row => confirmedSessionNavigation(row) ? [row.projectId] : []))])
      } catch (error) { if (active) onOwners(workspaceId, [], String(error)) }
    }
    const refreshers = new Map([...ids].map(id => [id, createRefreshScheduler(() => readOwners(id))]))
    const unsubscribe = bridge.onEvent(event => {
      if (event.kind === "sdk/notification" && event.method === "desktop/session/navigation/changed") refreshers.get(event.workspaceId)?.schedule()
    })
    for (const refresh of refreshers.values()) refresh.schedule(0)
    return () => { active = false; for (const refresh of refreshers.values()) refresh.dispose(); unsubscribe() }
  }, [bridge, workspaceKey, props.revision, en, onOwners])
  const ownerError = workspaces.map(workspace => ownerStates[workspace.id]?.error).find(error => error !== undefined)
  const assigned = new Set(projects.flatMap((project) => project.workspaceIds))
  const knownProjectIds = new Set(projects.map(project => project.id))
  const unassigned = workspaces.filter((workspace) => !assigned.has(workspace.id) || ownerStates[workspace.id]?.owners.some(id => id === undefined || !knownProjectIds.has(id)))
  const managementWorkspace = workspaces.find(workspace => workspace.id === selectedWorkspaceId) ?? workspaces[0]
  const effectiveProjectId = selectedProjectId && knownProjectIds.has(selectedProjectId) ? selectedProjectId : undefined
  const hasProjectSelection = !props.projectSelectionPending && !!(selectedWorkspaceId || selectedProjectId)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set(hasProjectSelection ? [projectKey(effectiveProjectId)] : []))

  useEffect(() => {
    if (!hasProjectSelection) return
    const key = projectKey(effectiveProjectId)
    setExpandedProjects(current => current.has(key) ? current : new Set(current).add(key))
  }, [hasProjectSelection, selectedWorkspaceId, effectiveProjectId])

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
    return <ProjectSessions bridge={bridge} revision={props.revision} workspaces={folders} projectId={project?.id} onOwners={onOwners}
      memberWorkspaceIds={new Set(project?.workspaceIds ?? [])} assignedWorkspaceIds={assigned} knownProjectIds={knownProjectIds}
      selectedWorkspaceId={selected ? selectedWorkspaceId : undefined} selectedSessionId={selected ? selectedSessionId : undefined}
      dashboard={selected ? props.dashboard : undefined} attentionBySession={selected ? props.attentionBySession : undefined}
      onSelectSession={props.onSelectSession} onManageSession={props.onManageSession} onManageArchived={props.onManageArchived} onManageSessions={props.onManageSessions} filter={search} />
  }

  return <nav className="sidebar project-sidebar" aria-label={t("專案")}>
    <div className="sidebar-header">
    <div className="brand">I-harness</div>
    <input className="project-sidebar-search" type="search" aria-label={t("搜尋會話")} placeholder={t("搜尋會話")} value={search} onChange={event => setSearch(event.target.value)} />
    <div className="project-sidebar-heading"><h2 className="sidebar-title">{t("專案")}</h2><Button variant="ghost" size="small" className="project-sidebar-manage" icon={<SlidersHorizontal size={14} />} onClick={props.onProjects}>{t("管理專案")}</Button></div>
    </div>
    <div className="sidebar-scroll">
    {ownerError ? <p role="alert" className="notice error-text">{ownerError}</p> : null}
    <ul className="project-sidebar-tree">
      {[...projects].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)).map((project) => {
        const key = projectKey(project.id)
        const expanded = expandedProjects.has(key) || search.trim() !== ""
        const members = workspaces.filter(workspace => project.workspaceIds.includes(workspace.id) || ownerStates[workspace.id]?.owners.includes(project.id))
        // Moved history can appear in this project while its original folder
        // remains outside the project's new-conversation scope.
        const creationFolders = project.workspaceIds.map(id => workspaces.find(workspace => workspace.id === id)).filter(row => row !== undefined)
        const creationFolder = creationFolders.find(folder => folder.id === project.primaryWorkspaceId) ?? creationFolders[0]
        return <li key={project.id}>
          <div className={`project-sidebar-project-row${project.id === effectiveProjectId ? " is-selected" : ""}`}>
            <button type="button" className="project-sidebar-expander" aria-expanded={expanded} aria-label={t(expanded ? "收合專案 {name}" : "展開專案 {name}", { name: project.name })}
              onClick={() => toggleProject(key)}><ChevronRight size={14} aria-hidden="true" /></button>
            <button type="button" className="project-sidebar-project-select" aria-current={project.id === effectiveProjectId ? "true" : undefined}
              onClick={() => { setExpandedProjects((current) => new Set(current).add(key)); props.onSelectProject(project.id) }}>
              <FolderOpen size={15} aria-hidden="true" /><span className="project-sidebar-project-name">{project.name}</span>
            </button>
            {project.pinned ? <Pin size={12} className="project-sidebar-pin" aria-label={t("已釘選")} /> : null}
            {createControl(creationFolder, project)}
          </div>
          {expanded ? renderSessions(members, project) : null}
        </li>
      })}
      {unassigned.length === 0 ? null : <li className="project-sidebar-unassigned">
        <div className="project-sidebar-project-row">
          <button type="button" className="project-sidebar-unassigned-toggle" aria-expanded={expandedProjects.has(projectKey()) || search.trim() !== ""} onClick={() => toggleProject(projectKey())}>
            <ChevronRight size={14} aria-hidden="true" /><span>{t("未分類會話")}</span>
          </button>
          {createControl(unassigned.find(folder => folder.id === selectedWorkspaceId) ?? unassigned[0])}
        </div>
        {expandedProjects.has(projectKey()) || search.trim() !== "" ? renderSessions(unassigned) : null}
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
