// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, it } from "vitest"
import { TaskPane } from "../src/renderer/session/TaskPane.tsx"
import type { DesktopTodoWriteInput, DesktopWorkStateView } from "@i-harness/desktop-gateway/src/work-state.ts"

afterEach(cleanup)

it("distinguishes loading, no Todo snapshot, and an explicitly empty list", () => {
  const view = render(<TaskPane workStateEnabled queue={[]} tasks={[]} />)
  expect(screen.getByText("正在載入待辦…")).toBeTruthy()
  view.rerender(<TaskPane workStateEnabled workState={{ todos: null, goal: null }} queue={[]} tasks={[]} />)
  expect(screen.getByText("尚未建立待辦清單")).toBeTruthy()
  view.rerender(<TaskPane workStateEnabled workState={{ todos: [], goal: null }} queue={[]} tasks={[]} />)
  expect(screen.getByText("待辦清單已清空")).toBeTruthy()
})

it("focuses the active Todo and pages through a long list without mounting every item", () => {
  const todos = Array.from({ length: 24 }, (_, index) => ({ content: `Item ${index + 1}`, status: index < 12 ? "completed" as const : index === 13 ? "in_progress" as const : "pending" as const }))
  render(<TaskPane workStateEnabled workState={{ todos, goal: null }} queue={[]} tasks={[]} />)
  expect(screen.getByText("Item 14")).toBeTruthy()
  expect(screen.getByRole("listitem", { name: "Item 14 · 進行中" })).toBeTruthy()
  expect(screen.queryByText("Item 1")).toBeNull()
  expect(screen.getByText("已完成 12/24")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "下一頁" }))
  expect(screen.getByText("Item 24")).toBeTruthy()
  expect(screen.getByRole("listitem", { name: "Item 24 · 待開始" })).toBeTruthy()
  expect(screen.queryByText("Item 14")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "上一頁" }))
  expect(screen.getByText("Item 14")).toBeTruthy()
})

it("keeps a failed work-state read visible instead of showing an empty list", () => {
  let retries = 0
  render(<TaskPane workStateEnabled workStateError="work state unavailable" onRetryWorkState={() => { retries += 1 }} queue={[]} tasks={[]} />)
  expect(screen.getByRole("alert").textContent).toContain("work state unavailable")
  expect(screen.queryByText("尚未建立待辦清單")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  expect(retries).toBe(1)
})

it("adds, edits, changes status, and deletes Todos using the latest displayed revision", async () => {
  const writes: DesktopTodoWriteInput[] = []
  function EditableTasks() {
    const [state, setState] = useState<DesktopWorkStateView>({ todos: null, todosRevision: 0, goal: null })
    return <TaskPane workStateEnabled workState={state} queue={[]} tasks={[]} onWriteTodos={async (input) => {
      writes.push(input)
      setState({ ...state, todos: input.items, todosRevision: input.expectedRevision + 1 })
    }} />
  }
  render(<EditableTasks />)
  fireEvent.click(screen.getByRole("button", { name: "新增待辦" }))
  fireEvent.change(screen.getByRole("textbox", { name: "待辦內容" }), { target: { value: "  Review UI  " } })
  fireEvent.click(screen.getByRole("button", { name: "儲存待辦" }))
  await waitFor(() => expect(screen.getByRole("listitem", { name: "Review UI · 待開始" })).toBeTruthy())
  expect(writes[0]).toEqual({ expectedRevision: 0, items: [{ content: "Review UI", status: "pending" }] })

  fireEvent.click(screen.getByRole("button", { name: "編輯待辦 Review UI" }))
  fireEvent.change(screen.getByRole("textbox", { name: "待辦內容" }), { target: { value: "Review accessibility" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存待辦" }))
  await waitFor(() => expect(screen.getByText("Review accessibility")).toBeTruthy())
  expect(writes[1]).toEqual({ expectedRevision: 1, items: [{ content: "Review accessibility", status: "pending" }] })

  fireEvent.change(screen.getByRole("combobox", { name: "Review accessibility 的狀態" }), { target: { value: "completed" } })
  await waitFor(() => expect(screen.getByRole("listitem", { name: "Review accessibility · 已完成" })).toBeTruthy())
  expect(writes[2]).toEqual({ expectedRevision: 2, items: [{ content: "Review accessibility", status: "completed" }] })

  fireEvent.click(screen.getByRole("button", { name: "刪除待辦 Review accessibility" }))
  await waitFor(() => expect(screen.getByText("待辦清單已清空")).toBeTruthy())
  expect(writes[3]).toEqual({ expectedRevision: 3, items: [] })
})

it("moves the active Todo when a human starts a different item", async () => {
  const writes: DesktopTodoWriteInput[] = []
  render(<TaskPane workStateEnabled workState={{ todos: [{ content: "First", status: "in_progress" }, { content: "Second", status: "pending" }], todosRevision: 4, goal: null }} onWriteTodos={async (input) => { writes.push(input) }} />)
  fireEvent.change(screen.getByRole("combobox", { name: "Second 的狀態" }), { target: { value: "in_progress" } })
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toEqual({ expectedRevision: 4, items: [{ content: "First", status: "pending" }, { content: "Second", status: "in_progress" }] })
})

it("retains an unsaved draft when saving fails and prevents duplicate submissions", async () => {
  let rejectWrite!: (error: Error) => void
  let submissions = 0
  render(<TaskPane workStateEnabled workState={{ todos: [], todosRevision: 0, goal: null }} onWriteTodos={() => {
    submissions += 1
    return new Promise<void>((_resolve, reject) => { rejectWrite = reject })
  }} />)
  fireEvent.click(screen.getByRole("button", { name: "新增待辦" }))
  fireEvent.change(screen.getByRole("textbox", { name: "待辦內容" }), { target: { value: "Keep this draft" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存待辦" }))
  expect((screen.getByRole("button", { name: "儲存中…" }) as HTMLButtonElement).disabled).toBe(true)
  expect(submissions).toBe(1)
  rejectWrite(new Error("disk unavailable"))
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("disk unavailable"))
  expect((screen.getByRole("textbox", { name: "待辦內容" }) as HTMLInputElement).value).toBe("Keep this draft")
})

it("keeps an older draft visible but blocks it when a model snapshot arrives", () => {
  let submissions = 0
  const view = render(<TaskPane workStateEnabled workState={{ todos: [{ content: "Original", status: "pending" }], todosRevision: 1, goal: null }} onWriteTodos={async () => { submissions += 1 }} />)
  fireEvent.click(screen.getByRole("button", { name: "編輯待辦 Original" }))
  fireEvent.change(screen.getByRole("textbox", { name: "待辦內容" }), { target: { value: "My draft" } })
  view.rerender(<TaskPane workStateEnabled workState={{ todos: [{ content: "New model snapshot", status: "in_progress" }], todosRevision: 2, goal: null }} onWriteTodos={async () => { submissions += 1 }} />)
  expect(screen.getByText("New model snapshot")).toBeTruthy()
  expect((screen.getByRole("textbox", { name: "待辦內容" }) as HTMLInputElement).value).toBe("My draft")
  expect(screen.getByRole("alert").textContent).toContain("待辦清單已變更")
  fireEvent.click(screen.getByRole("button", { name: "儲存待辦" }))
  expect(submissions).toBe(0)
  fireEvent.click(screen.getByRole("button", { name: "取消編輯" }))
  expect(screen.queryByRole("textbox", { name: "待辦內容" })).toBeNull()
})
