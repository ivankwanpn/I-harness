import { useState } from "react"
import type { SessionDashboardResult } from "@i-harness/sdk"
import type { SandboxState } from "../../main/sdk-runtime.ts"
import type { WorkspaceEntry } from "../../main/workspaces.ts"
import type { DesktopBridge } from "../../shared/bridge.ts"
import { TaskList } from "./TaskList.tsx"
import { WorkspaceSidebar } from "./WorkspaceSidebar.tsx"

export interface WorkbenchProps {
  bridge: DesktopBridge
  workspaces: WorkspaceEntry[]
  dashboard?: SessionDashboardResult
  capabilities: Record<string, string[]>
  sandbox?: SandboxState
  error?: string
  selectedWorkspaceId?: string
  selectedSessionId?: string
  onSelectWorkspace(workspaceId: string): void
  onSelectSession(sessionId: string): void
  onSessionsChanged?(): void
}

const SANDBOX_LABELS: Record<SandboxState["mode"], string> = {
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
}: WorkbenchProps) {
  const [createError, setCreateError] = useState<string>()
  const canCreate = capabilities["session-create"]?.includes("1") === true

  async function createSession(): Promise<void> {
    if (selectedWorkspaceId === undefined) return
    setCreateError(undefined)
    try {
      const created = await bridge.request({ kind: "session/create", workspaceId: selectedWorkspaceId })
      const sessionId = (created as { sessionId?: unknown } | undefined)?.sessionId
      if (typeof sessionId === "string") onSelectSession(sessionId)
      onSessionsChanged?.()
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <div className="workbench">
      <WorkspaceSidebar workspaces={workspaces} selectedId={selectedWorkspaceId} onSelect={onSelectWorkspace} />
      <main className="center-pane">
        <header className="session-header" data-testid="session-header">
          <button
            type="button"
            className="primary-button"
            disabled={!canCreate}
            title={canCreate ? "建立新會話" : "此宿主未提供建立會話能力"}
            onClick={() => { void createSession() }}
          >
            新增會話
          </button>
          {selectedSessionId === undefined
            ? <span className="muted">尚未選擇會話</span>
            : <span>會話 <span className="session-header-id">{selectedSessionId}</span></span>}
        </header>
        <p data-testid="session-announcer" aria-live="polite" className="visually-hidden">
          {selectedSessionId === undefined ? "" : `已選擇會話 ${selectedSessionId}`}
        </p>
        {error === undefined ? null : <p className="notice error-text">{error}</p>}
        {createError === undefined ? null : <p className="notice error-text">{createError}</p>}
        <section className="session-body" aria-label="會話">
          {dashboard === undefined
            ? <p className="notice">正在載入會話…</p>
            : <TaskList dashboard={dashboard} selectedId={selectedSessionId} onSelect={onSelectSession} />}
        </section>
      </main>
      <aside className="review-pane" aria-label="成果檢查">
        <h2 className="review-title">成果檢查</h2>
        <p className="sandbox-row">
          沙箱：
          {sandbox === undefined
            ? <span className="muted">此宿主未回報</span>
            : <span>{SANDBOX_LABELS[sandbox.mode]}（{sandbox.source}，已接線）</span>}
        </p>
        <p className="notice">逐檔變動與檔案預覽會在成果檢查契約接通後出現。</p>
      </aside>
    </div>
  )
}
