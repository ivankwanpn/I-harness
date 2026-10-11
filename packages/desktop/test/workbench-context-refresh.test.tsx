// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import type { DesktopBridge } from "../src/shared/bridge.ts"

afterEach(() => { cleanup(); useUiStore.setState({ surface: "conversation", reviewOpen: false, sidebarCollapsed: false }) })

it("refreshes the visible context percentage when the selected model changes without a bridge event", async () => {
  let contextWindow = 20000
  const request = vi.fn(async (input: { kind: string }) => input.kind === "session/context"
    ? { kind: "ready", estimatedTokens: 2000, contextWindow } : undefined)
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  const workspace = { id: "context-workspace", path: "D:/context-fixture", label: "Fixture" }
  const viewFor = (modelId: string) => <Workbench bridge={bridge} workspaces={[workspace]} projects={[]}
    selectedWorkspaceId={workspace.id} selectedSessionId="context-session" capabilities={{ "session-context": ["1"] }}
    onSelectWorkspace={() => {}} onSelectSession={() => {}}
    conversation={{ rows: [], canSend: false, running: false, pending: [],
      modelState: { status: "ready", providerId: "fixture", modelId, label: "Preview Model" },
      onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }} />
  const view = render(viewFor("small-window"))
  await waitFor(() => expect(screen.getByRole("button", { name: "上下文容量" }).textContent).toContain("10.0%"))
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
