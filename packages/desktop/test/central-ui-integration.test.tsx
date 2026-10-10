// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Workbench, type WorkbenchProps } from "../src/renderer/shell/Workbench.tsx"
import { SettingsPane } from "../src/renderer/settings/SettingsPane.tsx"
import { ToolActivity } from "../src/renderer/session/ToolActivity.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import { useLocale } from "../src/renderer/design/i18n.ts"
import type { DesktopBridge, DesktopRequest } from "../src/shared/bridge.ts"

afterEach(() => { cleanup(); localStorage.clear(); useUiStore.setState({ surface: "conversation", reviewOpen: false }); useLocale.getState().setLocale("zh-TW") })
const workspace = { id: "source", path: "D:/source", label: "Source" }
const notification = { unread: 1, items: [{ id: "n", workspaceId: "source", sessionId: "moved", kind: "approval", summary: "Pending request", read: false, createdAt: "2026-10-03T00:00:00Z" }] }
function bridgeFor(handle: (request: DesktopRequest) => unknown): DesktopBridge {
  return { request: vi.fn(async request => handle(request)), onEvent: () => () => {} }
}
function base(bridge: DesktopBridge): WorkbenchProps {
  return { projects: [], bridge, workspaces: [workspace], selectedWorkspaceId: "source", selectedSessionId: "moved", capabilities: {}, onSelectWorkspace() {}, onSelectSession() {}, conversation: { rows: [], running: false, canSend: false, pending: [], onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} } }
}

it("mounts provider configuration without a folder, native auto-title and actual About copy", async () => {
  const bridge = bridgeFor(request => request.kind === "desktop/global-provider/directory" ? [] : request.kind === "desktop/global-preferences/state" ? { enabled: true }
    : request.kind === "desktop/global-preferences/configure" ? { enabled: request.autoTitle }
    : request.kind === "desktop/about/info" ? { version: "acceptance", node: "24", electron: "39", platform: "win32", arch: "x64", packaged: true }
    : request.kind === "desktop/local/state" ? { notifications: false, notificationsSupported: true } : [])
  render(<SettingsPane bridge={bridge} onClose={() => {}} />)
  const toggle = await screen.findByRole("checkbox", { name: "自動產生會話標題" })
  await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false))
  fireEvent.click(toggle)
  await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/global-preferences/configure", autoTitle: false }))
  fireEvent.click(screen.getByRole("button", { name: "模型與提供商" }))
  await screen.findByText("沒有可用的提供商")
  expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/global-provider/directory" })
  fireEvent.click(screen.getByRole("button", { name: "關於" }))
  await screen.findByText("acceptance")
  fireEvent.click(screen.getByRole("button", { name: "複製" }))
  await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/about/copy" }))
})

