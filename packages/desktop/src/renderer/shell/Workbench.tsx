import { useEffect, useId, useRef, useState, lazy, Suspense, type CSSProperties } from "react"
import { Brain, Search, PanelLeft, PanelRight, FolderOpen, TerminalSquare, Globe, UsersRound } from "lucide-react"
import { BrowserPane } from "../browser/BrowserPane.tsx"
import { useUiStore } from "./ui-store.ts"
import { useText, type Message } from "../design/i18n.ts"
import { MemoryPane } from "../memory/MemoryPane.tsx"
import { SessionSearch } from "../session/SessionSearch.tsx"
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
import { TitleBar } from "./TitleBar.tsx"
import { useNarrowSidebar } from "./use-narrow-sidebar.ts"
import { ReviewResizeHandle } from "../review/ReviewResizeHandle.tsx"
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

const SANDBOX_LABELS: Record<SandboxState["mode"], Message> = {
  "read-only": "唯讀",
  "workspace-write": "可寫入工作區",
  "danger-full-access": "完整存取",
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
  sandbox,
  error,
  selectedWorkspaceId,
  selectedSessionId,
  onSelectWorkspace,
  onSelectSession,
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
  const drawer = useNarrowSidebar()
  const drawerWorkspace = useRef(selectedWorkspaceId)
  useEffect(() => {
    if (drawerWorkspace.current === selectedWorkspaceId) return
    drawerWorkspace.current = selectedWorkspaceId
    if (selectedWorkspaceId !== undefined) drawer.setOpen(false)
  }, [selectedWorkspaceId, drawer.setOpen])
  useAppearance()
  const sidebarCollapsed = usePreferences((state) => state.sidebarCollapsed)
  const updatePreferences = usePreferences((state) => state.update)
  const [archivedWorkspaceId, setArchivedWorkspaceId] = useState<string>()
  const workspaceScope = useRef({ id: selectedWorkspaceId, sessionId: selectedSessionId, projectId: selectedProjectId })
  if (workspaceScope.current.id !== selectedWorkspaceId || workspaceScope.current.sessionId !== selectedSessionId || workspaceScope.current.projectId !== selectedProjectId) workspaceScope.current = { id: selectedWorkspaceId, sessionId: selectedSessionId, projectId: selectedProjectId }
  const [workPaneTab, setWorkPaneTab] = useState("changes")
  const [workflowSection, setWorkflowSection] = useState<"goal" | "team" | "jobs" | "reviews">("goal")
  useEffect(() => {
    if (workPaneTab === "reminders" && (!selectedSessionId || !capabilities["desktop-schedule"]?.includes("1"))) setWorkPaneTab("changes")
    if (workPaneTab === "subagents" && (!selectedSessionId || !capabilities["desktop-subagent-catalog"]?.includes("1"))) setWorkPaneTab("changes")
  }, [workPaneTab, selectedSessionId, capabilities])
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
  function openWorkflow(name: string) {
    if (name === "settings") { setSurface("settings"); return }
    setSurface("conversation")
    if (!reviewOpen) toggleReview()
    setWorkflowSection(name === "team" || name === "jobs" || name === "reviews" ? name : "goal")
    setWorkPaneTab("workflow")
  }
  const workspaceTitle = workspaces.find((row) => row.id === selectedWorkspaceId)?.label ?? t("尚未選擇會話")
  const selectedProject = projects?.find((project) => project.id === selectedProjectId)
  const canCreate = capabilities["session-create"]?.includes("1") === true

  async function createSession(): Promise<void> {
    if (selectedWorkspaceId === undefined) return
    drawer.setOpen(false)
    setMemoryOpen(false)
    onSelectWorkspace(selectedWorkspaceId, selectedProjectId)
  }

  if (surface === "settings") return <SettingsPane onSandboxChange={onSandboxChange} onUseResource={selectedWorkspaceId && selectedSessionId ? (prefix) => {
    const draft = readDraft(selectedWorkspaceId, selectedSessionId)
    const next = draft.startsWith(prefix) ? draft : prefix + draft
    if (boundedDraft(next) !== next) throw new Error(t("草稿已達上限，請先整理內容。"))
    writeDraft(selectedWorkspaceId, selectedSessionId, next)
    setSurface("conversation")
  } : undefined} capabilities={capabilities} onRewindComplete={selectedWorkspaceId && capabilities["desktop-rewind"]?.includes("1") && onRewindComplete ? (sessionId) => onRewindComplete(selectedWorkspaceId, sessionId) : undefined} onManageSession={capabilities["desktop-sessions"]?.includes("1") ? onManageSession : undefined} bridge={bridge} workspace={workspaces.find((row) => row.id === selectedWorkspaceId)} onMemory={capabilities["desktop-memory"]?.includes("1") ? () => setSurface("memory") : undefined} onClose={() => setSurface("conversation")} />

  if (surface === "projects" && onProjectsChanged) return <ProjectManager bridge={bridge} projects={projects ?? []} workspaces={workspaces} onChanged={onProjectsChanged} onOpen={(project) => onSelectProject?.(project.id)} onClose={() => setSurface("conversation")} />

  return (
    <div className={reviewOpen ? "workbench review-open" : "workbench"} data-sidebar-collapsed={drawer.narrow || sidebarCollapsed} style={{ "--review-width": `${reviewWidth}px` } as CSSProperties}>
      {drawer.narrow && drawer.open ? <button type="button" className="sidebar-scrim" tabIndex={-1} aria-label={t("關閉側欄")} onClick={() => drawer.setOpen(false)} /> : null}
      <div ref={drawer.container} className={drawer.narrow ? "sidebar-container sidebar-drawer" : "sidebar-container"} hidden={drawer.narrow ? !drawer.open : sidebarCollapsed} role={drawer.narrow && drawer.open ? "dialog" : undefined} aria-modal={drawer.narrow && drawer.open ? true : undefined} aria-label={drawer.narrow ? t("工作區") : undefined}>
      {drawer.narrow ? <button type="button" className="drawer-close primary-button" onClick={() => drawer.setOpen(false)}>{t("關閉側欄")}</button> : null}
      {projects && onManageSessionInWorkspace ? <ProjectSidebar
        bridge={bridge} projects={projects} workspaces={workspaces} selectedProjectId={selectedProjectId} selectedWorkspaceId={selectedWorkspaceId} selectedSessionId={selectedSessionId}
        dashboard={dashboard} attentionBySession={attentionBySession}
        onSelectProject={(id) => { drawer.setOpen(false); onSelectProject?.(id) }}
        onSelectWorkspace={(id, projectId) => { drawer.setOpen(false); setSurface("conversation"); onSelectWorkspace(id, projectId) }}
        onSelectSession={(workspaceId, sessionId, projectId) => { drawer.setOpen(false); setMemoryOpen(false); setSurface("conversation"); onSelectSessionInWorkspace?.(workspaceId, sessionId, projectId) }}
        onManageSession={onManageSessionInWorkspace} onManageArchived={setArchivedWorkspaceId}
        onProjects={() => { drawer.setOpen(false); setSurface("projects") }}
        onOpenWorkspace={() => onOpenWorkspace?.()} onCreate={() => { void createSession() }} canCreate={canCreate && selectedWorkspaceId !== undefined}
        onSettings={() => { drawer.setOpen(false); setSurface("settings") }}
        onPlugins={selectedWorkspaceId && capabilities["desktop-plugins"]?.includes("1") ? () => { drawer.setOpen(false); setSurface("plugins") } : undefined}
      /> : <WorkspaceSidebar
        workspaces={workspaces}
        selectedId={selectedWorkspaceId}
        onSelect={(id) => { drawer.setOpen(false); setSurface("conversation"); onSelectWorkspace(id) }}
        onOpen={() => onOpenWorkspace?.()}
        onCreate={() => { void createSession() }}
        canCreate={canCreate && selectedWorkspaceId !== undefined}
        onSettings={() => { drawer.setOpen(false); setSurface("settings") }}
        onPlugins={selectedWorkspaceId && capabilities["desktop-plugins"]?.includes("1") ? () => { drawer.setOpen(false); setSurface("plugins") } : undefined}
      >
        {dashboard === undefined ? null : <TaskList workspaceId={selectedWorkspaceId} onManage={onManageSession} onCopyId={async (id) => { await navigator.clipboard.writeText(id) }} onOpenFolder={selectedWorkspaceId ? async () => { await bridge.request({ kind: "workspace/reveal", workspaceId: selectedWorkspaceId }) } : undefined} onManageArchived={selectedWorkspaceId ? () => setArchivedWorkspaceId(selectedWorkspaceId) : undefined} attentionCounts={attentionBySession} dashboard={dashboard} selectedId={selectedSessionId} onSelect={(id) => { drawer.setOpen(false); setMemoryOpen(false); onSelectSession(id) }} />}
      </WorkspaceSidebar>}
      </div>
      <main className="center-pane">
        <TitleBar bridge={bridge} title={surface === "plugins" ? t("插件市場") : surface === "memory" ? t("工作區記憶") : surface === "search" ? t("搜尋會話") : selectedSessionId === undefined ? selectedProject ? `${selectedProject.name} · ${workspaceTitle}` : workspaceTitle : sessionTitle}
          leading={<button type="button" className="icon-button" aria-label={t("顯示側欄")} aria-expanded={drawer.narrow ? drawer.open : !sidebarCollapsed} onClick={() => drawer.narrow ? drawer.setOpen(!drawer.open) : updatePreferences({ sidebarCollapsed: !sidebarCollapsed })}><PanelLeft size={18} /></button>}>
          <button type="button" className="icon-button review-toggle" aria-label={t("成果檢查")} aria-expanded={reviewOpen} onClick={toggleReview}>
            <PanelRight size={18} />
          </button>
          {connection ? <span className={`connection-state connection-${connection}`} role="status">{t(connection === "online" ? "已連線" : connection === "offline" ? "連線已中斷" : connection === "reconnecting" ? "重新連線中…" : "連線中…")}</span> : null}
          {selectedWorkspaceId && selectedSessionId && capabilities["desktop-workflow"]?.includes("1") ? <>{([["goal", "Goal / Plan"], ["team", "Team"], ["jobs", t("背景工作")], ["reviews", t("代審")]] as const).map(([name, label]) => <button key={name} type="button" className="primary-button header-action" onClick={() => openWorkflow(name)}>{label}</button>)}</> : null}
          {selectedWorkspaceId && selectedSessionId && capabilities["desktop-subagent-catalog"]?.includes("1") ? <button type="button" className="primary-button header-action" aria-label={t("子代理")} title={t("子代理")} onClick={() => { setSurface("conversation"); if (!reviewOpen) toggleReview(); setWorkPaneTab("subagents") }}><UsersRound size={16} /><span className="header-action-label">{t("子代理")}</span></button> : null}
          {selectedWorkspaceId !== undefined && capabilities["desktop-memory"]?.includes("1") ? <button type="button" className="primary-button header-action" aria-label={t(memoryOpen ? "返回會話" : "工作區記憶")} title={t(memoryOpen ? "返回會話" : "工作區記憶")} onClick={() => setMemoryOpen((open) => !open)}><Brain size={16} /><span className="header-action-label">{t(memoryOpen ? "返回會話" : "工作區記憶")}</span></button> : null}
          {selectedWorkspaceId ? <button type="button" className="primary-button header-action" aria-label={t("瀏覽器")} onClick={() => { if (!reviewOpen) toggleReview(); setWorkPaneTab("browser") }}><Globe size={16} /><span className="header-action-label">{t("瀏覽器")}</span></button> : null}
          {selectedWorkspaceId && capabilities["desktop-terminal"]?.includes("1") ? <button type="button" className="primary-button header-action" aria-label={t("終端")} onClick={() => { if (!reviewOpen) toggleReview(); setWorkPaneTab("terminal") }}><TerminalSquare size={16} /><span className="header-action-label">{t("終端")}</span></button> : null}
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
        {surface === "plugins" && selectedWorkspaceId ? <PluginMarketplace key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} /> : surface === "search" && selectedWorkspaceId !== undefined && capabilities["desktop-session-search"]?.includes("1") ? <SessionSearch key={`${selectedWorkspaceId}:${selectedSessionId ?? ""}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} titles={Object.fromEntries((dashboard?.sessions ?? []).filter((row) => row.title).map((row) => [row.id, row.title!]))} onSelect={(id) => { setSurface("conversation"); onSelectSession(id) }} /> : memoryOpen && selectedWorkspaceId !== undefined && capabilities["desktop-memory"]?.includes("1") ? <MemoryPane key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} /> : <section className="session-body todo-progress-host" aria-label={t("會話")}>
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
                  : <Timeline key={`${selectedWorkspaceId}:${selectedSessionId}`} rows={conversation.rows} running={conversation.running} navigation={review && capabilities["desktop-review"]?.includes("1") ? { workspacePath: workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.path ?? "", onOpenFile: (path) => { if (!reviewOpen) toggleReview(); setWorkPaneTab("changes"); review.onSelect(path, "preview") } } : undefined} />}
                <div className="conversation-dock">
                <PendingPanel key={`${selectedWorkspaceId}:${selectedSessionId}`} pending={conversation.pending} onReply={conversation.onReply} />
                {conversation.pending.length > 0 && conversation.running ? <button type="button" className="link-button dock-cancel" onClick={conversation.onCancel}>{t("停止")}</button> : null}
                <div hidden={conversation.pending.length > 0}>
                <Composer
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
                  <div className="empty-composer"><NewTaskComposer key={`${selectedWorkspaceId}:${selectedProjectId ?? ""}`} bridge={bridge} workspaceId={selectedWorkspaceId} projectId={selectedProjectId} capabilities={capabilities} onPermissionsChanged={onSandboxChange} onSubmitted={(id) => { if (workspaceScope.current.id === selectedWorkspaceId && workspaceScope.current.sessionId === undefined && workspaceScope.current.projectId === selectedProjectId) { onSelectSession(id); onSessionsChanged?.() } }} onWorkflow={openWorkflow} /></div>
                </>}
              </div>}
        </section>}
        <footer className="workspace-status">
          {sandbox === undefined ? t("等待工作區連線") : `${t("沙箱")} · ${t(SANDBOX_LABELS[sandbox.mode])}`}
        </footer>
      </main>
      {reviewOpen ? <aside className="review-pane" aria-label={t("成果檢查")}>
        <ReviewResizeHandle width={reviewWidth} onResize={setReviewWidth} />
        <div className="work-pane-header"><PaneTabs id={workPaneId} label={t("成果檢查")} items={[{ id: "browser", label: t("瀏覽器") }, { id: "changes", label: t("變更") }, { id: "tasks", label: t("任務") }, ...(selectedSessionId && capabilities["desktop-subagent-catalog"]?.includes("1") ? [{ id: "subagents", label: t("子代理") }] : []), ...(selectedSessionId && capabilities["desktop-workflow"]?.includes("1") ? [{ id: "workflow", label: t("工作流程") }] : []), ...(selectedSessionId && capabilities["desktop-schedule"]?.includes("1") ? [{ id: "reminders", label: t("提醒") }] : []), ...(capabilities["desktop-terminal"]?.includes("1") ? [{ id: "terminal", label: t("終端") }] : [])]} selected={workPaneTab} onSelect={setWorkPaneTab} />
          <button type="button" className="icon-button" aria-label={t("關閉成果面板")} onClick={toggleReview}>×</button></div>
        <div role="tabpanel" id={`${workPaneId}-panel`} aria-labelledby={`${workPaneId}-${workPaneTab}`}>
        {workPaneTab === "subagents" && selectedWorkspaceId && selectedSessionId && capabilities["desktop-subagent-catalog"]?.includes("1") ? <SubagentPane key={`subagents:${selectedWorkspaceId}:${selectedSessionId}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} parentTitle={sessionTitle} /> : null}
        {workPaneTab === "workflow" && selectedWorkspaceId && selectedSessionId && capabilities["desktop-workflow"]?.includes("1") ? conversation?.projectReady === false ? <p role="status" className="notice">{conversation.sendReason}</p> : <WorkflowPane key={`${selectedWorkspaceId}:${selectedSessionId}`} section={workflowSection} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} running={conversation?.running} onChanged={conversation?.onRetryWorkState} /> : null}
        {workPaneTab === "workflow" && !capabilities["desktop-workflow"]?.includes("1") ? <p role="status" className="notice">{t("目前工作區後端未提供此功能。")}</p> : null}
        {workPaneTab === "workflow" && !selectedSessionId ? <p role="status" className="notice">{t("選擇會話以開啟工作流程。")}</p> : null}
        {workPaneTab === "browser" && selectedWorkspaceId ? <BrowserPane key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} visible={!drawer.open} /> : null}
        {workPaneTab === "terminal" && selectedWorkspaceId && capabilities["desktop-terminal"]?.includes("1") ? <Suspense fallback={<p>{t("正在載入終端…")}</p>}><TerminalPane key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} /></Suspense> : null}
        {workPaneTab === "reminders" && selectedWorkspaceId && selectedSessionId && capabilities["desktop-schedule"]?.includes("1") ? <SchedulePane key={`${selectedWorkspaceId}:${selectedSessionId}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} canCreate={conversation?.modelState?.status === "ready" && !conversation.running && !conversation.queue?.length && conversation.operation?.busy !== true} /> : null}
        {workPaneTab !== "changes" || review === undefined || selectedWorkspaceId === undefined ? null : (
          <ReviewPane
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
        {workPaneTab !== "tasks" || conversation === undefined ? null : (
          <TaskPane
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
        {workPaneTab === "changes" && (review === undefined || selectedWorkspaceId === undefined) ? <p className="notice">{t("選擇工作區以檢查檔案變動。")}</p> : null}
        {workPaneTab === "tasks" && conversation === undefined ? <p className="notice">{t("尚未選擇會話")}</p> : null}
        {workPaneTab === "reminders" && !selectedSessionId ? <p className="notice">{t("尚未選擇會話")}</p> : null}
        </div>
      </aside> : null}
      {archivedWorkspaceId && onManageSessionInWorkspace ? <SettingsDialog title={t("管理已封存會話")} closeLabel={t("關閉")} initialFocusSelector="button" onClose={() => setArchivedWorkspaceId(undefined)}><SessionManager key={archivedWorkspaceId} bridge={bridge} workspaceId={archivedWorkspaceId} initialArchived onManage={(id, action, title) => onManageSessionInWorkspace(archivedWorkspaceId, id, action, title)} /></SettingsDialog> : null}
    </div>
  )
}
