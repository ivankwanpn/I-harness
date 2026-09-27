import { useEffect, useId, useRef, useState, lazy, Suspense, type CSSProperties } from "react"
import { ArrowUp, Brain, Search, PanelLeft, PanelRight, FolderOpen, TerminalSquare, Globe } from "lucide-react"
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
import type { DesktopBridge } from "../../shared/bridge.ts"
import { Composer, readDraft, writeDraft, boundedDraft } from "../session/Composer.tsx"
import type { TimelineRow } from "../session/project.ts"
import { TaskPane } from "../session/TaskPane.tsx"
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
import { ComposerSurface } from "../vendor/zcode/ComposerSurface.tsx"
import { SessionModelPicker } from "../session/SessionModelPicker.tsx"
import type { ImageInput } from "@i-harness/sdk"
import type { ManageSession } from "../session/SessionManager.tsx"
import type { SessionModelSelection, SessionModelState } from "@i-harness/sdk"
import type { DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"

export interface ConversationView {
  rows: TimelineRow[]
  canSend: boolean
  sendReason?: string
  running: boolean
  modelLabel?: string
  modelState?: SessionModelState
  onSetModel?(selection: SessionModelSelection): Promise<void>
  operation?: SessionOperation
  canCompact?: boolean
  onCompact?(instructions?: string): Promise<void>
  queue?: SessionQueueItem[]
  tasks?: AgentTaskView[]
  workState?: DesktopWorkStateView
  workStateError?: string
  onRetryWorkState?(): void
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
  onSelectWorkspace(workspaceId: string): void
  onSelectSession(sessionId: string): void
  onManageSession?: ManageSession
  onRewindComplete?: (workspaceId: string, sessionId: string) => void
  onSessionsChanged?(): void
}

const SANDBOX_LABELS: Record<SandboxState["mode"], Message> = {
  "read-only": "唯讀",
  "workspace-write": "可寫入工作區",
  "danger-full-access": "完整存取",
}

export function Workbench({
  bridge,
  workspaces,
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
  const [createError, setCreateError] = useState<string>()
  const [creating, setCreating] = useState(false)
  const createLock = useRef(false)
  const [emptyPrompt, setEmptyPrompt] = useState("")
  const emptyPromptRef = useRef("")
  const focusCreatedSession = useRef<string | undefined>(undefined)
  const workspaceScope = useRef({ id: selectedWorkspaceId })
  if (workspaceScope.current.id !== selectedWorkspaceId) workspaceScope.current = { id: selectedWorkspaceId }
  useEffect(() => { emptyPromptRef.current = ""; focusCreatedSession.current = undefined; setEmptyPrompt("") }, [selectedWorkspaceId])
  useEffect(() => {
    if (selectedSessionId === undefined || focusCreatedSession.current !== selectedSessionId) return
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus()
      focusCreatedSession.current = undefined
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedSessionId])
  const [workPaneTab, setWorkPaneTab] = useState("changes")
  useEffect(() => {
    if (workPaneTab === "reminders" && (!selectedSessionId || !capabilities["desktop-schedule"]?.includes("1"))) setWorkPaneTab("changes")
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
  const sessionTitle = dashboard?.sessions.find((row) => row.id === selectedSessionId)?.title ?? t("未命名會話")
  const workspaceTitle = workspaces.find((row) => row.id === selectedWorkspaceId)?.label ?? t("尚未選擇會話")
  const canCreate = capabilities["session-create"]?.includes("1") === true

  async function createSession(seedEmptyPrompt = false): Promise<void> {
    if (selectedWorkspaceId === undefined || createLock.current || focusCreatedSession.current !== undefined) return
    const scope = workspaceScope.current
    createLock.current = true
    drawer.setOpen(false)
    setCreating(true)
    setCreateError(undefined)
    try {
      const created = await bridge.request({ kind: "session/create", workspaceId: selectedWorkspaceId })
      if (workspaceScope.current !== scope) return
      const sessionId = (created as { sessionId?: unknown } | undefined)?.sessionId
      if (typeof sessionId === "string") {
        if (seedEmptyPrompt) {
          writeDraft(selectedWorkspaceId, sessionId, emptyPromptRef.current)
          focusCreatedSession.current = sessionId
        }
        setMemoryOpen(false)
        onSelectSession(sessionId)
      }
      onSessionsChanged?.()
    } catch (reason) {
      if (workspaceScope.current === scope) setCreateError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      createLock.current = false
      setCreating(false)
    }
  }

  if (surface === "settings") return <SettingsPane onUseResource={selectedWorkspaceId && selectedSessionId ? (prefix) => {
    const draft = readDraft(selectedWorkspaceId, selectedSessionId)
    const next = draft.startsWith(prefix) ? draft : prefix + draft
    if (boundedDraft(next) !== next) throw new Error(t("草稿已達上限，請先整理內容。"))
    writeDraft(selectedWorkspaceId, selectedSessionId, next)
    setSurface("conversation")
  } : undefined} capabilities={capabilities} onRewindComplete={selectedWorkspaceId && capabilities["desktop-rewind"]?.includes("1") && onRewindComplete ? (sessionId) => onRewindComplete(selectedWorkspaceId, sessionId) : undefined} onManageSession={capabilities["desktop-sessions"]?.includes("1") ? onManageSession : undefined} bridge={bridge} workspace={workspaces.find((row) => row.id === selectedWorkspaceId)} onMemory={capabilities["desktop-memory"]?.includes("1") ? () => setSurface("memory") : undefined} onClose={() => setSurface("conversation")} />

  return (
    <div className={reviewOpen ? "workbench review-open" : "workbench"} data-sidebar-collapsed={drawer.narrow || sidebarCollapsed} style={{ "--review-width": `${reviewWidth}px` } as CSSProperties}>
      {drawer.narrow && drawer.open ? <button type="button" className="sidebar-scrim" tabIndex={-1} aria-label={t("關閉側欄")} onClick={() => drawer.setOpen(false)} /> : null}
      <div ref={drawer.container} className={drawer.narrow ? "sidebar-container sidebar-drawer" : "sidebar-container"} hidden={drawer.narrow ? !drawer.open : sidebarCollapsed} role={drawer.narrow && drawer.open ? "dialog" : undefined} aria-modal={drawer.narrow && drawer.open ? true : undefined} aria-label={drawer.narrow ? t("工作區") : undefined}>
      {drawer.narrow ? <button type="button" className="drawer-close primary-button" onClick={() => drawer.setOpen(false)}>{t("關閉側欄")}</button> : null}
      <WorkspaceSidebar
        workspaces={workspaces}
        selectedId={selectedWorkspaceId}
        onSelect={(id) => { drawer.setOpen(false); setSurface("conversation"); onSelectWorkspace(id) }}
        onOpen={() => onOpenWorkspace?.()}
        onCreate={() => { void createSession() }}
        canCreate={canCreate && !creating && selectedWorkspaceId !== undefined}
        onSettings={() => { drawer.setOpen(false); setSurface("settings") }}
        onPlugins={selectedWorkspaceId && capabilities["desktop-plugins"]?.includes("1") ? () => { drawer.setOpen(false); setSurface("plugins") } : undefined}
      >
        {dashboard === undefined ? null : <TaskList attentionCounts={attentionBySession} dashboard={dashboard} selectedId={selectedSessionId} onSelect={(id) => { drawer.setOpen(false); setMemoryOpen(false); onSelectSession(id) }} />}
      </WorkspaceSidebar>
      </div>
      <main className="center-pane">
        <TitleBar bridge={bridge} title={surface === "plugins" ? t("插件市場") : surface === "memory" ? t("工作區記憶") : surface === "search" ? t("搜尋會話") : selectedSessionId === undefined ? workspaceTitle : sessionTitle}
          leading={<button type="button" className="icon-button" aria-label={t("顯示側欄")} aria-expanded={drawer.narrow ? drawer.open : !sidebarCollapsed} onClick={() => drawer.narrow ? drawer.setOpen(!drawer.open) : updatePreferences({ sidebarCollapsed: !sidebarCollapsed })}><PanelLeft size={18} /></button>}>
          <button type="button" className="icon-button review-toggle" aria-label={t("成果檢查")} aria-expanded={reviewOpen} onClick={toggleReview}>
            <PanelRight size={18} />
          </button>
          {connection ? <span className={`connection-state connection-${connection}`} role="status">{t(connection === "online" ? "已連線" : connection === "offline" ? "連線已中斷" : connection === "reconnecting" ? "重新連線中…" : "連線中…")}</span> : null}
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
        {createError === undefined ? null : <p className="notice error-text">{createError}</p>}
        {surface === "plugins" && selectedWorkspaceId ? <PluginMarketplace key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} /> : surface === "search" && selectedWorkspaceId !== undefined && capabilities["desktop-session-search"]?.includes("1") ? <SessionSearch key={`${selectedWorkspaceId}:${selectedSessionId ?? ""}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} titles={Object.fromEntries((dashboard?.sessions ?? []).filter((row) => row.title).map((row) => [row.id, row.title!]))} onSelect={(id) => { setSurface("conversation"); onSelectSession(id) }} /> : memoryOpen && selectedWorkspaceId !== undefined && capabilities["desktop-memory"]?.includes("1") ? <MemoryPane key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} /> : <section className="session-body" aria-label={t("會話")}>
          {selectedSessionId !== undefined && selectedWorkspaceId !== undefined && conversation !== undefined
            ? (
              <>
                {conversation.historyError ? <p role="alert" className="notice error-text">{conversation.historyError}<button type="button" className="link-button" onClick={onRetry}>{t("重試")}</button></p> : null}
                {conversation.historyNotice ? <p className="notice history-notice">{conversation.historyNotice}</p> : null}
                {capabilities["desktop-work-state"]?.includes("1") && conversation.workState?.goal ? <div className="conversation-goal" title={conversation.workState.goal.objective}>
                  <span className="conversation-goal-label">{t("目前目標")}</span><span className="conversation-goal-objective">{conversation.workState.goal.objective}</span>
                  <span className="conversation-goal-phase">{t(conversation.workState.goal.phase === "paused" ? "已暫停" : conversation.workState.goal.phase === "complete" ? "已完成" : "進行中")}</span>
                </div> : null}
                {conversation.rows.length === 0
                  ? <div className="empty-conversation"><h1>{t("今天想完成甚麼？")}</h1><p>{t("描述你的目標，從這個工作區開始。")}</p></div>
                  : <Timeline key={`${selectedWorkspaceId}:${selectedSessionId}`} rows={conversation.rows} running={conversation.running} navigation={review && capabilities["desktop-review"]?.includes("1") ? { workspacePath: workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.path ?? "", onOpenFile: (path) => { if (!reviewOpen) toggleReview(); setWorkPaneTab("changes"); review.onSelect(path, "preview") } } : undefined} />}
                <div className="conversation-dock">
                <PendingPanel key={`${selectedWorkspaceId}:${selectedSessionId}`} pending={conversation.pending} onReply={conversation.onReply} />
                {conversation.pending.length > 0 && conversation.running ? <button type="button" className="link-button dock-cancel" onClick={conversation.onCancel}>{t("停止")}</button> : null}
                <div hidden={conversation.pending.length > 0}>
                <Composer
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
                  running={conversation.running}
                  modelLabel={conversation.modelLabel}
                  modelControl={bridge && conversation.onSetModel ? <SessionModelPicker key={`${selectedWorkspaceId}:${selectedSessionId}`} bridge={bridge} workspaceId={selectedWorkspaceId} current={conversation.modelState} disabled={conversation.running || conversation.operation?.busy === true} onSelect={conversation.onSetModel} /> : undefined}
                  onPrompt={conversation.onPrompt}
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
                  <div className="empty-composer"><ComposerSurface onSubmit={() => { void createSession(true) }}
                    editor={<textarea aria-label={t("提示")} className="composer-input" rows={3} value={emptyPrompt} disabled={!canCreate}
                      onChange={(event) => { const next = boundedDraft(event.target.value); emptyPromptRef.current = next; setEmptyPrompt(next); if (next.trim()) void createSession(true) }}
                      placeholder={t("輸入提示…")} />}
                    leadingActions={<span className="empty-composer-context"><FolderOpen size={15} />{workspaces.find((item) => item.id === selectedWorkspaceId)?.label}</span>}
                    trailingActions={<button type="submit" className="composer-send" aria-label={t("開始新任務")} disabled={!canCreate || creating}><ArrowUp size={18} /></button>}
                  /></div>
                </>}
              </div>}
        </section>}
        <footer className="workspace-status">
          {sandbox === undefined ? t("等待工作區連線") : `${t("沙箱")} · ${t(SANDBOX_LABELS[sandbox.mode])}`}
        </footer>
      </main>
      {reviewOpen ? <aside className="review-pane" aria-label={t("成果檢查")}>
        <ReviewResizeHandle width={reviewWidth} onResize={setReviewWidth} />
        <div className="work-pane-header"><PaneTabs id={workPaneId} label={t("成果檢查")} items={[{ id: "browser", label: t("瀏覽器") }, { id: "changes", label: t("變更") }, { id: "tasks", label: t("任務") }, ...(selectedSessionId && capabilities["desktop-schedule"]?.includes("1") ? [{ id: "reminders", label: t("提醒") }] : []), ...(capabilities["desktop-terminal"]?.includes("1") ? [{ id: "terminal", label: t("終端") }] : [])]} selected={workPaneTab} onSelect={setWorkPaneTab} />
          <button type="button" className="icon-button" aria-label={t("關閉成果面板")} onClick={toggleReview}>×</button></div>
        <div role="tabpanel" id={`${workPaneId}-panel`} aria-labelledby={`${workPaneId}-${workPaneTab}`}>
        {workPaneTab === "browser" && selectedWorkspaceId ? <BrowserPane key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} visible={!drawer.open} /> : null}
        {workPaneTab === "terminal" && selectedWorkspaceId && capabilities["desktop-terminal"]?.includes("1") ? <Suspense fallback={<p>{t("正在載入終端…")}</p>}><TerminalPane key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} /></Suspense> : null}
        {workPaneTab === "reminders" && selectedWorkspaceId && selectedSessionId && capabilities["desktop-schedule"]?.includes("1") ? <SchedulePane key={`${selectedWorkspaceId}:${selectedSessionId}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} canCreate={conversation?.modelState?.status === "ready" && !conversation.running && !conversation.queue?.length && conversation.operation?.busy !== true} /> : null}
        {workPaneTab !== "changes" || review === undefined || selectedWorkspaceId === undefined ? null : (
          <ReviewPane
            changes={review.changes}
            error={review.error}
            selected={review.selected}
            diff={review.diff}
            preview={review.preview}
            onSelect={review.onSelect}
            onRefresh={review.onRefresh}
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
            error={conversation.taskError}
            onCancelTask={conversation.onCancelTask}
            onCancelQueue={conversation.onCancelQueue}
          />
        )}
        {workPaneTab === "changes" && (review === undefined || selectedWorkspaceId === undefined) ? <p className="notice">{t("選擇工作區以檢查檔案變動。")}</p> : null}
        {workPaneTab === "tasks" && conversation === undefined ? <p className="notice">{t("尚未選擇會話")}</p> : null}
        {workPaneTab === "reminders" && !selectedSessionId ? <p className="notice">{t("尚未選擇會話")}</p> : null}
        </div>
      </aside> : null}
    </div>
  )
}
