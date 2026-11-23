// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { TodoProgress } from "../src/renderer/session/TodoProgress.tsx"

afterEach(cleanup)

it("shows the active item and completion count and opens the Work pane on request", () => {
  const openTasks = vi.fn()
  render(<TodoProgress todos={[
    { content: "Done", status: "completed" },
    { content: "Later", status: "pending" },
    { content: "Now", status: "in_progress" },
  ]} onOpenTasks={openTasks} />)
  const summary = screen.getByRole("button", { name: /待辦進度.*已完成 1\/3.*Now/ })
  expect(summary.textContent).toContain("1/3")
  expect(screen.queryByText("Later")).toBeNull()
  fireEvent.click(summary)
  expect(openTasks).toHaveBeenCalledOnce()
})

it("shows the first pending item when idle and clears the summary on completion", () => {
  const todos = [{ content: "First", status: "pending" }, { content: "Second", status: "pending" }] as const
  const view = render(<TodoProgress todos={[...todos]} onOpenTasks={() => {}} />)
  expect(screen.getByRole("button", { name: /待辦進度.*已完成 0\/2.*First/ })).toBeTruthy()
  view.rerender(<TodoProgress todos={todos.map(item => ({ ...item, status: "completed" }))} onOpenTasks={() => {}} />)
  expect(screen.queryByRole("button", { name: /待辦進度/ })).toBeNull()
})

it("hides a stale summary after a work-state error and restores it after recovery", () => {
  const props = { todos: [{ content: "Retry", status: "in_progress" as const }], onOpenTasks: () => {} }
  const view = render(<TodoProgress {...props} error="Snapshot unavailable" />)
  expect(screen.queryByRole("button", { name: /待辦進度/ })).toBeNull()
  view.rerender(<TodoProgress {...props} />)
  expect(screen.getByRole("button", { name: /待辦進度.*Retry/ })).toBeTruthy()
  view.rerender(<TodoProgress {...props} todos={null} />)
  expect(screen.queryByRole("button", { name: /待辦進度/ })).toBeNull()
})
