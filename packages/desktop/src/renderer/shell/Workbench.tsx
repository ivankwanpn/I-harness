import { useEffect, useId, useRef, useState, useCallback, lazy, Suspense, type CSSProperties } from "react"
import { Brain, Search, PanelLeft, PanelRight, FolderOpen, TerminalSquare, Globe, UsersRound, Code2, Activity, Wrench, Target, Network, ListTodo, ShieldCheck } from "lucide-react"
import { BrowserPane } from "../browser/BrowserPane.tsx"
import { WorkbenchTools, type WorkbenchTool } from "./WorkbenchTools.tsx"
import { useUiStore } from "./ui-store.ts"
import { useText, useLocale } from "../design/i18n.ts"
import { MemoryPane } from "../memory/MemoryPane.tsx"
import { SessionSearch } from "../session/SessionSearch.tsx"
import { SessionHistoryView, type SessionHistoryViewProps } from "../session/SessionHistoryView.tsx"
import type { HistorySelection } from "../session/SessionSearch.tsx"
import { SettingsPane } from "../settings/SettingsPane.tsx"
import { PluginMarketplace } from "../settings/PluginMarketplace.tsx"
const TerminalPane = lazy(() => import("../terminal/TerminalPane.tsx").then((module) => ({ default: module.TerminalPane })))
import { useAppearance, usePreferences } from "../design/preferences.ts"
import type { SessionOperation } from "../session/use-session-operation.ts"
import type { AgentTaskView, SessionDashboardResult, SessionQueueItem } from "@i-harness/sdk"
import type { SandboxState } from "../../main/sdk-runtime.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { ProjectEntry } from "../../main/projects.ts"
import { ProjectSidebar } from "./ProjectSidebar.tsx"
import { ProjectManager } from "../projects/ProjectManager.tsx"
import { SettingsDialog } from "../settings/SettingsDialog.tsx"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { Composer, NewTaskComposer, readDraft, writeDraft, boundedDraft } from "../session/Composer.tsx"
import type { TimelineRow } from "../session/project.ts"
import { ExecutionPane } from "../session/ExecutionPane.tsx"
import { AgentProcessesPane } from "../session/AgentProcessesPane.tsx"
import { DiagnosticsPane } from "../settings/DiagnosticsPane.tsx"
import type { ExternalFileTarget, FileNavigation, ProjectFileTarget } from "../session/file-navigation.ts"
import { TaskPane } from "../session/TaskPane.tsx"
import { TodoProgress } from "../session/TodoProgress.tsx"
import { WorkflowPane } from "../session/WorkflowPane.tsx"
import { SubagentPane } from "../session/SubagentPane.tsx"
import { SchedulePane } from "../session/SchedulePane.tsx"
import { Timeline } from "../session/Timeline.tsx"
import { PendingPanel, type InteractionReply } from "../interaction/PendingPanel.tsx"
import type { PendingInteraction } from "../interaction/pending.ts"
import { ReviewPane, type ReviewChanges, type ReviewText } from "../review/ReviewPane.tsx"
import { TaskList } from "./TaskList.tsx"
import { WorkspaceSidebar } from "./WorkspaceSidebar.tsx"
import { NavigationRail } from "./NavigationRail.tsx"
import { TitleBar } from "./TitleBar.tsx"
import { useNarrowSidebar } from "./use-narrow-sidebar.ts"
import { ReviewResizeHandle } from "../review/ReviewResizeHandle.tsx"
import { PaneResizeHandle } from "./PaneResizeHandle.tsx"
import { PaneTabs } from "../vendor/zcode/PaneTabs.tsx"
import { SessionModelPicker } from "../session/SessionModelPicker.tsx"
import type { ImageInput } from "@i-harness/sdk"
import { SessionManager, type ManageSession } from "../session/SessionManager.tsx"
import type { SessionModelSelection, SessionModelState } from "@i-harness/sdk"
import type { DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"

export interface ConversationView {
  rows: TimelineRow[]
  canSend: boolean
  projectReady?: boolean
  sendReason?: string
  executionError?: string
  running: boolean
  modelLabel?: string
  modelState?: SessionModelState
  onSetModel?(selection: SessionModelSelection): Promise<void>
  operation?: SessionOperation
  canCompact?: boolean
  onCompact?(instructions?: string): Promise<void>
  queue?: SessionQueueItem[]
  queueResumable?: boolean
  onResumeQueue?(): Promise<void>
  onSteer?(text: string, context?: string, images?: ImageInput[], onAdmitted?: () => void): Promise<void>
  tasks?: AgentTaskView[]
  workState?: DesktopWorkStateView
  workStateError?: string
  onRetryWorkState?(): void
  onWriteTodos?(input: import("@i-harness/desktop-gateway/src/work-state.ts").DesktopTodoWriteInput): Promise<void>
  taskError?: string
  historyError?: string
  historyNotice?: string
  pending: PendingInteraction[]
  onPrompt(text: string, context?: string, images?: ImageInput[], onAdmitted?: () => void): Promise<void>
  onCancel(): void
  onCancelTask(taskId: string): void
  onCancelQueue(queueId: string): void
  onReply(reply: InteractionReply): Promise<void>
}

export interface ReviewView {
  projectFiles?: import("../review/ProjectFilesPane.tsx").ProjectFilesPaneProps
  onSaveFile?: import("../review/ReviewPane.tsx").ReviewPaneProps["onSaveFile"]
  onStage?: import("../review/ReviewPane.tsx").ReviewPaneProps["onStage"]
  onUnstage?: import("../review/ReviewPane.tsx").ReviewPaneProps["onUnstage"]
  onCommit?: import("../review/ReviewPane.tsx").ReviewPaneProps["onCommit"]
  changes?: ReviewChanges
  error?: string
  selected?: { path: string; mode: "diff" | "preview" }
  diff?: ReviewText
  preview?: ReviewText
  onSelect(path: string, mode: "diff" | "preview"): void
  onRefresh(): void
}

export interface WorkbenchProps {
  onSelectHistory?(selection: HistorySelection): void
  historicalView?: SessionHistoryViewProps
  onOpenProjectFile?(ref: ProjectFileTarget): void
  onOpenExternalFile?(target: ExternalFileTarget): void
  onBatchSessions?(workspaceId: string, command: import("../session/SessionManager.tsx").ManageSessionBatchCommand): Promise<import("../session/SessionManager.tsx").ManageSessionBatchResult>
  bridge: DesktopBridge
  workspaces: WorkspaceEntry[]
  projects?: ProjectEntry[]
  selectedProjectId?: string
  onProjectsChanged?(): Promise<void>
  onSelectProject?(id: string): void
  onSelectSessionInWorkspace?(workspaceId: string, sessionId: string, projectId?: string): void
  onManageSessionInWorkspace?(workspaceId: string, sessionId: string, action: Parameters<ManageSession>[1], title?: string): Promise<void>
  dashboard?: SessionDashboardResult
  attentionBySession?: Record<string, number>
  connection?: "online" | "offline" | "connecting" | "reconnecting"
  capabilities: Record<string, string[]>
  capabilitiesReady?: boolean
  sandbox?: SandboxState
  error?: string
  selectedWorkspaceId?: string
  selectedSessionId?: string
  conversation?: ConversationView
  review?: ReviewView
  onRetry?(): void
  onOpenWorkspace?(): void
  onSelectWorkspace(workspaceId: string, projectId?: string): void
  onSelectSession(sessionId: string): void
  onManageSession?: ManageSession
  onRewindComplete?: (workspaceId: string, sessionId: string) => void
  onSessionsChanged?(): void
  onSandboxChange?(mode: SandboxState["mode"]): void
}

export function Workbench({
  bridge,
  workspaces,
  projects,
  selectedProjectId,
  onProjectsChanged,
  onSelectProject,
  onSelectSessionInWorkspace,
  onManageSessionInWorkspace,
  dashboard,
  attentionBySession,
  connection,
  capabilities,
  capabilitiesReady,
  error,
  selectedWorkspaceId,
  selectedSessionId,
  onSelectWorkspace,
  onSelectSession,
  onSelectHistory,
  historicalView,
  onOpenProjectFile,
  onOpenExternalFile,
  onBatchSessions,
  onManageSession,
  onRewindComplete,
  onSessionsChanged,
  onSandboxChange,
  conversation,
  review,
  onRetry,
  onOpenWorkspace,
}: WorkbenchProps) {
  const t = useText()
  const english = useLocale(state => state.locale) === "en"
  const diagnosticsLabel = english ? "Tool diagnostics" : "工具與環境診斷"
  const processesLabel = english ? "Agent processes" : "Agent 程序"
  const draftRequest = useCallback((request: import("../../shared/attachment-drafts.ts").DraftRequest) => bridge.request(request) as Promise<import("../../shared/attachment-drafts.ts").DurableDraft>, [bridge])
  const authoringRequest = useCallback((request: import("../../shared/bridge.ts").DesktopRequest) => bridge.request(request), [bridge])
  const drawer = useNarrowSidebar()
  const drawerWorkspace = useRef(selectedWorkspaceId)
  useEffect(() => {
    if (drawerWorkspace.current === selectedWorkspaceId) return
    drawerWorkspace.current = selectedWorkspaceId
    if (selectedWorkspaceId !== undefined) drawer.setOpen(false)
  }, [selectedWorkspaceId, drawer.setOpen])
  useAppearance()
  const sidebarCollapsed = usePreferences((state) => state.sidebarCollapsed)
  const preferredSidebarWidth = useUiStore(state => state.sidebarWidth)
  const setSidebarWidth = useUiStore(state => state.setSidebarWidth)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const resized = () => setViewportWidth(window.innerWidth)
    window.addEventListener("resize", resized)
    return () => window.removeEventListener("resize", resized)
  }, [])
  const updatePreferences = usePreferences((state) => state.update)
  const [manager, setManager] = useState<{ workspaceId: string; archived?: boolean; sessionId?: string }>()
  const [managerBusy, setManagerBusy] = useState(false)
  const managerOwner = useRef(manager)
  managerOwner.current = manager
  const [sidebarRevision, setSidebarRevision] = useState(0)
  const [managerOwners, setManagerOwners] = useState<Record<string, string | undefined>>()
  const workspaceScope = useRef({ id: selectedWorkspaceId, sessionId: selectedSessionId, projectId: selectedProjectId })
  if (workspaceScope.current.id !== selectedWorkspaceId || workspaceScope.current.sessionId !== selectedSessionId || workspaceScope.current.projectId !== selectedProjectId) workspaceScope.current = { id: selectedWorkspaceId, sessionId: selectedSessionId, projectId: selectedProjectId }
  const [workPaneTab, setWorkPaneTab] = useState("changes")
  const [workflowSection, setWorkflowSection] = useState<"goal" | "team" | "jobs" | "reviews">("goal")
  useEffect(() => {
    if ((workPaneTab === "execution" && (!selectedSessionId || !capabilities["desktop-execution"]?.includes("1"))) || (workPaneTab === "processes" && (!selectedSessionId || !capabilities["desktop-agent-processes"]?.includes("1"))) || (workPaneTab === "diagnostics" && !capabilities["desktop-environment-diagnostics"]?.includes("1"))) setWorkPaneTab("changes")
    if (workPaneTab === "reminders" && (!selectedSessionId || !capabilities["desktop-schedule"]?.includes("1"))) setWorkPaneTab("changes")
    if (workPaneTab === "subagents" && (!selectedSessionId || !capabilities["desktop-subagent-catalog"]?.includes("1"))) setWorkPaneTab("changes")
  }, [workPaneTab, selectedSessionId, capabilities])
  useEffect(() => {
    const workspaceId = manager?.workspaceId ?? selectedWorkspaceId
    if (!workspaceId) { setManagerOwners(undefined); return }
    let active = true
    setManagerOwners(undefined)
    void bridge.request({ kind: "desktop/session/navigation/state", workspaceId }).then(value => {
      if (active && value && typeof value === "object") setManagerOwners(Object.fromEntries(Object.entries(value).map(([id, row]) => [id, (row as { projectId?: string }).projectId])))
    }).catch(() => undefined)
    return () => { active = false }
  }, [bridge, manager?.workspaceId, selectedWorkspaceId, sidebarRevision])
  const openManager = (workspaceId: string, sessionId?: string, archived = false) => { setManagerBusy(false); setManager({ workspaceId, sessionId, archived }) }
  const managerManage = manager ? onManageSessionInWorkspace ? (id: string, action: Parameters<ManageSession>[1], title?: string) => onManageSessionInWorkspace(manager.workspaceId, id, action, title) : manager.workspaceId === selectedWorkspaceId ? onManageSession : undefined : undefined
  const batchRequest = useCallback(async (workspaceId: string, command: import("../session/SessionManager.tsx").ManageSessionBatchCommand) => {
    if (!onBatchSessions) throw new Error("Session batch management unavailable")
    const result = await onBatchSessions(workspaceId, command)
    if (result.results.some(row => row.ok)) setSidebarRevision(value => value + 1)
    return result
  }, [onBatchSessions])
  const notificationNavigation = useRef(0)
  const openNotification = useCallback(async (target: { workspaceId: string; sessionId: string }) => {
    const scope = workspaceScope.current
    const ticket = ++notificationNavigation.current
    const validated = await bridge.request({ kind: "desktop/notifications/target", ...target }) as { workspaceId: string; sessionId: string; projectId?: string }
    if (workspaceScope.current !== scope || notificationNavigation.current !== ticket || useUiStore.getState().surface !== "settings") return
    if (validated.workspaceId !== target.workspaceId || validated.sessionId !== target.sessionId) throw new Error("Invalid notification target")
    if (!onSelectSessionInWorkspace) throw new Error("Conversation navigation unavailable")
    onSelectSessionInWorkspace(validated.workspaceId, validated.sessionId, validated.projectId)
    useUiStore.getState().setSurface("conversation")
  }, [bridge, onSelectSessionInWorkspace])
  const workPaneId = useId()
  const surface = useUiStore((state) => state.surface)
  const setSurface = useUiStore((state) => state.setSurface)
  const memoryOpen = surface === "memory"
  const setMemoryOpen = (open: boolean | ((current: boolean) => boolean)) => setSurface((typeof open === "function" ? open(memoryOpen) : open) ? "memory" : "conversation")
  const reviewOpen = useUiStore((state) => state.reviewOpen)
  const reviewWidth = useUiStore((state) => state.reviewWidth)
  const setReviewWidth = useUiStore((state) => state.setReviewWidth)
  const toggleReview = useUiStore((state) => state.toggleReview)
  const todoFocusScope = useRef<{ workspaceId?: string; sessionId?: string } | undefined>(undefined)
  function focusTodoEditor() {
    const panel = document.getElementById(`${workPaneId}-panel`)
    const target = panel?.querySelector<HTMLElement>(".todo-edit-input") ?? panel?.querySelector<HTMLElement>(".todo-add-button:not(:disabled)") ?? panel?.querySelector<HTMLElement>(".task-pane button:not(:disabled)")
    target?.focus()
  }
  function openTodoEditor() {
    if (reviewOpen && workPaneTab === "tasks") { focusTodoEditor(); return }
    todoFocusScope.current = { workspaceId: selectedWorkspaceId, sessionId: selectedSessionId }
    if (!reviewOpen) toggleReview()
    setWorkPaneTab("tasks")
  }
  useEffect(() => {
    const requested = todoFocusScope.current
    if (!requested) return
    if (requested.workspaceId !== selectedWorkspaceId || requested.sessionId !== selectedSessionId) { todoFocusScope.current = undefined; return }
    if (reviewOpen && workPaneTab === "tasks") { todoFocusScope.current = undefined; focusTodoEditor() }
  }, [reviewOpen, workPaneTab, selectedWorkspaceId, selectedSessionId])
  const sessionTitle = dashboard?.sessions.find((row) => row.id === selectedSessionId)?.title ?? t("未命名會話")
  function openPane(name: string) {
    setSurface("conversation")
    if (!reviewOpen) toggleReview()
    setWorkPaneTab(name)
  }
  function openWorkflow(name: string) {
    if (name === "settings") { setSurface("settings"); return }
    setSurface("conversation")
    if (!reviewOpen) toggleReview()
    setWorkflowSection(name === "team" || name === "jobs" || name === "reviews" ? name : "goal")
    setWorkPaneTab("workflow")
  }
  const workspaceTitle = workspaces.find((row) => row.id === selectedWorkspaceId)?.label ?? t("尚未選擇會話")
  const selectedProject = projects?.find((project) => project.id === selectedProjectId)
  const canCreate = capabilities["session-create"]?.includes("1") === true && (!selectedProject || selectedProject.workspaceIds.includes(selectedWorkspaceId ?? ""))
  const fileProjectMembers = projects?.find(project => project.id === review?.projectFiles?.selection.projectId)?.workspaceIds
  const fileProjectRoots = review?.projectFiles ? workspaces.filter(row => review.projectFiles?.selection.projectId ? fileProjectMembers?.includes(row.id) : row.id === selectedWorkspaceId).map(row => ({ workspaceId: row.id, path: row.path })) : undefined
  const fileMembershipRevision = fileProjectRoots ? JSON.stringify(fileProjectRoots.map(root => [root.workspaceId, root.path] as const).sort((left, right) => left[0].localeCompare(right[0]))) : undefined
  const fileNavigation: FileNavigation | undefined = review && selectedWorkspaceId && (capabilities["desktop-review"]?.includes("1") || review.projectFiles) ? {
    workspaceId: selectedWorkspaceId, workspacePath: workspaces.find(row => row.id === selectedWorkspaceId)?.path ?? "",
    projectRoots: fileProjectRoots,
    onOpenProjectFile: review.projectFiles && onOpenProjectFile ? ref => { if (!reviewOpen) toggleReview(); setWorkPaneTab("changes"); onOpenProjectFile({ ...ref }) } : undefined,
    onOpenExternalFile: review.projectFiles && onOpenExternalFile && capabilities["desktop-project-content-search"]?.includes("1") ? target => { if (!reviewOpen) toggleReview(); setWorkPaneTab("changes"); onOpenExternalFile({ ...target, reference: { ...target.reference } }) } : undefined,
    onOpenFile: path => { if (!reviewOpen) toggleReview(); setWorkPaneTab("changes"); review.onSelect(path, "preview") },
  } : undefined

  async function createSession(): Promise<void> {
    if (selectedWorkspaceId === undefined) return
    drawer.setOpen(false)
    setMemoryOpen(false)
    onSelectWorkspace(selectedWorkspaceId, selectedProjectId)
  }

  const settingsVisited = useRef(surface === "settings")
  if (surface === "settings") settingsVisited.current = true
  const settingsPane = settingsVisited.current ? <SettingsPane active={surface === "settings"} sessionId={selectedSessionId} onOpenConversation={openNotification} capabilitiesReady={capabilitiesReady} onSandboxChange={onSandboxChange} onUseResource={selectedWorkspaceId && selectedSessionId ? (prefix) => {
    const draft = readDraft(selectedWorkspaceId, selectedSessionId)
    const next = draft.startsWith(prefix) ? draft : prefix + draft
    if (boundedDraft(next) !== next) throw new Error(t("草稿已達上限，請先整理內容。"))
    writeDraft(selectedWorkspaceId, selectedSessionId, next)
    setSurface("conversation")
  } : undefined} capabilities={capabilities} bridge={bridge} workspace={workspaces.find((row) => row.id === selectedWorkspaceId)} onClose={() => setSurface("conversation")} /> : null

  const projectsPane = surface === "projects" && onProjectsChanged ? <ProjectManager bridge={bridge} projects={projects ?? []} workspaces={workspaces} onChanged={onProjectsChanged} onOpen={(project) => { onSelectProject?.(project.id); setSurface("conversation") }} onClose={() => setSurface("conversation")} /> : null

  const pageOpen = surface === "settings" || projectsPane !== null
  const workScope = JSON.stringify([selectedWorkspaceId, selectedSessionId])
  const visitedWork = useRef({ scope: workScope, tabs: new Set<string>() })
  const visitedWorkspacePanes = useRef({ scope: selectedWorkspaceId, tabs: new Set<string>() })
  if (visitedWorkspacePanes.current.scope !== selectedWorkspaceId) visitedWorkspacePanes.current = { scope: selectedWorkspaceId, tabs: new Set() }
  if (visitedWork.current.scope !== workScope) visitedWork.current = { scope: workScope, tabs: new Set() }
  if (reviewOpen && !pageOpen && selectedWorkspaceId && selectedSessionId && (workPaneTab === "workflow" || workPaneTab === "reminders")) visitedWork.current.tabs.add(workPaneTab)
  if (reviewOpen && !pageOpen && selectedWorkspaceId && (workPaneTab === "browser" || workPaneTab === "terminal")) visitedWorkspacePanes.current.tabs.add(workPaneTab)
  const workVisible = reviewOpen && !pageOpen
  const toggleSidebar = () => {
    if (pageOpen) { setSurface("conversation"); if (drawer.narrow) drawer.setOpen(true); else updatePreferences({ sidebarCollapsed: false }); return }
    if (drawer.narrow) drawer.setOpen(!drawer.open)
    else updatePreferences({ sidebarCollapsed: !sidebarCollapsed })
  }
  const navigate = (next: "settings" | "projects" | "plugins" | "search") => { drawer.setOpen(false); setSurface(next) }
  const rightDocked = reviewOpen && !pageOpen && viewportWidth >= 1180
  const sidebarMax = Math.max(200, Math.min(520, viewportWidth - 48 - (drawer.narrow ? 16 : 8 + 400 + (rightDocked ? 280 : 0))))
  const sidebarWidth = Math.min(preferredSidebarWidth, sidebarMax)
  const visibleSidebarWidth = pageOpen || drawer.narrow || sidebarCollapsed ? 0 : sidebarWidth
  const reviewMax = Math.max(1, Math.min(1200, viewportWidth - 48 - (rightDocked ? 8 + visibleSidebarWidth + 400 : 24)))
  const reviewMin = Math.min(280, reviewMax)
  const actualReviewWidth = Math.min(reviewMax, Math.max(reviewMin, reviewWidth))

  return (
    <div className={reviewOpen && !pageOpen ? "workbench review-open" : "workbench"} data-sidebar-collapsed={pageOpen || drawer.narrow || sidebarCollapsed} style={{ "--sidebar-width": `${sidebarWidth}px`, "--review-width": `${actualReviewWidth}px` } as CSSProperties}>
      <NavigationRail surface={surface}
        onCreate={() => { void createSession() }} canCreate={canCreate && selectedWorkspaceId !== undefined} onOpenWorkspace={onOpenWorkspace}
        onProjects={onProjectsChanged ? () => navigate("projects") : undefined}
        onPlugins={selectedWorkspaceId && capabilities["desktop-plugins"]?.includes("1") ? () => navigate("plugins") : undefined}
        onSearch={selectedWorkspaceId && capabilities["desktop-session-search"]?.includes("1") ? () => navigate("search") : undefined}
        onSettings={() => navigate("settings")} />
      {drawer.narrow && drawer.open ? <button type="button" className="sidebar-scrim" tabIndex={-1} aria-label={t("關閉側欄")} onClick={() => drawer.setOpen(false)} /> : null}
      <div ref={drawer.container} className={drawer.narrow ? "sidebar-container sidebar-drawer" : "sidebar-container"} hidden={pageOpen || (drawer.narrow ? !drawer.open : sidebarCollapsed)} role={drawer.narrow && drawer.open ? "dialog" : undefined} aria-modal={drawer.narrow && drawer.open ? true : undefined} aria-label={drawer.narrow ? t("工作區") : undefined}>
      {drawer.narrow ? <button type="button" className="drawer-close primary-button" onClick={() => drawer.setOpen(false)}>{t("關閉側欄")}</button> : null}
      {projects && onManageSessionInWorkspace ? <ProjectSidebar
        bridge={bridge} revision={sidebarRevision} onManageSessions={capabilities["desktop-sessions"]?.includes("1") ? (workspaceId, sessionId) => openManager(workspaceId, sessionId) : undefined} projects={projects} workspaces={workspaces} selectedProjectId={selectedProjectId} selectedWorkspaceId={selectedWorkspaceId} selectedSessionId={selectedSessionId}
        dashboard={dashboard} attentionBySession={attentionBySession}
        onSelectProject={(id) => { drawer.setOpen(false); onSelectProject?.(id) }}
        onSelectWorkspace={(id, projectId) => { drawer.setOpen(false); setSurface("conversation"); onSelectWorkspace(id, projectId) }}
        onSelectSession={(workspaceId, sessionId, projectId) => { drawer.setOpen(false); setMemoryOpen(false); setSurface("conversation"); onSelectSessionInWorkspace?.(workspaceId, sessionId, projectId) }}
        onManageSession={onManageSessionInWorkspace} onManageArchived={(workspaceId) => openManager(workspaceId, undefined, true)}
        onProjects={() => { drawer.setOpen(false); setSurface("projects") }}
        onOpenWorkspace={() => onOpenWorkspace?.()} onCreate={() => { void createSession() }} canCreate={canCreate && selectedWorkspaceId !== undefined}
        onPlugins={selectedWorkspaceId && capabilities["desktop-plugins"]?.includes("1") ? () => { drawer.setOpen(false); setSurface("plugins") } : undefined}
      /> : <WorkspaceSidebar
        workspaces={workspaces}
        selectedId={selectedWorkspaceId}
        onSelect={(id) => { drawer.setOpen(false); setSurface("conversation"); onSelectWorkspace(id) }}
        onOpen={() => onOpenWorkspace?.()}
        onCreate={() => { void createSession() }}
        canCreate={canCreate && selectedWorkspaceId !== undefined}
        onPlugins={selectedWorkspaceId && capabilities["desktop-plugins"]?.includes("1") ? () => { drawer.setOpen(false); setSurface("plugins") } : undefined}
      >
        {dashboard === undefined ? null : <TaskList workspaceId={selectedWorkspaceId} onManage={onManageSession} onCopyId={async (id) => { await navigator.clipboard.writeText(id) }} onOpenFolder={selectedWorkspaceId ? async () => { await bridge.request({ kind: "workspace/reveal", workspaceId: selectedWorkspaceId }) } : undefined} onManageSessions={selectedWorkspaceId && (onManageSession || onManageSessionInWorkspace) && capabilities["desktop-sessions"]?.includes("1") ? id => openManager(selectedWorkspaceId, id) : undefined} onManageArchived={selectedWorkspaceId && (onManageSession || onManageSessionInWorkspace) && capabilities["desktop-sessions"]?.includes("1") ? () => openManager(selectedWorkspaceId, undefined, true) : undefined} attentionCounts={attentionBySession} dashboard={dashboard} selectedId={selectedSessionId} onSelect={(id) => { drawer.setOpen(false); setMemoryOpen(false); onSelectSession(id) }} />}
      </WorkspaceSidebar>}
      <PaneResizeHandle side="left" label={t("調整側欄寬度")} width={sidebarWidth} min={200} max={sidebarMax} defaultWidth={240} onResize={setSidebarWidth} />
      </div>
      {settingsPane ? <div className="settings-retained-host" hidden={surface !== "settings"}>{settingsPane}</div> : null}
      {surface === "settings" ? null : projectsPane ?? <>
      <main className="center-pane">
        <TitleBar bridge={bridge} title={surface === "plugins" ? t("插件市場") : surface === "memory" ? t("工作區記憶") : surface === "search" ? t("搜尋會話") : selectedSessionId === undefined ? selectedProject ? `${selectedProject.name} · ${workspaceTitle}` : workspaceTitle : sessionTitle}
          leading={<button type="button" className="icon-button" aria-label={t("顯示側欄")} aria-expanded={drawer.narrow ? drawer.open : !sidebarCollapsed} onClick={toggleSidebar}><PanelLeft size={18} /></button>}>
          <button type="button" className="icon-button review-toggle" aria-label={t("成果檢查")} aria-expanded={reviewOpen} onClick={toggleReview}>
            <PanelRight size={18} />
          </button>
          {connection ? <span className={`connection-state connection-${connection}`} role="status">{t(connection === "online" ? "已連線" : connection === "offline" ? "連線已中斷" : connection === "reconnecting" ? "重新連線中…" : "連線中…")}</span> : null}
          {selectedWorkspaceId ? <WorkbenchTools key={`${selectedWorkspaceId}:${selectedSessionId ?? ""}`} groups={[
            { label: english ? "Workspace" : "工作區", items: [
              { id: "browser", label: t("瀏覽器"), icon: <Globe size={16} />, selected: reviewOpen && workPaneTab === "browser", open: () => openPane("browser") },
              ...(capabilities["desktop-terminal"]?.includes("1") ? [{ id: "terminal", label: t("終端"), icon: <TerminalSquare size={16} />, selected: reviewOpen && workPaneTab === "terminal", open: () => openPane("terminal") }] : []),
              ...(capabilities["desktop-memory"]?.includes("1") ? [{ id: "memory", label: t(memoryOpen ? "返回會話" : "工作區記憶"), icon: <Brain size={16} />, selected: memoryOpen, open: () => setMemoryOpen(open => !open) }] : []),
              ...(capabilities["desktop-environment-diagnostics"]?.includes("1") ? [{ id: "diagnostics", label: diagnosticsLabel, icon: <Wrench size={16} />, selected: reviewOpen && workPaneTab === "diagnostics", open: () => openPane("diagnostics") }] : []),
            ] },
            { label: english ? "Conversation" : "會話", items: selectedSessionId ? [
              { id: "changes", label: t("變更"), icon: <FolderOpen size={16} />, selected: reviewOpen && workPaneTab === "changes", open: () => openPane("changes") },
              { id: "tasks", label: t("任務"), icon: <ListTodo size={16} />, selected: reviewOpen && workPaneTab === "tasks", open: () => openPane("tasks") },
              ...(capabilities["desktop-execution"]?.includes("1") ? [{ id: "execution", label: "Code Mode", icon: <Code2 size={16} />, selected: reviewOpen && workPaneTab === "execution", open: () => openPane("execution") }] : []),
              ...(capabilities["desktop-agent-processes"]?.includes("1") ? [{ id: "processes", label: processesLabel, icon: <Activity size={16} />, selected: reviewOpen && workPaneTab === "processes", open: () => openPane("processes") }] : []),
              ...(capabilities["desktop-subagent-catalog"]?.includes("1") ? [{ id: "subagents", label: t("子代理"), icon: <UsersRound size={16} />, selected: reviewOpen && workPaneTab === "subagents", open: () => openPane("subagents") }] : []),
            ] : [] },
            { label: english ? "Work and collaboration" : "工作與協作", items: selectedSessionId && capabilities["desktop-workflow"]?.includes("1") ? ([["goal", "Goal / Plan", Target], ["team", "Team", Network], ["jobs", t("背景工作"), ListTodo], ["reviews", t("代審"), ShieldCheck]] as const).map(([id, label, Icon]): WorkbenchTool => ({ id, label, icon: <Icon size={16} />, open: () => openWorkflow(id) })) : [] },
          ]} /> : null}
          {selectedWorkspaceId !== undefined && capabilities["desktop-session-search"]?.includes("1") ? <button type="button" className="primary-button header-action" aria-label={t(surface === "search" ? "返回會話" : "搜尋會話")} title={t(surface === "search" ? "返回會話" : "搜尋會話")} onClick={() => setSurface(surface === "search" ? "conversation" : "search")}><Search size={16} /><span className="header-action-label">{t(surface === "search" ? "返回會話" : "搜尋會話")}</span></button> : null}
        </TitleBar>
        <p data-testid="session-announcer" aria-live="polite" className="visually-hidden">
          {selectedSessionId === undefined ? "" : t("已選擇會話 {title}", { title: sessionTitle })}
        </p>
        {error === undefined
          ? null
          : (
            <p className="notice error-text">
              {error}
              {onRetry === undefined ? null : (
                <button type="button" className="link-button" onClick={onRetry}>{t("重試")}</button>
              )}
            </p>
          )}
        {surface === "plugins" && selectedWorkspaceId ? <PluginMarketplace key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} /> : surface === "search" && selectedWorkspaceId !== undefined && capabilities["desktop-session-search"]?.includes("1") ? <SessionSearch key={`${selectedWorkspaceId}:${selectedSessionId ?? ""}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} titles={Object.fromEntries((dashboard?.sessions ?? []).filter((row) => row.title).map((row) => [row.id, row.title!]))} onSelect={(target) => { if (onSelectHistory) onSelectHistory(target); else { setSurface("conversation"); onSelectSession(target.sessionId) } }} /> : memoryOpen && selectedWorkspaceId !== undefined && capabilities["desktop-memory"]?.includes("1") ? <MemoryPane key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} onAuthoringRequest={capabilities["desktop-memory-authoring"]?.includes("1") ? authoringRequest : undefined} /> : historicalView ? <SessionHistoryView {...historicalView} navigation={fileNavigation} /> : <section className="session-body todo-progress-host" aria-label={t("會話")}>
          {selectedSessionId !== undefined && selectedWorkspaceId !== undefined && conversation !== undefined
            ? (
              <>
                {conversation.historyError ? <p role="alert" className="notice error-text">{conversation.historyError}<button type="button" className="link-button" onClick={onRetry}>{t("重試")}</button></p> : null}
                {capabilities["desktop-work-state"]?.includes("1") && conversation.workStateError ? <p role="alert" className="notice error-text">{t("工作狀態讀取失敗")}：{conversation.workStateError}{conversation.onRetryWorkState ? <button type="button" className="link-button" onClick={conversation.onRetryWorkState}>{t("重試")}</button> : null}</p> : null}
                {conversation.historyNotice ? <p className="notice history-notice">{conversation.historyNotice}</p> : null}
                {capabilities["desktop-work-state"]?.includes("1") && !conversation.workStateError && conversation.workState?.goal ? <div className="conversation-goal" title={conversation.workState.goal.objective}>
                  <span className="conversation-goal-label">{t("目前目標")}</span><span className="conversation-goal-objective">{conversation.workState.goal.objective}</span>
                  <span className="conversation-goal-phase">{t(conversation.workState.goal.phase === "paused" ? "已暫停" : conversation.workState.goal.phase === "complete" ? "已完成" : "進行中")}</span>
                </div> : null}
                {capabilities["desktop-work-state"]?.includes("1") ? <TodoProgress key={`todos:${selectedWorkspaceId}:${selectedSessionId}`} todos={conversation.workState?.todos} error={conversation.workStateError} onOpenTasks={openTodoEditor} /> : null}
                {conversation.rows.length === 0
                  ? <div className="empty-conversation"><h1>{t("今天想完成甚麼？")}</h1><p>{t("描述你的目標，從這個工作區開始。")}</p></div>
                  : <Timeline key={`${selectedWorkspaceId}:${selectedSessionId}`} rows={conversation.rows} running={conversation.running} navigation={fileNavigation} />}
                <div className="conversation-dock">
                {conversation.taskError && !(reviewOpen && workPaneTab === "tasks") ? <p role="alert" className="notice error-text">{conversation.taskError}</p> : null}
                <PendingPanel key={`${selectedWorkspaceId}:${selectedSessionId}`} draftOwner={bridge} workspaceId={selectedWorkspaceId} pending={conversation.pending} onReply={conversation.onReply} />
                {conversation.pending.length > 0 && conversation.running ? <button type="button" className="link-button dock-cancel" onClick={conversation.onCancel}>{t("停止")}</button> : null}
                <div hidden={conversation.pending.length > 0}>
                <Composer
                  onOpenHistory={onSelectHistory}
                  onOpenProjectFile={fileNavigation?.onOpenProjectFile}
                  draftRequest={capabilities["desktop-drafts"]?.includes("1") ? draftRequest : undefined}
                  projectId={selectedProjectId}
                  permissionsEnabled={capabilities["desktop-agent-settings"]?.includes("1")}
                  onPermissionsChanged={onSandboxChange}
                  onWorkflow={openWorkflow}
                  workflowEnabled={capabilities["desktop-workflow"]?.includes("1")}
                  fileReferencesEnabled={capabilities["prompt-context"]?.includes("1") && capabilities["desktop-review"]?.includes("1")}
                  imageAttachmentsEnabled={capabilities["prompt-images"]?.includes("1") && conversation.modelState?.status === "ready" && conversation.modelState.imageInput === true}
                  contextUsageEnabled={capabilities["session-context"]?.includes("1")}
                  canCompact={conversation.canCompact}
                  onCompact={capabilities["desktop-compaction"]?.includes("1") ? conversation.onCompact : undefined}
                  bridge={bridge}
                  workspaceId={selectedWorkspaceId}
                  sessionId={selectedSessionId}
                  canSend={conversation.canSend}
                  sendReason={conversation.sendReason}
                  executionError={conversation.executionError}
                  running={conversation.running}
                  modelLabel={conversation.modelLabel}
                  modelControl={bridge && conversation.onSetModel ? <SessionModelPicker key={`${selectedWorkspaceId}:${selectedSessionId}`} bridge={bridge} workspaceId={selectedWorkspaceId} current={conversation.modelState} disabled={conversation.running || conversation.operation?.busy === true} onSelect={conversation.onSetModel} /> : undefined}
                  onPrompt={conversation.onPrompt}
                  steeringEnabled={capabilities["desktop-input"]?.includes("1")}
                  onSteer={conversation.onSteer}
                  onCancel={conversation.onCancel}
                />
                </div>
                </div>
              </>
            )
            : <div className="empty-conversation">
                {selectedWorkspaceId === undefined ? <>
                  <span className="welcome-mark">I</span>
                  <h1>{t("讓想法成為成果")}</h1>
                  <p>{t("選擇本機資料夾，開始你的第一個任務。")}</p>
                  <button type="button" className="welcome-action" onClick={() => onOpenWorkspace?.()}><FolderOpen size={17} />{t("選擇資料夾")}</button>
                </> : <>
                  <h1>{t("今天想完成甚麼？")}</h1>
                  <p>{t("描述你的目標，從這個工作區開始。")}</p>
                  <div className="empty-composer">{selectedProject && !selectedProject.workspaceIds.includes(selectedWorkspaceId) ? <><p className="notice">{english ? "Choose a project folder to create a conversation. This folder retains moved conversation storage." : "選擇專案資料夾以建立會話；此資料夾保留已移動會話的儲存資料。"}</p><button type="button" className="primary-button" onClick={() => { const member = selectedProject.primaryWorkspaceId ?? selectedProject.workspaceIds[0]; if (member) onSelectWorkspace(member, selectedProject.id) }}>{t("選擇資料夾")}</button></> : <NewTaskComposer onOpenHistory={onSelectHistory} onOpenProjectFile={fileNavigation?.onOpenProjectFile} key={`${selectedWorkspaceId}:${selectedProjectId ?? ""}`} bridge={bridge} draftRequest={capabilities["desktop-drafts"]?.includes("1") ? draftRequest : undefined} workspaceId={selectedWorkspaceId} projectId={selectedProjectId} capabilities={capabilities} onPermissionsChanged={onSandboxChange} onSubmitted={(id) => { if (workspaceScope.current.id === selectedWorkspaceId && workspaceScope.current.sessionId === undefined && workspaceScope.current.projectId === selectedProjectId) { onSelectSession(id); onSessionsChanged?.() } }} onWorkflow={openWorkflow} />}</div>
                </>}
              </div>}
        </section>}
      </main>
      </>}
      {reviewOpen || visitedWork.current.tabs.size > 0 || visitedWorkspacePanes.current.tabs.size > 0 ? <aside className="review-pane" aria-label={t("成果檢查")} hidden={!workVisible}>
        <ReviewResizeHandle width={actualReviewWidth} min={reviewMin} max={reviewMax} onResize={setReviewWidth} />
        <div className="work-pane-header"><PaneTabs id={workPaneId} label={t("成果檢查")} items={[...(capabilities["desktop-environment-diagnostics"]?.includes("1") ? [{ id: "diagnostics", label: diagnosticsLabel }] : []), ...(selectedSessionId && capabilities["desktop-execution"]?.includes("1") ? [{ id: "execution", label: "Code Mode" }] : []), ...(selectedSessionId && capabilities["desktop-agent-processes"]?.includes("1") ? [{ id: "processes", label: processesLabel }] : []), { id: "browser", label: t("瀏覽器") }, { id: "changes", label: t("變更") }, { id: "tasks", label: t("任務") }, ...(selectedSessionId && capabilities["desktop-subagent-catalog"]?.includes("1") ? [{ id: "subagents", label: t("子代理") }] : []), ...(selectedSessionId && capabilities["desktop-workflow"]?.includes("1") ? [{ id: "workflow", label: t("工作流程") }] : []), ...(selectedSessionId && capabilities["desktop-schedule"]?.includes("1") ? [{ id: "reminders", label: t("提醒") }] : []), ...(capabilities["desktop-terminal"]?.includes("1") ? [{ id: "terminal", label: t("終端") }] : [])]} selected={workPaneTab} onSelect={setWorkPaneTab} />
          <button type="button" className="icon-button" aria-label={t("關閉成果面板")} onClick={toggleReview}>×</button></div>
        <div role="tabpanel" id={`${workPaneId}-panel`} aria-labelledby={`${workPaneId}-${workPaneTab}`}>
        {workVisible && workPaneTab === "diagnostics" && selectedWorkspaceId && capabilities["desktop-environment-diagnostics"]?.includes("1") ? <DiagnosticsPane key={`diagnostics:${selectedWorkspaceId}:${selectedSessionId ?? ""}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} /> : null}
        {workVisible && workPaneTab === "execution" && selectedWorkspaceId && selectedSessionId && capabilities["desktop-execution"]?.includes("1") ? <ExecutionPane key={`execution:${selectedWorkspaceId}:${selectedSessionId}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} /> : null}
        {workVisible && workPaneTab === "processes" && selectedWorkspaceId && selectedSessionId && capabilities["desktop-agent-processes"]?.includes("1") ? <AgentProcessesPane key={`processes:${selectedWorkspaceId}:${selectedSessionId}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} /> : null}
        {workVisible && workPaneTab === "subagents" && selectedWorkspaceId && selectedSessionId && capabilities["desktop-subagent-catalog"]?.includes("1") ? <SubagentPane key={`subagents:${selectedWorkspaceId}:${selectedSessionId}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} parentTitle={sessionTitle} /> : null}
        {visitedWork.current.tabs.has("workflow") && selectedWorkspaceId && selectedSessionId && capabilities["desktop-workflow"]?.includes("1") ? <div className="retained-work-pane" hidden={workPaneTab !== "workflow"}>{conversation?.projectReady === false ? <p role="status" className="notice">{conversation.sendReason}</p> : <WorkflowPane key={`${selectedWorkspaceId}:${selectedSessionId}`} active={workVisible && workPaneTab === "workflow"} section={workflowSection} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} running={conversation?.running} onChanged={conversation?.onRetryWorkState} />}</div> : null}
        {workVisible && workPaneTab === "workflow" && !capabilities["desktop-workflow"]?.includes("1") ? <p role="status" className="notice">{t("目前工作區後端未提供此功能。")}</p> : null}
        {workVisible && workPaneTab === "workflow" && !selectedSessionId ? <p role="status" className="notice">{t("選擇會話以開啟工作流程。")}</p> : null}
        {visitedWorkspacePanes.current.tabs.has("browser") && selectedWorkspaceId ? <div className="retained-work-pane" hidden={workPaneTab !== "browser"}><BrowserPane key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} visible={workVisible && workPaneTab === "browser" && !drawer.open} /></div> : null}
        {visitedWorkspacePanes.current.tabs.has("terminal") && selectedWorkspaceId && capabilities["desktop-terminal"]?.includes("1") ? <div className="retained-work-pane" hidden={workPaneTab !== "terminal"}><Suspense fallback={<p>{t("正在載入終端…")}</p>}><TerminalPane key={selectedWorkspaceId} active={workVisible && workPaneTab === "terminal"} bridge={bridge} workspaceId={selectedWorkspaceId} /></Suspense></div> : null}
        {visitedWork.current.tabs.has("reminders") && selectedWorkspaceId && selectedSessionId && capabilities["desktop-schedule"]?.includes("1") ? <div className="retained-work-pane" hidden={workPaneTab !== "reminders"}><SchedulePane key={`${selectedWorkspaceId}:${selectedSessionId}`} active={workVisible && workPaneTab === "reminders"} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} canCreate={conversation?.modelState?.status === "ready" && !conversation.running && !conversation.queue?.length && conversation.operation?.busy !== true} /></div> : null}
        {!workVisible || workPaneTab !== "changes" || review === undefined || selectedWorkspaceId === undefined ? null : (
          <ReviewPane
            draftOwner={bridge}
            workspaceId={selectedWorkspaceId}
            projectFiles={review.projectFiles ? { ...review.projectFiles, contentSearchAvailable: capabilities["desktop-project-content-search"]?.includes("1") === true, membershipRevision: fileMembershipRevision } : undefined}
            key={selectedWorkspaceId}
            changes={review.changes}
            error={review.error}
            selected={review.selected}
            diff={review.diff}
            preview={review.preview}
            onSelect={review.onSelect}
            onRefresh={review.onRefresh}
            onSaveFile={review.onSaveFile}
            onStage={review.onStage}
            onUnstage={review.onUnstage}
            onCommit={review.onCommit}
          />
        )}
        {!workVisible || workPaneTab !== "tasks" || conversation === undefined ? null : (
          <TaskPane
            draftOwner={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId}
            key={`${selectedWorkspaceId ?? ""}:${selectedSessionId ?? ""}`}
            queue={conversation.queue}
            tasks={conversation.tasks}
            workStateEnabled={capabilities["desktop-work-state"]?.includes("1") === true}
            workState={conversation.workState}
            workStateError={conversation.workStateError}
            onRetryWorkState={conversation.onRetryWorkState}
            onWriteTodos={conversation.onWriteTodos}
            error={conversation.taskError}
            onCancelTask={conversation.onCancelTask}
            onCancelQueue={conversation.onCancelQueue}
            queueResumable={conversation.queueResumable}
            onResumeQueue={conversation.projectReady === false ? undefined : conversation.onResumeQueue}
          />
        )}
        {workVisible && workPaneTab === "changes" && (review === undefined || selectedWorkspaceId === undefined) ? <p className="notice">{t("選擇工作區以檢查檔案變動。")}</p> : null}
        {workVisible && workPaneTab === "tasks" && conversation === undefined ? <p className="notice">{t("尚未選擇會話")}</p> : null}
        {workVisible && workPaneTab === "reminders" && !selectedSessionId ? <p className="notice">{t("尚未選擇會話")}</p> : null}
        </div>
      </aside> : null}
      {manager && managerManage ? <SettingsDialog title={t("管理會話")} closeLabel={t("關閉")} busy={managerBusy} initialFocusSelector="button" onClose={() => setManager(undefined)}><SessionManager key={JSON.stringify(manager)} onBusyChange={busy => { if (managerOwner.current === manager) setManagerBusy(busy) }} bridge={bridge} workspaceId={manager.workspaceId} initialArchived={manager.archived} initialSelected={manager.sessionId ? [manager.sessionId] : []} onManage={async (id, action, title) => { await managerManage(id, action, title); setSidebarRevision(value => value + 1) }} onRewindComplete={capabilities["desktop-rewind"]?.includes("1") && onRewindComplete ? id => onRewindComplete(manager.workspaceId, id) : undefined} onBatch={onBatchSessions && capabilities["desktop-sessions"]?.includes("1") ? command => batchRequest(manager.workspaceId, command) : undefined} projects={projects} currentOwners={managerOwners} executionWorkspace={workspaces.find(row => row.id === manager.workspaceId)?.path} /></SettingsDialog> : null}
    </div>
  )
}
