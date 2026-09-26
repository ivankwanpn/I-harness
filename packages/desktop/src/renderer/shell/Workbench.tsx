import { useState } from "react"
import { PanelRight, Plus, FolderOpen } from "lucide-react"
import { useUiStore } from "./ui-store.ts"
import { useText, type Message } from "../design/i18n.ts"
import { MemoryPane } from "../memory/MemoryPane.tsx"
import { SessionSearch } from "../session/SessionSearch.tsx"
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

export interface ConversationView {
  rows: TimelineRow[]
  canSend: boolean
  sendReason?: string
  running: boolean
  modelLabel?: string
  operation?: SessionOperation
  canCompact?: boolean
  onCompact?(instructions?: string): Promise<void>
  queue?: SessionQueueItem[]
  tasks?: AgentTaskView[]
  taskError?: string
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
  capabilities,
  sandbox,
  error,
  selectedWorkspaceId,
  selectedSessionId,
  onSelectWorkspace,
  onSelectSession,
  onSessionsChanged,
  conversation,
  review,
  onRetry,
  onOpenWorkspace,
}: WorkbenchProps) {
  const t = useText()
  const [createError, setCreateError] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [compactOpen, setCompactOpen] = useState(false)
  const [surface, setSurface] = useState<"conversation" | "memory" | "search">("conversation")
  const memoryOpen = surface === "memory"
  const setMemoryOpen = (open: boolean | ((current: boolean) => boolean)) => setSurface((typeof open === "function" ? open(memoryOpen) : open) ? "memory" : "conversation")
  const reviewOpen = useUiStore((state) => state.reviewOpen)
  const toggleReview = useUiStore((state) => state.toggleReview)
  const sessionTitle = dashboard?.sessions.find((row) => row.id === selectedSessionId)?.title ?? t("未命名會話")
  const canCreate = capabilities["session-create"]?.includes("1") === true

  async function createSession(): Promise<void> {
    if (selectedWorkspaceId === undefined || creating) return
    setCreating(true)
    setCreateError(undefined)
    try {
      const created = await bridge.request({ kind: "session/create", workspaceId: selectedWorkspaceId })
      const sessionId = (created as { sessionId?: unknown } | undefined)?.sessionId
      if (typeof sessionId === "string") { setMemoryOpen(false); onSelectSession(sessionId) }
      onSessionsChanged?.()
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className={reviewOpen ? "workbench review-open" : "workbench"}>
      <WorkspaceSidebar
        workspaces={workspaces}
        selectedId={selectedWorkspaceId}
        onSelect={onSelectWorkspace}
        onOpen={() => onOpenWorkspace?.()}
        onCreate={() => { void createSession() }}
        canCreate={canCreate && !creating && selectedWorkspaceId !== undefined}
      >
        {dashboard === undefined ? null : <TaskList dashboard={dashboard} selectedId={selectedSessionId} onSelect={(id) => { setMemoryOpen(false); onSelectSession(id) }} />}
      </WorkspaceSidebar>
      <main className="center-pane">
        <header className="session-header" data-testid="session-header">
          {selectedSessionId === undefined
            ? <span className="muted">{t("尚未選擇會話")}</span>
            : <span className="header-title">{sessionTitle}</span>}
          <button type="button" className="icon-button review-toggle" aria-label={t("成果檢查")} aria-expanded={reviewOpen} onClick={toggleReview}>
            <PanelRight size={18} />
          </button>
          {selectedWorkspaceId !== undefined && capabilities["desktop-memory"]?.includes("1") ? <button type="button" className="primary-button" onClick={() => setMemoryOpen((open) => !open)}>{t(memoryOpen ? "返回會話" : "工作區記憶")}</button> : null}
          {selectedWorkspaceId !== undefined && capabilities["desktop-session-search"]?.includes("1") ? <button type="button" className="primary-button" onClick={() => setSurface(surface === "search" ? "conversation" : "search")}>{t(surface === "search" ? "返回會話" : "搜尋會話")}</button> : null}
        </header>
        <p data-testid="session-announcer" aria-live="polite" className="visually-hidden">
          {selectedSessionId === undefined ? "" : `已選擇會話 ${selectedSessionId}`}
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
        {surface === "search" && selectedWorkspaceId !== undefined && capabilities["desktop-session-search"]?.includes("1") ? <SessionSearch key={`${selectedWorkspaceId}:${selectedSessionId ?? ""}`} bridge={bridge} workspaceId={selectedWorkspaceId} sessionId={selectedSessionId} titles={Object.fromEntries((dashboard?.sessions ?? []).filter((row) => row.title).map((row) => [row.id, row.title!]))} onSelect={(id) => { setSurface("conversation"); onSelectSession(id) }} /> : memoryOpen && selectedWorkspaceId !== undefined && capabilities["desktop-memory"]?.includes("1") ? <MemoryPane key={selectedWorkspaceId} bridge={bridge} workspaceId={selectedWorkspaceId} /> : <section className="session-body" aria-label={t("會話")}>
          {selectedSessionId !== undefined && selectedWorkspaceId !== undefined && conversation !== undefined
            ? (
              <>
                {conversation.rows.length === 0
                  ? <div className="empty-conversation"><h1>{t("今天想完成甚麼？")}</h1><p>{t("描述你的目標，從這個工作區開始。")}</p></div>
                  : <Timeline rows={conversation.rows} />}
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
        <h2 className="review-title">{t("成果檢查")}</h2>
        {review === undefined || selectedWorkspaceId === undefined ? null : (
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
        {conversation === undefined ? null : (
          <TaskPane
            queue={conversation.queue}
            tasks={conversation.tasks}
            error={conversation.taskError}
            onCancelTask={conversation.onCancelTask}
            onCancelQueue={conversation.onCancelQueue}
          />
        )}
        {review === undefined || selectedWorkspaceId === undefined ? <p className="notice">{t("選擇工作區以檢查檔案變動。")}</p> : null}
      </aside> : null}
    </div>
  )
}
