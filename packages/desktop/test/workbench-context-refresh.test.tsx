// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import type { DesktopBridge } from "../src/shared/bridge.ts"

afterEach(() => { cleanup(); useUiStore.setState({ surface: "conversation", reviewOpen: false, sidebarCollapsed: false }) })

it("shares one session reading across the composer, right sidebar and full context page, preserving the draft on return", async () => {
  const pending = Promise.withResolvers<unknown>()
  const request = vi.fn(async (input: { kind: string; sessionId?: string }) => input.kind === "session/context"
    ? input.sessionId === "second" ? pending.promise : { kind: "ready", estimatedTokens: 4321, contextWindow: 128000 }
    : undefined)
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  const workspace = { id: "w", path: "D:/ctx-fixture", label: "Fixture" }
  const renderSession = (sessionId: string) => <Workbench bridge={bridge} workspaces={[workspace]} projects={[]}
    selectedWorkspaceId={workspace.id} selectedSessionId={sessionId} capabilities={{ "session-context": ["1"] }}
    dashboard={{ sessions: [{ id: "first", title: "First conversation", turnCount: 3, live: true }, { id: "second", title: "Second conversation", live: false }] }}
    onSelectWorkspace={() => {}} onSelectSession={() => {}}
    conversation={{ rows: [], canSend: true, running: false, pending: [],
      onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />
  const view = render(renderSession("first"))
  const draft = screen.getByPlaceholderText("輸入提示…")
  fireEvent.change(draft, { target: { value: "keep this draft" } })
  await waitFor(() => expect(screen.getByRole("button", { name: "上下文容量" }).textContent).toContain("3.4%"))
  fireEvent.click(screen.getByRole("button", { name: "上下文容量" }))
  fireEvent.click(within(screen.getByRole("dialog", { name: "上下文容量" })).getByRole("button", { name: "在側邊欄查看上下文" }))
  const summary = screen.getByRole("region", { name: "上下文摘要" })
  expect(within(summary).getByText(/4,321 \/ 128,000/)).toBeTruthy()
  expect(screen.getByRole("tab", { name: "上下文" }).getAttribute("aria-selected")).toBe("true")
  fireEvent.click(within(summary).getByRole("button", { name: "查看完整上下文" }))
  const page = screen.getByRole("region", { name: "上下文詳情" })
  expect(within(page).getByRole("heading", { name: "上下文詳情" })).toBe(document.activeElement)
  expect(within(page).getByText("First conversation")).toBeTruthy()
  expect(within(page).getByText(/4,321 \/ 128,000/)).toBeTruthy()
  expect(screen.queryByRole("region", { name: "會話" })).toBeNull()
  fireEvent.click(within(page).getByRole("button", { name: "返回會話" }))
  expect(screen.getByPlaceholderText("輸入提示…")).toBe(draft)
  expect((draft as HTMLTextAreaElement).value).toBe("keep this draft")
  expect(request.mock.calls.filter(([input]) => input.kind === "session/context")).toHaveLength(1)

  fireEvent.click(screen.getByRole("button", { name: "查看完整上下文" }))
  view.rerender(renderSession("second"))
  const other = screen.getByRole("region", { name: "上下文詳情" })
  expect(within(other).getByText("Second conversation")).toBeTruthy()
  expect(within(other).queryByText(/4,321 \/ 128,000/)).toBeNull()
  await act(async () => { pending.resolve({ kind: "ready", estimatedTokens: 500, contextWindow: 10000 }); await pending.promise })
  expect(within(other).getByText(/500 \/ 10,000/)).toBeTruthy()
  expect(request.mock.calls.filter(([input]) => input.kind === "session/context")).toHaveLength(2)
})

it("refreshes the visible context percentage when the selected model changes without a bridge event", async () => {
  let contextWindow = 20000
  const request = vi.fn(async (input: { kind: string }) => input.kind === "session/context"
    ? { kind: "ready", estimatedTokens: 2000, contextWindow } : undefined)
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  const workspace = { id: "context-workspace", path: "D:/context-fixture", label: "Fixture" }
  const viewFor = (modelId: string, running = false) => <Workbench bridge={bridge} workspaces={[workspace]} projects={[]}
    selectedWorkspaceId={workspace.id} selectedSessionId="context-session" capabilities={{ "session-context": ["1"] }}
    onSelectWorkspace={() => {}} onSelectSession={() => {}}
    conversation={{ rows: [], canSend: false, running, pending: [], operation: { kind: "prompt", busy: running },
      modelState: { status: "ready", providerId: "fixture", modelId, label: "Preview Model" },
      onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />
  const view = render(viewFor("small-window"))
  await waitFor(() => expect(screen.getByRole("button", { name: "上下文容量" }).textContent).toContain("10.0%"))
  vi.useFakeTimers()
  try {
    view.rerender(viewFor("small-window", true))
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(screen.getByRole("button", { name: "上下文容量" }).textContent).toContain("10.0%")
    expect(request.mock.calls.filter(([input]) => input.kind === "session/context")).toHaveLength(1)
  } finally { vi.useRealTimers() }
  contextWindow = 100000
  view.rerender(viewFor("large-window"))
  // The meter intentionally bounds background reads to once per second.
  await waitFor(() => expect(screen.getByRole("button", { name: "上下文容量" }).textContent).toContain("2.0%"), { timeout: 2500 })
  expect(request.mock.calls.filter(([input]) => input.kind === "session/context")).toHaveLength(2)
})

it("refreshes capacity after successfully reapplying the same model without an operation projection", async () => {
  let contextWindow = 20000
  const onSetModel = vi.fn(async () => { contextWindow = 100000 })
  const request = vi.fn(async (input: { kind: string }) => input.kind === "session/context"
    ? { kind: "ready", estimatedTokens: 2000, contextWindow }
    : input.kind === "desktop/provider/directory" ? [{ id: "fixture", displayName: "Fixture", configured: true, models: [{ id: "same-model" }] }] : undefined)
  const workspace = { id: "reapply-workspace", path: "D:/reapply-fixture", label: "Fixture" }
  render(<Workbench bridge={{ request, onEvent: () => () => {} }} workspaces={[workspace]} projects={[]}
    selectedWorkspaceId={workspace.id} selectedSessionId="reapply-session" capabilities={{ "session-context": ["1"] }}
    onSelectWorkspace={() => {}} onSelectSession={() => {}}
    conversation={{ rows: [], canSend: false, running: false, pending: [],
      modelState: { status: "ready", providerId: "fixture", modelId: "same-model", label: "Preview Model" }, onSetModel,
      onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />)
  await waitFor(() => expect(screen.getByRole("button", { name: "上下文容量" }).textContent).toContain("10.0%"))
  fireEvent.click(screen.getByRole("button", { name: "same-model" }))
  fireEvent.click(await within(screen.getByRole("dialog", { name: "選擇模型" })).findByRole("button", { name: "same-model" }))
  await waitFor(() => expect(onSetModel).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(screen.getByRole("button", { name: "上下文容量" }).textContent).toContain("2.0%"), { timeout: 2500 })
})

it("does not refresh a new conversation when an old model apply completes late", async () => {
  const pending = Promise.withResolvers<void>()
  const request = vi.fn(async (input: { kind: string; sessionId?: string }) => input.kind === "session/context"
    ? { kind: "ready", estimatedTokens: input.sessionId === "first" ? 1000 : 2000, contextWindow: 10000 }
    : input.kind === "desktop/provider/directory" ? [{ id: "fixture", displayName: "Fixture", configured: true, models: [{ id: "same-model" }] }] : undefined)
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  const workspace = { id: "late-workspace", path: "D:/late-fixture", label: "Fixture" }
  const viewFor = (sessionId: string) => <Workbench bridge={bridge} workspaces={[workspace]} projects={[]}
    selectedWorkspaceId={workspace.id} selectedSessionId={sessionId} capabilities={{ "session-context": ["1"] }}
    onSelectWorkspace={() => {}} onSelectSession={() => {}}
    conversation={{ rows: [], canSend: false, running: false, pending: [],
      modelState: { status: "ready", providerId: "fixture", modelId: "same-model", label: "Preview Model" }, onSetModel: () => pending.promise,
      onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />
  const view = render(viewFor("first"))
  await waitFor(() => expect(screen.getByRole("button", { name: "上下文容量" }).textContent).toContain("10.0%"))
  fireEvent.click(screen.getByRole("button", { name: "same-model" }))
  fireEvent.click(await within(screen.getByRole("dialog", { name: "選擇模型" })).findByRole("button", { name: "same-model" }))
  view.rerender(viewFor("second"))
  await waitFor(() => expect(screen.getByRole("button", { name: "上下文容量" }).textContent).toContain("20.0%"))
  await act(async () => { pending.resolve(); await pending.promise })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1150)) })
  expect(request.mock.calls.filter(([input]) => input.kind === "session/context" && input.sessionId === "second")).toHaveLength(1)
})
