// @vitest-environment jsdom
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { SessionDashboardResult } from "@i-harness/sdk"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"
import type { DesktopBridge } from "../src/shared/bridge.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"

const ENTRY: WorkspaceEntry = { id: "ws-1", path: "D:/workspace", label: "workspace" }

afterEach(() => { cleanup(); useUiStore.setState({ reviewOpen: false }); useLocale.getState().setLocale("zh-TW") })

function fakeBridge(): DesktopBridge {
  return {
    request: vi.fn(async () => undefined),
    onEvent: vi.fn(() => () => {}),
  }
}

function Harness(props: {
  dashboard: SessionDashboardResult
  capabilities?: Record<string, string[]>
}) {
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  return (
    <Workbench
      bridge={fakeBridge()}
      workspaces={[ENTRY]}
      dashboard={props.dashboard}
      capabilities={props.capabilities ?? { "session-create": ["1"] }}
      sandbox={{ mode: "read-only", source: "settings", wired: true }}
      selectedWorkspaceId={ENTRY.id}
      selectedSessionId={sessionId}
      onSelectWorkspace={() => {}}
      onSelectSession={setSessionId}
    />
  )
}

describe("Desktop workbench shell", () => {
  it("can hide and restore navigation without losing the header toggle", () => {
    render(<Harness dashboard={{ sessions: [] }} />)
    fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
    expect(screen.queryByRole("navigation", { name: "工作區" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "顯示側欄" }))
    expect(screen.getByRole("navigation", { name: "工作區" })).toBeTruthy()
  })
  it("preserves a draft while a pending request takes over the bottom dock", () => {
    const conversation = { rows: [], canSend: true, running: true, pending: [], onPrompt: async () => {}, onCancel: vi.fn(), onCancelTask: vi.fn(), onCancelQueue: vi.fn(), onReply: async () => {} }
    const props = { bridge: fakeBridge(), workspaces: [ENTRY], selectedWorkspaceId: ENTRY.id, selectedSessionId: "dock-test", capabilities: {}, onSelectWorkspace: vi.fn(), onSelectSession: vi.fn() }
    const view = render(<Workbench {...props} conversation={conversation} />)
    fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "保留此草稿" } })
    view.rerender(<Workbench {...props} conversation={{ ...conversation, pending: [{ requestId: "dock-approval", sessionId: "dock-test", kind: "approval", payload: { name: "write" }, openedAt: 1 }] }} />)
    expect(screen.queryByRole("textbox", { name: "提示" })).toBeNull()
    expect(screen.getByRole("button", { name: "確認" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "停止" })).toBeTruthy()
    view.rerender(<Workbench {...props} conversation={conversation} />)
    expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("保留此草稿")
  })
  it.each(["existing", "new"])("returns from Memory when opening a %s conversation", async (mode) => {
    const bridge = fakeBridge()
    bridge.request = vi.fn(async (request) => request.kind === "desktop/memory/state" ? { enabled: false }
      : request.kind === "desktop/memory/list" ? { notes: [] } : { sessionId: "created" })
    const onSelectSession = vi.fn()
    render(<Workbench bridge={bridge} workspaces={[ENTRY]} selectedWorkspaceId={ENTRY.id}
      dashboard={{ sessions: [{ id: "existing", title: "既有會話", live: false }] }}
      capabilities={{ "desktop-memory": ["1"], "session-create": ["1"] }}
      onSelectWorkspace={() => {}} onSelectSession={onSelectSession} />)
    fireEvent.click(screen.getByRole("button", { name: "工作區記憶" }))
    expect(await screen.findByRole("region", { name: "工作區記憶" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: mode === "existing" ? "既有會話" : "新增會話" }))
    await waitFor(() => expect(screen.queryByRole("region", { name: "工作區記憶" })).toBeNull())
    expect(onSelectSession).toHaveBeenCalledWith(mode === "existing" ? "existing" : "created")
  })
  it("switches shell language while preserving workspace navigation", () => {
    render(<Harness dashboard={{ sessions: [] }} />)
    fireEvent.click(screen.getByRole("button", { name: "設定" }))
    fireEvent.change(screen.getByRole("combobox", { name: "語言" }), { target: { value: "en" } })
    fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }))
    expect(screen.getByRole("button", { name: "New conversation" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Bring your ideas to life" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "workspace" })).toBeTruthy()
    expect(document.documentElement.lang).toBe("en")
  })
  it("keeps review closed until requested and allows closing it", () => {
    render(<Harness dashboard={{ sessions: [] }} />)
    expect(screen.queryByRole("complementary", { name: "成果檢查" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "成果檢查" }))
    expect(screen.getByRole("complementary", { name: "成果檢查" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "成果檢查" }))
    expect(screen.queryByRole("complementary", { name: "成果檢查" })).toBeNull()
  })
  it("says the session list is unavailable instead of showing zero sessions", () => {
    render(<Harness dashboard={{ sessions: [], listingUnavailable: true }} />)

    expect(screen.getByText("無法取得會話列表")).toBeTruthy()
    expect(screen.queryByText("尚無會話")).toBeNull()
  })

  it("says there are no sessions when the host really listed none", () => {
    render(<Harness dashboard={{ sessions: [] }} />)

    expect(screen.getByText("尚無會話")).toBeTruthy()
    expect(screen.queryByText("無法取得會話列表")).toBeNull()
  })

  it("selects a session row, announces it, and shows it in the central header", () => {
    render(
      <Harness dashboard={{
        sessions: [
          { id: "session-a", live: true },
          { id: "session-b", title: "第二個", live: false, turnCount: 3 },
        ],
      }} />,
    )

    expect(screen.getByTestId("session-header").textContent).toContain("尚未選擇會話")
    fireEvent.click(screen.getByRole("button", { name: /第二個/ }))

    expect(screen.getByTestId("session-header").textContent).toContain("第二個")
    expect(screen.getByTestId("session-announcer").textContent).toContain("第二個")
  })

  it("renders a disabled create control when the host lacks session-create", () => {
    render(<Harness dashboard={{ sessions: [] }} capabilities={{ "session-list": ["1"] }} />)

    const create = screen.getByRole("button", { name: "新增會話" })
    expect(create.hasAttribute("disabled")).toBe(true)
  })

  it("enables the create control when the host advertises session-create", () => {
    render(<Harness dashboard={{ sessions: [] }} />)

    const create = screen.getByRole("button", { name: "新增會話" })
    expect(create.hasAttribute("disabled")).toBe(false)
  })

  it("offers a folder control that asks the main process to open a workspace", () => {
    const bridge = fakeBridge()
    const request = vi.fn(async () => ({ id: "ws-2", path: "D:/other", label: "other" }))
    bridge.request = request

    render(
      <Workbench
        bridge={bridge}
        workspaces={[ENTRY]}
        dashboard={{ sessions: [] }}
        capabilities={{ "session-create": ["1"] }}
        selectedWorkspaceId={ENTRY.id}
        onSelectWorkspace={() => {}}
        onSelectSession={() => {}}
        onOpenWorkspace={() => { void bridge.request({ kind: "workspace/pick" }) }}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "開啟工作區" }))
    expect(request).toHaveBeenCalledWith({ kind: "workspace/pick" })
  })

  it("shows last activity only when the host reported it", () => {
    render(
      <Harness dashboard={{
        sessions: [
          { id: "session-a", live: true },
          { id: "session-b", live: true, updatedAt: Date.UTC(2026, 0, 2, 3, 4, 5) },
        ],
      }} />,
    )

    expect(screen.getAllByText(/最後活動/)).toHaveLength(1)
  })

  it("offers a retry when a load failed", () => {
    const onRetry = vi.fn()
    render(
      <Workbench
        bridge={fakeBridge()}
        workspaces={[]}
        capabilities={{}}
        error="連線失敗"
        onRetry={onRetry}
        onSelectWorkspace={() => {}}
        onSelectSession={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "重試" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
