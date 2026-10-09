// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { TaskPane } from "../src/renderer/session/TaskPane.tsx"

afterEach(cleanup)
const state = { todos: [{ content: "Owned item", status: "pending" as const }], todosRevision: 1, goal: null }
it("retains a Todo edit and its original revision after pane unmount, without mixing scopes", () => {
  const props = { draftOwner: {}, workspaceId: "a", sessionId: "s", workStateEnabled: true, workState: state, onWriteTodos: vi.fn() }
  const view = render(<TaskPane {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "編輯待辦 Owned item" }))
  fireEvent.change(screen.getByRole("textbox", { name: "待辦內容" }), { target: { value: "My Todo draft" } })
  view.unmount()
  const other = render(<TaskPane {...props} workspaceId="b" />)
  expect(screen.queryByRole("textbox", { name: "待辦內容" })).toBeNull()
  other.unmount()
  render(<TaskPane {...props} workState={{ ...state, todosRevision: 2 }} />)
  expect((screen.getByRole("textbox", { name: "待辦內容" }) as HTMLInputElement).value).toBe("My Todo draft")
  expect((screen.getByRole("button", { name: "儲存待辦" }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole("alert").textContent).toContain("待辦清單已變更")
  expect(props.onWriteTodos).not.toHaveBeenCalled()
})
it("shares a pending save and its rejected draft across unmount, blocking duplicate writes", async () => {
  let fail!: (reason: Error) => void
  const pending = new Promise<void>((_, reject) => { fail = reject })
  const write = vi.fn(() => pending)
  const props = { draftOwner: {}, workspaceId: "a", sessionId: "s", workStateEnabled: true, workState: state, onWriteTodos: write }
  const view = render(<TaskPane {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "新增待辦" }))
  fireEvent.change(screen.getByRole("textbox", { name: "待辦內容" }), { target: { value: "Pending Todo" } })
  fireEvent.click(screen.getByRole("button", { name: "儲存待辦" }))
  view.unmount(); render(<TaskPane {...props} />)
  const save = screen.getByRole("button", { name: "儲存中…" }) as HTMLButtonElement
  expect(save.disabled).toBe(true); fireEvent.click(save); expect(write).toHaveBeenCalledTimes(1)
  await act(async () => fail(new Error("Owned write rejected")))
  expect((await screen.findByRole("alert")).textContent).toContain("Owned write rejected")
  expect((screen.getByRole("textbox", { name: "待辦內容" }) as HTMLInputElement).value).toBe("Pending Todo")
})
it("keeps a manual page when an unchanged snapshot is read again", () => {
  const props = { workStateEnabled: true, workState: { ...state, todos: Array.from({ length: 10 }, (_, n) => ({ content: `Item ${n}`, status: "pending" as const })) }, onWriteTodos: vi.fn() }
  const view = render(<TaskPane {...props} />)
  fireEvent.click(screen.getByRole("button", { name: "下一頁" }))
  expect(screen.getByText("Item 9")).toBeTruthy()
  view.rerender(<TaskPane {...props} workState={{ ...props.workState, todos: props.workState.todos.map(item => ({ ...item })) }} />)
  expect(screen.getByText("Item 9")).toBeTruthy()
  view.rerender(<TaskPane {...props} workState={undefined} />)
  view.rerender(<TaskPane {...props} workState={{ ...props.workState, todos: props.workState.todos.map(item => ({ ...item })) }} />)
  expect(screen.getByText("Item 9")).toBeTruthy()
})
it("does not cancel or submit a Todo draft when an IME closes its composition", () => {
  const write = vi.fn()
  render(<TaskPane workStateEnabled workState={state} onWriteTodos={write} />)
  fireEvent.click(screen.getByRole("button", { name: "新增待辦" }))
  const field = screen.getByRole("textbox", { name: "待辦內容" })
  fireEvent.change(field, { target: { value: "Composing draft" } })
  fireEvent.compositionStart(field); fireEvent.keyDown(field, { key: "Escape", isComposing: true })
  fireEvent.compositionEnd(field); fireEvent.keyDown(field, { key: "Escape" })
  expect(screen.getByRole("textbox", { name: "待辦內容" })).toBe(field)
  expect(write).not.toHaveBeenCalled()
})
