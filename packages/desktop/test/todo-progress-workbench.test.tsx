// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { Workbench } from "../src/renderer/shell/Workbench.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import type { DesktopBridge } from "../src/shared/bridge.ts"
import type { DesktopTodoWriteInput, DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"

afterEach(() => { cleanup(); useUiStore.setState({ reviewOpen: false, surface: "conversation" }) })
const workspace = { id: "todo-ws", path: "D:/todo-workspace", label: "Todo workspace" }
const initial: DesktopWorkStateView = { todos: [{ content: "Done", status: "completed" }, { content: "Working", status: "in_progress" }], todosRevision: 4, goal: null }
const bridge: DesktopBridge = { request: vi.fn(async () => undefined), onEvent: () => () => {} }
const callbacks = { onPrompt: async () => {}, onCancel() {}, onCancelTask() {}, onCancelQueue() {}, onReply: async () => {} }

it("keeps one progress card as transcript and work-state snapshots update", () => {
  const base = { bridge, workspaces: [workspace], selectedWorkspaceId: workspace.id, selectedSessionId: "todo-session", capabilities: { "desktop-work-state": ["1"] }, onSelectWorkspace: () => {}, onSelectSession: () => {} }
  const conversation = { ...callbacks, rows: [{ id: "reply", kind: "message" as const, role: "assistant" as const, text: "Existing reply" }], canSend: false, running: false, pending: [], workState: initial }
  const view = render(<Workbench {...base} conversation={conversation} />)
  for (let revision = 5; revision < 9; revision++) {
    view.rerender(<Workbench {...base} conversation={{ ...conversation, workState: { ...initial, todosRevision: revision, todos: initial.todos!.map((todo) => ({ ...todo })) } }} />)
    expect(screen.getAllByRole("region", { name: "待辦進度" })).toHaveLength(1)
  }
})

it("opens the existing Todo CRUD pane from the conversation and reflects its accepted revision", async () => {
  const writes: DesktopTodoWriteInput[] = []
  function Harness() {
    const [state, setState] = useState(initial)
    return <Workbench bridge={bridge} workspaces={[workspace]} selectedWorkspaceId={workspace.id} selectedSessionId="todo-session" capabilities={{ "desktop-work-state": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}}
      conversation={{ ...callbacks, rows: [], canSend: false, running: false, pending: [], queue: [], tasks: [], workState: state, onWriteTodos: async (input) => {
        writes.push(input)
        setState({ ...state, todos: input.items, todosRevision: input.expectedRevision + 1 })
      } }} />
  }
  render(<Harness />)
  const progress = within(screen.getByRole("region", { name: "待辦進度" }))
  expect(progress.getByLabelText("已完成 1/2")).toBeTruthy()
  fireEvent.click(progress.getByRole("button", { name: "開啟待辦編輯" }))
  expect(screen.getByRole("tab", { name: "任務" }).getAttribute("aria-selected")).toBe("true")
  const add = screen.getByRole("button", { name: "新增待辦" })
  await waitFor(() => expect(document.activeElement).toBe(add))
  fireEvent.change(screen.getByRole("combobox", { name: "Working 的狀態" }), { target: { value: "completed" } })
  await waitFor(() => expect(progress.getByLabelText("已完成 2/2")).toBeTruthy())
  expect(writes).toEqual([{ expectedRevision: 4, items: [{ content: "Done", status: "completed" }, { content: "Working", status: "completed" }] }])
})

it("hides stale progress when the authoritative work-state read fails", () => {
  render(<Workbench bridge={bridge} workspaces={[workspace]} selectedWorkspaceId={workspace.id} selectedSessionId="todo-session" capabilities={{ "desktop-work-state": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}}
    conversation={{ ...callbacks, rows: [], canSend: false, running: false, pending: [], workState: initial, workStateError: "read unavailable" }} />)
  expect(screen.queryByRole("region", { name: "待辦進度" })).toBeNull()
  expect(screen.getByRole("alert").textContent).toContain("read unavailable")
})

it("uses the next conversation's snapshot and resets disclosure without retaining the old list", () => {
  const base = { bridge, workspaces: [workspace], selectedWorkspaceId: workspace.id, capabilities: { "desktop-work-state": ["1"] }, onSelectWorkspace: () => {}, onSelectSession: () => {} }
  const conversation = { ...callbacks, rows: [], canSend: false, running: false, pending: [], workState: initial }
  const view = render(<Workbench {...base} selectedSessionId="first" conversation={conversation} />)
  fireEvent.click(screen.getByRole("button", { name: "收合待辦清單" }))
  view.rerender(<Workbench {...base} selectedSessionId="second" conversation={{ ...conversation, workState: { todos: [{ content: "Second conversation item", status: "pending" }], todosRevision: 0, goal: null } }} />)
  const progress = within(screen.getByRole("region", { name: "待辦進度" }))
  expect(progress.getByLabelText("已完成 0/1")).toBeTruthy()
  expect(progress.getByText("Second conversation item")).toBeTruthy()
  expect(progress.queryByText("Working")).toBeNull()
  expect(progress.getByRole("button", { name: "收合待辦清單" }).getAttribute("aria-expanded")).toBe("true")
  view.rerender(<Workbench {...base} capabilities={{}} selectedSessionId="second" conversation={conversation} />)
  expect(screen.queryByRole("region", { name: "待辦進度" })).toBeNull()
})
