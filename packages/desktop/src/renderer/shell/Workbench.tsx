import { useId, useRef, useState, type CSSProperties } from "react"
import { Brain, Search, PanelLeft, PanelRight, Plus, FolderOpen } from "lucide-react"
import { useUiStore } from "./ui-store.ts"
import { useText, type Message } from "../design/i18n.ts"
import { MemoryPane } from "../memory/MemoryPane.tsx"
import { SessionSearch } from "../session/SessionSearch.tsx"
import { SettingsPane } from "../settings/SettingsPane.tsx"
import { useAppearance, usePreferences } from "../design/preferences.ts"
import { CompactionPanel } from "../session/CompactionPanel.tsx"
import type { SessionOperation } from "../session/use-session-operation.ts"
import type { AgentTaskView, SessionDashboardResult, SessionQueueItem } from "@i-harness/sdk"
import type { SandboxState } from "../../main/sdk-runtime.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { Composer } from "../session/Composer.tsx"
import type { TimelineRow } from "../session/project.ts"
import { TaskPane } from "../session/TaskPane.tsx"
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
import type { ManageSession } from "../session/SessionManager.tsx"
import type { SessionModelSelection, SessionModelState } from "@i-harness/sdk"

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
  taskError?: string
  historyError?: string
  historyNotice?: string
  pending: PendingInteraction[]
  onPrompt(text: string): Promise<void>
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
  useAppearance()
  const sidebarCollapsed = usePreferences((state) => state.sidebarCollapsed)
  const updatePreferences = usePreferences((state) => state.update)
  const [createError, setCreateError] = useState<string>()
  const [creating, setCreating] = useState(false)
  const createLock = useRef(false)
  const workspaceScope = useRef({ id: selectedWorkspaceId })
  if (workspaceScope.current.id !== selectedWorkspaceId) workspaceScope.current = { id: selectedWorkspaceId }
  const [compactOpen, setCompactOpen] = useState(false)
  const [workPaneTab, setWorkPaneTab] = useState("changes")
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
  const canCreate = capabilities["session-create"]?.includes("1") === true

  async function createSession(): Promise<void> {
    if (selectedWorkspaceId === undefined || createLock.current) return
    const scope = workspaceScope.current
    createLock.current = true
    drawer.setOpen(false)
    setCreating(true)
    setCreateError(undefined)
    try {
      const created = await bridge.request({ kind: "session/create", workspaceId: selectedWorkspaceId })
      if (workspaceScope.current !== scope) return
      const sessionId = (created as { sessionId?: unknown } | undefined)?.sessionId
      if (typeof sessionId === "string") { setMemoryOpen(false); onSelectSession(sessionId) }
      onSessionsChanged?.()
    } catch (reason) {
      if (workspaceScope.current === scope) setCreateError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      createLock.current = false
      setCreating(false)
    }
  }

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
      >
        {dashboard === undefined ? null : <TaskList attentionCounts={attentionBySession} dashboard={dashboard} selectedId={selectedSessionId} onSelect={(id) => { drawer.setOpen(false); setMemoryOpen(false); onSelectSession(id) }} />}
      </WorkspaceSidebar>
      </div>
      <main className="center-pane">
        <TitleBar bridge={bridge} title={surface === "settings" ? t("設定") : surface === "memory" ? t("工作區記憶") : surface === "search" ? t("搜尋會話") : selectedSessionId === undefined ? t("尚未選擇會話") : sessionTitle}
          leading={<button type="button" className="icon-button" aria-label={t("顯示側欄")} aria-expanded={drawer.narrow ? drawer.open : !sidebarCollapsed} onClick={() => drawer.narrow ? drawer.setOpen(!drawer.open) : updatePreferences({ sidebarCollapsed: !sidebarCollapsed })}><PanelLeft size={18} /></button>}>
          <button type="button" className="icon-button review-toggle" aria-label={t("成果檢查")} aria-expanded={reviewOpen} onClick={toggleReview}>
            <PanelRight size={18} />
          </button>
          {connection ? <span className={`connection-state connection-${connection}`} role="status">{t(connection === "online" ? "已連線" : connection === "offline" ? "連線已中斷" : connection === "reconnecting" ? "重新連線中…" : "連線中…")}</span> : null}
          {selectedWorkspaceId !== undefined && capabilities["desktop-memory"]?.includes("1") ? <button type="button" className="primary-button header-action" aria-label={t(memoryOpen ? "返回會話" : "工作區記憶")} title={t(memoryOpen ? "返回會話" : "工作區記憶")} onClick={() => setMemoryOpen((open) => !open)}><Brain size={16} /><span className="header-action-label">{t(memoryOpen ? "返回會話" : "工作區記憶")}</span></button> : null}
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
        {conversation?.onCompact && capabilities["desktop-compaction"]?.includes("1") ? <div className="compaction-entry">
          <button type="button" className="link-button" aria-expanded={compactOpen} onClick={() => setCompactOpen((open) => !open)}>{t("壓縮上下文")}</button>
          {compactOpen ? <CompactionPanel key={`${selectedWorkspaceId}:${selectedSessionId}`} operation={conversation.operation} disabled={!conversation.canCompact} onCompact={conversation.onCompact} onCancel={conversation.onCancel} /> : null}
        </div> : null}
        {surface === "settings" ? <SettingsPane onRewindComplete={selectedWorkspaceId && capabilities["desktop-rewind"]?.includes("1") && onRewindComplete ? (sessionId) => onRewindComplete(selectedWorkspaceId, sessionId) : undefined} onManageSession={capabilities["desktop-sessions"]?.includes("1") ? onManageSession : undefined} bridge={bridge} workspace={workspaces.find((row) => row.id === selectedWorkspaceId)} onMemory={capabilities["desktop-memory"]?.includes("1") ? () => setSurface("memory") : undefined} onClose={() => setSurface("conversation")} /> : surface === "search" && selectedWorkspaceId !== undefined && capabilities["desktop-session-search"]?.includes("1") ? <SessionSearch key={`${selectedWorkspaceId}:${selectedSessionId ?? ""}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} titles={Object.fromEntries((dashboard?.sessions ?? []).filter((row) => row.title).map((row) => [row.id, row.title!]))} onSelect={(id) => { setSurface("conversation"); onSelectSession(id) }} /> : memoryOpen && selectedWorkspaceId !== undefined && capabilities["desktop-memory"]?.includes("1") ? <MemoryPane key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} /> : <section className="session-body" aria-label={t("會話")}>
          {selectedSessionId !== undefined && selectedWorkspaceId !== undefined && conversation !== undefined
            ? (
              <>
                {conversation.historyError ? <p role="alert" className="notice error-text">{conversation.historyError}<button type="button" className="link-button" onClick={onRetry}>{t("重試")}</button></p> : null}
                {conversation.historyNotice ? <p className="notice history-notice">{conversation.historyNotice}</p> : null}
                {conversation.rows.length === 0
                  ? <div className="empty-conversation"><h1>{t("今天想完成甚麼？")}</h1><p>{t("描述你的目標，從這個工作區開始。")}</p></div>
                  : <Timeline key={`${selectedWorkspaceId}:${selectedSessionId}`} rows={conversation.rows} />}
                <div className="conversation-dock">
                <PendingPanel key={`${selectedWorkspaceId}:${selectedSessionId}`} pending={conversation.pending} onReply={conversation.onReply} />
                {conversation.pending.length > 0 && conversation.running ? <button type="button" className="link-button dock-cancel" onClick={conversation.onCancel}>{t("停止")}</button> : null}
                <div hidden={conversation.pending.length > 0}>
                <Composer
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
                <span className="welcome-mark">I</span>
                <h1>{t("讓想法成為成果")}</h1>
                <p>{t(selectedWorkspaceId === undefined ? "選擇本機資料夾，開始你的第一個任務。" : "延續左側的會話，或開始一項新任務。")}</p>
                <button type="button" className="welcome-action" disabled={selectedWorkspaceId !== undefined && (!canCreate || creating)} onClick={() => selectedWorkspaceId === undefined ? onOpenWorkspace?.() : void createSession()}>
                  {selectedWorkspaceId === undefined ? <FolderOpen size={17} /> : <Plus size={17} />}
                  {t(selectedWorkspaceId === undefined ? "選擇資料夾" : "開始新任務")}
                </button>
              </div>}
        </section>}
        <footer className="workspace-status">
          {sandbox === undefined ? t("等待工作區連線") : `${t("沙箱")} · ${t(SANDBOX_LABELS[sandbox.mode])}`}
        </footer>
      </main>
      {reviewOpen ? <aside className="review-pane" aria-label={t("成果檢查")}>
        <ReviewResizeHandle width={reviewWidth} onResize={setReviewWidth} />
        <div className="work-pane-header"><PaneTabs id={workPaneId} label={t("成果檢查")} items={[{ id: "changes", label: t("變更") }, { id: "tasks", label: t("任務") }]} selected={workPaneTab} onSelect={setWorkPaneTab} />
          <button type="button" className="icon-button" aria-label={t("關閉成果面板")} onClick={toggleReview}>×</button></div>
        <div role="tabpanel" id={`${workPaneId}-panel`} aria-labelledby={`${workPaneId}-${workPaneTab}`}>
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
            queue={conversation.queue}
            tasks={conversation.tasks}
            error={conversation.taskError}
            onCancelTask={conversation.onCancelTask}
            onCancelQueue={conversation.onCancelQueue}
          />
        )}
        {workPaneTab === "changes" && (review === undefined || selectedWorkspaceId === undefined) ? <p className="notice">{t("選擇工作區以檢查檔案變動。")}</p> : null}
        {workPaneTab === "tasks" && conversation === undefined ? <p className="notice">{t("尚未選擇會話")}</p> : null}
        </div>
      </aside> : null}
    </div>
  )
}