it("validates notification navigation with the storage owner and destination project", async () => {
  useUiStore.setState({ surface: "settings" }); localStorage.setItem("ih:settings-section", "notifications")
  const bridge = bridgeFor(request => request.kind === "desktop/notifications/list" ? notification
    : request.kind === "desktop/notifications/target" ? { workspaceId: "source", sessionId: "moved", projectId: "destination" } : { notifications: true, notificationsSupported: true })
  const navigate = vi.fn()
  render(<Workbench {...base(bridge)} onSelectSessionInWorkspace={navigate} />)
  await screen.findByText("Pending request")
  fireEvent.click(screen.getByRole("button", { name: "開啟會話" }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("source", "moved", "destination"))
  expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/notifications/target", workspaceId: "source", sessionId: "moved" })
})

it("keeps failed notification targets and ignores a delayed target after selection changed", async () => {
  useUiStore.setState({ surface: "settings" }); localStorage.setItem("ih:settings-section", "notifications")
  let resolve!: (value: unknown) => void
  let fail = true
  const bridge = bridgeFor(request => request.kind === "desktop/notifications/list" ? notification : request.kind === "desktop/notifications/target" ? fail ? Promise.reject(Error("Archived conversation")) : new Promise(done => { resolve = done }) : { notifications: true, notificationsSupported: true })
  const navigate = vi.fn()
  const view = render(<Workbench {...base(bridge)} onSelectSessionInWorkspace={navigate} />)
  await screen.findByText("Pending request")
  fireEvent.click(screen.getByRole("button", { name: "開啟會話" }))
  await screen.findByText("Archived conversation")
  expect(screen.getByText("Pending request")).toBeTruthy()
  fail = false
  fireEvent.click(screen.getByRole("button", { name: "開啟會話" }))
  view.rerender(<Workbench {...base(bridge)} selectedSessionId="newer" onSelectSessionInWorkspace={navigate} />)
  await act(async () => { resolve({ workspaceId: "source", sessionId: "moved" }); await Promise.resolve() })
  expect(navigate).not.toHaveBeenCalled()
})

it("mounts execution and process entry points against the selected owning session", async () => {
  const bridge = bridgeFor(request => request.kind === "desktop/session/execution/read" ? { cells: [], total: 0, hasMore: false }
    : request.kind === "desktop/session/processes/read" ? { terminals: [], jobs: [] } : [])
  render(<Workbench {...base(bridge)} capabilities={{ "desktop-execution": ["1"], "desktop-agent-processes": ["1"] }} />)
  fireEvent.click(screen.getByRole("button", { name: "工作台工具" }))
  fireEvent.click(screen.getByRole("button", { name: "Code Mode" }))
  await screen.findByText("尚無 Code Mode cell")
  expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/session/execution/read", workspaceId: "source", sessionId: "moved", offset: 0, limit: 10 })
  fireEvent.click(screen.getByRole("button", { name: "工作台工具" }))
  fireEvent.click(screen.getByRole("button", { name: "Agent 程序" }))
  await screen.findByText("目前沒有此會話擁有的 PTY 程序")
  expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/session/processes/read", workspaceId: "source", sessionId: "moved" })
})

it("opens an absolute tool file in the second project root with a fresh ref on each click", () => {
  const open = vi.fn(), legacy = vi.fn()
  render(<ToolActivity name="read" args={{ path: "D:/second/same.txt" }} navigation={{ workspaceId: "source", workspacePath: "D:/source", projectRoots: [{ workspaceId: "source", path: "D:/source" }, { workspaceId: "second", path: "D:/second" }], onOpenFile: legacy, onOpenProjectFile: open }} />)
  fireEvent.click(screen.getByRole("button", { name: "在成果面板開啟 same.txt" }))
  fireEvent.click(screen.getByRole("button", { name: "在成果面板開啟 same.txt" }))
  expect(open.mock.calls.map(([ref]) => ref)).toEqual([{ workspaceId: "second", path: "same.txt" }, { workspaceId: "second", path: "same.txt" }])
  expect(open.mock.calls[0]![0]).not.toBe(open.mock.calls[1]![0])
  expect(legacy).not.toHaveBeenCalled()
})

it("opens a restored context reference at its actual workspace, session and sequence", async () => {
  localStorage.setItem("ih:draft:source:moved:context-references", JSON.stringify([{ kind: "session", workspaceId: "second", sessionId: "old", seq: 321, label: "Earlier discussion" }]))
  const history = vi.fn()
  render(<Workbench {...base(bridgeFor(() => []))} onSelectHistory={history} />)
  fireEvent.click(await screen.findByRole("button", { name: "Earlier discussion · second/old#321" }))
  expect(history).toHaveBeenCalledWith({ workspaceId: "second", sessionId: "old", seq: 321 })
})

it("mounts the batch manager, confirms the action and retains only failed selections", async () => {
  const sessions = [{ id: "moved", title: "First", live: false }, { id: "blocked", title: "Busy", live: false }]
  const bridge = bridgeFor(request => request.kind === "session/list" ? { sessions } : request.kind === "desktop/session/navigation/state" ? { moved: { projectId: "original" }, blocked: { projectId: "original" } } : [])
  const batch = vi.fn(async () => ({ results: [{ sessionId: "moved", ok: true as const }, { sessionId: "blocked", ok: false as const, error: "Live work prevents archive" }] }))
  render(<Workbench {...base(bridge)} dashboard={{ sessions }} capabilities={{ "desktop-sessions": ["1"] }} onBatchSessions={batch} onManageSessionInWorkspace={async () => {}} />)
  fireEvent.click(screen.getByRole("button", { name: "批次管理會話" }))
  fireEvent.click(await screen.findByRole("checkbox", { name: "選取 First" }))
  fireEvent.click(screen.getByRole("checkbox", { name: "選取 Busy" }))
  fireEvent.click(screen.getByRole("button", { name: "封存所選會話" }))
  expect(batch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "確認批次封存" }))
  await screen.findByText(/Live work prevents archive/)
  expect(batch).toHaveBeenCalledWith("source", { action: "archive", sessionIds: ["moved", "blocked"] })
  expect((await screen.findByRole("checkbox", { name: "選取 First" }) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole("checkbox", { name: "選取 Busy" }) as HTMLInputElement).checked).toBe(true)
})

it("keeps defaults and remembered rules in settings and opens operational diagnostics from Tools", async () => {
  localStorage.setItem("ih:settings-section", "execution")
  const defaults = { sandboxMode: "read-only", approvalMode: "dangerous", autoCompaction: true }
  const bridge = bridgeFor(request => request.kind === "desktop/agent-settings/state" ? { saved: defaults, effective: defaults, restartRequired: false }
    : request.kind === "desktop/approval-rules/state" ? { rules: [], candidates: [] }
    : request.kind === "desktop/code-mode/state" ? { saved: { mode: "only" }, effective: "mixed" }
    : request.kind === "desktop/code-mode/configure" ? { saved: { mode: request.patch.mode }, effective: "mixed" }
    : request.kind === "desktop/environment/diagnostics" ? { live: false, executables: [], tools: [], roles: [] } : [])
  const view = render(<SettingsPane workspace={workspace} sessionId="moved" bridge={bridge} onClose={() => {}} capabilities={{ "desktop-agent-settings": ["1"], "desktop-code-mode-settings": ["1"], "desktop-environment-diagnostics": ["1"] }} />)
  const mode = await screen.findByRole("combobox", { name: "Code Mode" })
  await waitFor(() => expect((mode as HTMLSelectElement).value).toBe("only"))
  expect(screen.getByText("mixed")).toBeTruthy()
  fireEvent.change(mode, { target: { value: "off" } })
  await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/code-mode/configure", workspaceId: "source", sessionId: "moved", patch: { mode: "off" } }))
  expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/approval-rules/state", workspaceId: "source" })
  expect(bridge.request).not.toHaveBeenCalledWith({ kind: "desktop/environment/diagnostics", workspaceId: "source", sessionId: "moved", probe: false })
  view.unmount()
  render(<Workbench {...base(bridge)} capabilities={{ "desktop-environment-diagnostics": ["1"] }} />)
  fireEvent.click(screen.getByRole("button", { name: "工作台工具" }))
  fireEvent.click(screen.getByRole("button", { name: "工具與環境診斷" }))
  await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/environment/diagnostics", workspaceId: "source", sessionId: "moved", probe: false }))
  fireEvent.click(screen.getByRole("button", { name: "檢測執行檔版本" }))
  await waitFor(() => expect(bridge.request).toHaveBeenCalledWith({ kind: "desktop/environment/diagnostics", workspaceId: "source", sessionId: "moved", probe: true }))
})
