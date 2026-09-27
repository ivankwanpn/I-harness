// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { TaskPane } from "../src/renderer/session/TaskPane.tsx"

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
  expect(screen.queryByText("Item 1")).toBeNull()
  expect(screen.getByText("已完成 12/24")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "下一頁" }))
  expect(screen.getByText("Item 24")).toBeTruthy()
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
