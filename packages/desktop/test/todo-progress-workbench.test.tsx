// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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

it("keeps one progress summary as transcript and work-state snapshots update", () => {
  const base = { bridge, workspaces: [workspace], selectedWorkspaceId: workspace.id, selectedSessionId: "todo-session", capabilities: { "desktop-work-state": ["1"] }, onSelectWorkspace: () => {}, onSelectSession: () => {} }
  const conversation = { ...callbacks, rows: [{ id: "reply", kind: "message" as const, role: "assistant" as const, text: "Existing reply" }], canSend: false, running: false, pending: [], workState: initial }
  const view = render(<Workbench {...base} conversation={conversation} />)
  for (let revision = 5; revision < 9; revision++) {
    view.rerender(<Workbench {...base} conversation={{ ...conversation, workState: { ...initial, todosRevision: revision, todos: initial.todos!.map((todo) => ({ ...todo })) } }} />)
    expect(screen.getAllByRole("button", { name: /待辦進度/ })).toHaveLength(1)
  }
})

it("opens Work from the conversation and removes the summary after accepting the final Todo update", async () => {
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
  fireEvent.click(screen.getByRole("button", { name: /待辦進度.*已完成 1\/2.*Working/ }))
  expect(screen.getByRole("tab", { name: "工作" }).getAttribute("aria-selected")).toBe("true")
  const add = screen.getByRole("button", { name: "新增待辦" })
  await waitFor(() => expect(document.activeElement).toBe(add))
  fireEvent.change(screen.getByRole("combobox", { name: "Working 的狀態" }), { target: { value: "completed" } })
  await waitFor(() => expect(screen.queryByRole("button", { name: /待辦進度/ })).toBeNull())
  expect((screen.getByRole("combobox", { name: "Working 的狀態" }) as HTMLSelectElement).value).toBe("completed")
  expect(writes).toEqual([{ expectedRevision: 4, items: [{ content: "Done", status: "completed" }, { content: "Working", status: "completed" }] }])
})

it("hides stale progress when the authoritative work-state read fails", () => {
  render(<Workbench bridge={bridge} workspaces={[workspace]} selectedWorkspaceId={workspace.id} selectedSessionId="todo-session" capabilities={{ "desktop-work-state": ["1"] }} onSelectWorkspace={() => {}} onSelectSession={() => {}}
    conversation={{ ...callbacks, rows: [], canSend: false, running: false, pending: [], workState: initial, workStateError: "read unavailable" }} />)
  expect(screen.queryByRole("button", { name: /待辦進度/ })).toBeNull()
  expect(screen.getByRole("alert").textContent).toContain("read unavailable")
})

it("uses the next conversation's snapshot in the summary", () => {
  const base = { bridge, workspaces: [workspace], selectedWorkspaceId: workspace.id, capabilities: { "desktop-work-state": ["1"] }, onSelectWorkspace: () => {}, onSelectSession: () => {} }
  const conversation = { ...callbacks, rows: [], canSend: false, running: false, pending: [], workState: initial }
  const view = render(<Workbench {...base} selectedSessionId="first" conversation={conversation} />)
  view.rerender(<Workbench {...base} selectedSessionId="second" conversation={{ ...conversation, workState: { todos: [{ content: "Second conversation item", status: "pending" }], todosRevision: 0, goal: null } }} />)
  expect(screen.getByRole("button", { name: /待辦進度.*已完成 0\/1.*Second conversation item/ })).toBeTruthy()
  expect(screen.queryByRole("button", { name: /待辦進度.*Working/ })).toBeNull()
  view.rerender(<Workbench {...base} capabilities={{}} selectedSessionId="second" conversation={conversation} />)
  expect(screen.queryByRole("button", { name: /待辦進度/ })).toBeNull()
})
