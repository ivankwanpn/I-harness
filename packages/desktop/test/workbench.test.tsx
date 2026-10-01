// @vitest-environment jsdom
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { SessionDashboardResult } from "@i-harness/sdk"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"
import type { DesktopBridge } from "../src/shared/bridge.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"
import { writeDraft, readDraft, clearDraft } from "../src/renderer/session/Composer.tsx"

const ENTRY: WorkspaceEntry = { id: "ws-1", path: "D:/workspace", label: "workspace" }

afterEach(() => { cleanup(); useUiStore.setState({ reviewOpen: false, surface: "conversation" }); useLocale.getState().setLocale("zh-TW") })

it("opens delegated work in its own pane while retaining the selected parent conversation", async () => {
  const request = vi.fn(async (input: { kind: string }) => input.kind === "desktop/session/subagents/list" ? { parentSessionId: "parent", agents: [] } : undefined)
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[ENTRY]} selectedWorkspaceId={ENTRY.id} selectedSessionId="parent" capabilities={{ "desktop-subagent-catalog": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => { throw new Error("Subagent pane must not select a main chat") }}
    conversation={{ rows: [], canSend: false, running: false, pending: [], onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
  fireEvent.click(screen.getByRole("button", { name: "子代理" }))
  await waitFor(() => expect(screen.getByRole("tab", { name: "子代理" }).getAttribute("aria-selected")).toBe("true"))
  await waitFor(() => expect(screen.getByText("尚無子代理")).toBeTruthy())
  expect(request).toHaveBeenCalledWith({ kind: "desktop/session/subagents/list", workspaceId: ENTRY.id, sessionId: "parent" })
})

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
  it("shows the durable goal objective and actual phase above the conversation", () => {
    render(<Workbench bridge={fakeBridge()} workspaces={[ENTRY]} selectedWorkspaceId={ENTRY.id} selectedSessionId="goal-1" capabilities={{ "desktop-work-state": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}}
      conversation={{ rows: [], canSend: false, running: false, pending: [], workState: { todos: null, goal: { id: "goal-1", revision: 2, objective: "Finish the workbench", phase: "paused" } }, onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
    expect(screen.getByText("Finish the workbench")).toBeTruthy()
    expect(screen.getByText("已暫停")).toBeTruthy()
  })
  it("shows a work-state failure in the default conversation view and hides an unverified goal", () => {
    render(<Workbench bridge={fakeBridge()} workspaces={[ENTRY]} selectedWorkspaceId={ENTRY.id} selectedSessionId="goal-1" capabilities={{ "desktop-work-state": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}}
      conversation={{ rows: [], canSend: false, running: false, pending: [], workStateError: "fresh goal unavailable", workState: { todos: null, goal: { id: "g", revision: 1, objective: "Outdated goal", phase: "active" } }, onRetryWorkState() {}, onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
    expect(screen.getByRole("alert").textContent).toContain("fresh goal unavailable")
    expect(screen.getByRole("button", { name: "重試" })).toBeTruthy()
    expect(screen.queryByText("Outdated goal")).toBeNull()
  })
  it("shows conversation reminders only when the backend advertises schedule management", async () => {
    useUiStore.setState({ reviewOpen: true })
    const bridge = fakeBridge()
    bridge.request = vi.fn(async (request) => request.kind === "desktop/schedule/list" ? { schedules: [] } : undefined)
    const base = { bridge, workspaces: [ENTRY], selectedWorkspaceId: ENTRY.id, selectedSessionId: "s-1", onSelectWorkspace: () => {}, onSelectSession: () => {}, conversation: { rows: [], canSend: false, running: false, modelState: { status: "ready" as const, providerId: "deepseek", modelId: "deepseek-flash", label: "DeepSeek Flash" }, pending: [], onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} } }
    const rendered = render(<Workbench {...base} capabilities={{ "desktop-schedule": ["1"] }} />)
    fireEvent.click(screen.getByRole("tab", { name: "提醒" }))
    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/schedule/list", workspaceId: ENTRY.id, sessionId: "s-1" }))
    expect(screen.getByText("此會話尚無提醒")).toBeTruthy()
    rendered.rerender(<Workbench {...base} conversation={{ ...base.conversation, queue: [{ id: "q-1", text: "queued", delivery: "queue", intent: "user", state: "queued", order: 1 }] }} capabilities={{ "desktop-schedule": ["1"] }} />)
    expect(screen.queryByRole("button", { name: "建立提醒" })).toBeNull()
    rendered.rerender(<Workbench {...base} capabilities={{}} />)
    expect(screen.queryByRole("tab", { name: "提醒" })).toBeNull()
    await waitFor(() => expect(screen.getByRole("tab", { name: "變更" }).getAttribute("aria-selected")).toBe("true"))
  })
  it("shows a new-task composer without creating a session until typing, then preserves typed text", async () => {
    let finish!: (result: { sessionId: string }) => void
    const pending = new Promise<{ sessionId: string }>((resolve) => { finish = resolve })
    const bridge = fakeBridge()
    bridge.request = vi.fn(async (request) => request.kind === "session/create" ? pending : undefined)
    const onSelectSession = vi.fn()
    function NewTask() {
      const [selected, setSelected] = useState<string>()
      return <Workbench bridge={bridge} workspaces={[ENTRY]} dashboard={{ sessions: [] }} selectedWorkspaceId={ENTRY.id}
        selectedSessionId={selected} capabilities={{ "session-create": ["1"] }} onSelectWorkspace={() => {}}
        onSelectSession={(id) => { onSelectSession(id); setSelected(id) }}
        conversation={selected ? { rows: [], canSend: false, running: false, pending: [], onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} } : undefined} />
    }
    render(<NewTask />)
    const editor = screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement
    expect(bridge.request).not.toHaveBeenCalledWith({ kind: "session/create", workspaceId: ENTRY.id })
    fireEvent.focus(editor)
    expect(bridge.request).not.toHaveBeenCalledWith({ kind: "session/create", workspaceId: ENTRY.id })
    fireEvent.change(editor, { target: { value: "Review the playground" } })
    await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "session/create", workspaceId: ENTRY.id }))
    await act(async () => finish({ sessionId: "created-from-composer" }))
    await waitFor(() => expect(onSelectSession).toHaveBeenCalledWith("created-from-composer"))
    expect(readDraft(ENTRY.id, "created-from-composer")).toBe("Review the playground")
    await waitFor(() => expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("Review the playground"))
    clearDraft(ENTRY.id, "created-from-composer")
  })
  it("does not create a second empty session while the first selection is rendering", async () => {
    const bridge = fakeBridge()
    bridge.request = vi.fn(async (request) => request.kind === "session/create" ? { sessionId: "created-once" } : undefined)
    const onSelectSession = vi.fn()
    render(<Workbench bridge={bridge} workspaces={[ENTRY]} dashboard={{ sessions: [] }} selectedWorkspaceId={ENTRY.id}
      capabilities={{ "session-create": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={onSelectSession} />)
    const editor = screen.getByRole("textbox", { name: "提示" })
    fireEvent.change(editor, { target: { value: "First" } })
    await waitFor(() => expect(onSelectSession).toHaveBeenCalledWith("created-once"))
    fireEvent.change(editor, { target: { value: "First and second" } })
    const calls = vi.mocked(bridge.request).mock.calls.filter(([request]) => request.kind === "session/create")
    expect(calls).toHaveLength(1)
    clearDraft(ENTRY.id, "created-once")
  })
  it("keeps the new-task draft after creation fails and transfers it on retry", async () => {
    let fail = true
    const bridge = fakeBridge()
    bridge.request = vi.fn(async (request) => request.kind === "session/create"
      ? fail ? Promise.reject(new Error("workspace unavailable")) : { sessionId: "created-after-retry" }
      : undefined)
    const onSelectSession = vi.fn()
    render(<Workbench bridge={bridge} workspaces={[ENTRY]} dashboard={{ sessions: [] }} selectedWorkspaceId={ENTRY.id}
      capabilities={{ "session-create": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={onSelectSession} />)
    const editor = screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: "Keep this task" } })
    await waitFor(() => expect(screen.getByText("workspace unavailable")).toBeTruthy())
    expect(editor.value).toBe("Keep this task")
    fail = false
    fireEvent.click(screen.getByRole("button", { name: "開始新任務" }))
    await waitFor(() => expect(onSelectSession).toHaveBeenCalledWith("created-after-retry"))
    expect(readDraft(ENTRY.id, "created-after-retry")).toBe("Keep this task")
    clearDraft(ENTRY.id, "created-after-retry")
  })
  it("inserts a settings command into the existing draft without sending", async () => {
    const bridge = fakeBridge()
    bridge.request = vi.fn(async (request) => request.kind === "desktop/resources/list" ? { items: [{ name: "hello", source: "plugin" }], total: 1, diagnostics: [] }
      : request.kind === "desktop/resources/read" ? { name: "hello", source: "plugin", body: "A prompt", truncated: false } : { notifications: false, notificationsSupported: false })
    const onPrompt = vi.fn(async () => {})
    writeDraft(ENTRY.id, "resource-test", "existing prompt")
    useUiStore.setState({ surface: "settings" })
    render(<Workbench bridge={bridge} workspaces={[ENTRY]} selectedWorkspaceId={ENTRY.id} selectedSessionId="resource-test" capabilities={{ "desktop-resources": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}}
      conversation={{ rows: [], canSend: true, running: false, pending: [], onPrompt, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
    fireEvent.click(screen.getByRole("button", { name: "命令" }))
    fireEvent.click(await screen.findByRole("button", { name: "hello" }))
    fireEvent.click(await screen.findByRole("button", { name: "帶入此命令" }))
    expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("/hello existing prompt")
    expect(onPrompt).not.toHaveBeenCalled()
    clearDraft(ENTRY.id, "resource-test")
  })
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
    expect(screen.getByRole("button", { name: "批准" })).toBeTruthy()
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
    expect(screen.queryByRole("navigation", { name: "工作區" })).toBeNull()
    fireEvent.change(screen.getByRole("combobox", { name: "語言" }), { target: { value: "en" } })
    fireEvent.click(screen.getByRole("button", { name: "Back to conversation" }))
    expect(screen.getByRole("button", { name: "New conversation" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "What would you like to work on?" })).toBeTruthy()
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

    expect(screen.getByTestId("session-header").textContent).toContain("workspace")
    fireEvent.click(screen.getByRole("button", { name: /^第二個/ }))

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
