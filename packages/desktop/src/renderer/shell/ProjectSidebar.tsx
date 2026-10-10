import type { SessionDashboardResult } from "@i-harness/sdk"
import type { ProjectEntry } from "../../main/projects.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import type { SessionManagementAction } from "@i-harness/desktop-gateway/src/session-management.ts"
import { useEffect, useState } from "react"
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
  dashboard?: SessionDashboardResult
  attentionBySession?: Record<string, number>
  canCreate: boolean
  onCreate(): void
  onProjects(): void
  onSettings?(): void
  onPlugins?(): void
  onSelectProject(id: string): void
  onSelectWorkspace(workspaceId: string, projectId?: string): void
  onSelectSession(workspaceId: string, sessionId: string, projectId?: string): void
  onManageSession(workspaceId: string, id: string, action: SessionManagementAction, title?: string): Promise<void>
  onManageArchived(workspaceId: string): void
}

const projectKey = (id?: string) => JSON.stringify(id === undefined ? ["unassigned"] : ["project", id])

/** Projects are the visible unit. Folder IDs remain native session sources. */
export function ProjectSidebar(props: ProjectSidebarProps) {
  const t = useText()
  const en = useLocale(state => state.locale) === "en"
  const { projects, workspaces, selectedProjectId, selectedWorkspaceId, selectedSessionId, bridge } = props
  const [workspaceOwners, setWorkspaceOwners] = useState<Record<string, (string | undefined)[]>>({})
  const [ownerError, setOwnerError] = useState<string>()
  const workspaceKey = JSON.stringify(workspaces.map(row => row.id))
  useEffect(() => {
    let active = true
    let version = 0
    async function readOwners() {
      const own = ++version
      const results = await Promise.allSettled(workspaces.map(async workspace => {
        const rows = await bridge.request({ kind: "desktop/session/navigation/state", workspaceId: workspace.id })
        if (!isSessionNavigationState(rows)) throw new Error(en ? "Conversation ownership is unavailable" : "會話分組狀態無法確認")
        return { workspaceId: workspace.id, owners: [...new Set(Object.values(rows).flatMap(row => confirmedSessionNavigation(row) ? [row.projectId] : []))] }
      }))
      if (!active || own !== version) return
      setWorkspaceOwners(previous => {
        const next = { ...previous }
        results.forEach((result, index) => { if (result.status === "fulfilled") next[result.value.workspaceId] = result.value.owners; else if (workspaces[index]) next[workspaces[index]!.id] = [] })
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
  const unassigned = workspaces.filter((workspace) => !assigned.has(workspace.id) || workspaceOwners[workspace.id]?.some(id => id === undefined || !knownProjectIds.has(id)))
  const effectiveProjectId = selectedProjectId && knownProjectIds.has(selectedProjectId) ? selectedProjectId : undefined
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set(selectedWorkspaceId || selectedProjectId ? [projectKey(effectiveProjectId)] : []))

  useEffect(() => {
    if (selectedProjectId || selectedWorkspaceId) setExpandedProjects((current) => new Set(current).add(projectKey(effectiveProjectId)))
  }, [selectedProjectId, selectedWorkspaceId, effectiveProjectId])

  function toggle(setter: (update: (current: Set<string>) => Set<string>) => void, key: string) {
    setter((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }

  function renderSessions(folders: WorkspaceEntry[], project?: ProjectEntry) {
    if (folders.length === 0) return <p className="notice project-sidebar-empty">{t("尚未加入資料夾")}</p>
    const selected = project?.id === effectiveProjectId
    return <ProjectSessions bridge={bridge} revision={props.revision} workspaces={folders} projectId={project?.id} primaryWorkspaceId={project?.primaryWorkspaceId}
      memberWorkspaceIds={new Set(project?.workspaceIds ?? [])} assignedWorkspaceIds={assigned} knownProjectIds={knownProjectIds}
      selectedWorkspaceId={selected ? selectedWorkspaceId : undefined} selectedSessionId={selected ? selectedSessionId : undefined}
      dashboard={selected ? props.dashboard : undefined} attentionBySession={selected ? props.attentionBySession : undefined}
      onSelectSession={props.onSelectSession} onManageSession={props.onManageSession} onManageSessions={props.onManageSessions} onManageArchived={props.onManageArchived} />
  }

  return <nav className="sidebar project-sidebar" aria-label={t("專案")}>
    <div className="sidebar-header">
    <div className="brand">I-harness</div>
    <Button variant="ghost" className="sidebar-new" icon={<Plus size={17} />} disabled={!props.canCreate} onClick={props.onCreate}>{t("新增會話")}</Button>
    <div className="project-sidebar-heading"><h2 className="sidebar-title">{t("專案")}</h2><Button variant="ghost" size="small" className="project-sidebar-manage" icon={<SlidersHorizontal size={14} />} onClick={props.onProjects}>{t("管理專案")}</Button></div>
    </div>
    <div className="sidebar-scroll">
    {ownerError ? <p role="alert" className="notice error-text">{ownerError}</p> : null}
    <ul className="project-sidebar-tree">
      {[...projects].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)).map((project) => {
        const key = projectKey(project.id)
        const expanded = expandedProjects.has(key)
        const members = workspaces.filter(workspace => project.workspaceIds.includes(workspace.id) || workspaceOwners[workspace.id]?.includes(project.id))
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
          {expanded ? renderSessions(members, project) : null}
        </li>
      })}
      {unassigned.length === 0 ? null : <li className="project-sidebar-unassigned">
        <button type="button" className="project-sidebar-unassigned-toggle" aria-expanded={expandedProjects.has(projectKey())} onClick={() => toggle(setExpandedProjects, projectKey())}>
          <ChevronRight size={14} aria-hidden="true" /><span>{t("未分類會話")}</span>
        </button>
        {expandedProjects.has(projectKey()) ? renderSessions(unassigned) : null}
      </li>}
    </ul>
    {workspaces.length === 0 && projects.length === 0 ? <p className="notice">{t("尚未開啟專案")}</p> : null}
    </div>
    {props.onSettings ? <div className="sidebar-footer"><Button variant="ghost" className="sidebar-open" icon={<Settings size={17} />} onClick={props.onSettings}>{t("設定")}</Button></div> : null}
  </nav>
}
