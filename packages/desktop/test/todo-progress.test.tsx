// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { TodoProgress } from "../src/renderer/session/TodoProgress.tsx"

afterEach(cleanup)
const todos = [
  { content: "Inspect source", status: "completed" as const },
  { content: "Build the UI", status: "in_progress" as const },
  { content: "Verify the result", status: "pending" as const },
]

describe("conversation Todo progress card", () => {
  it("counts the authoritative list and distinguishes completed, current and pending items", () => {
    render(<TodoProgress todos={todos} onOpenTasks={() => {}} />)
    expect(screen.getByLabelText("已完成 1/3").textContent).toBe("1/3")
    expect(screen.getByRole("listitem", { name: "Inspect source · 已完成" })).toBeTruthy()
    expect(screen.getByRole("listitem", { name: "Build the UI · 進行中" }).getAttribute("aria-current")).toBe("step")
    expect(screen.getByRole("listitem", { name: "Verify the result · 待開始" })).toBeTruthy()
    expect(screen.getByText("Inspect source").closest("s")).toBeTruthy()
  })

  it("collapses the list without changing counts and opens the existing editor through its action", () => {
    const open = vi.fn()
    render(<TodoProgress todos={todos} onOpenTasks={open} />)
    fireEvent.click(screen.getByRole("button", { name: "收合待辦清單" }))
    expect(screen.queryByRole("list")).toBeNull()
    expect(screen.getByLabelText("已完成 1/3")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "展開待辦清單" }))
    expect(screen.getByRole("list")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "開啟待辦編輯" }))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("updates completed counts from a new snapshot while preserving the collapsed choice", () => {
    const view = render(<TodoProgress todos={todos} onOpenTasks={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "收合待辦清單" }))
    view.rerender(<TodoProgress todos={todos.map((item) => ({ ...item, status: "completed" }))} onOpenTasks={() => {}} />)
    expect(screen.getByLabelText("已完成 3/3").textContent).toBe("3/3")
    expect(screen.getByRole("region", { name: "待辦進度" }).getAttribute("data-complete")).toBe("true")
    expect(screen.queryByRole("list")).toBeNull()
  })

  it("does not invent progress for unknown, absent, cleared or failed snapshots", () => {
    const view = render(<TodoProgress todos={undefined} onOpenTasks={() => {}} />)
    expect(screen.queryByRole("region")).toBeNull()
    view.rerender(<TodoProgress todos={null} onOpenTasks={() => {}} />)
    expect(screen.queryByRole("region")).toBeNull()
    view.rerender(<TodoProgress todos={[]} onOpenTasks={() => {}} />)
    expect(screen.queryByRole("region")).toBeNull()
    view.rerender(<TodoProgress todos={todos} error="read failed" onOpenTasks={() => {}} />)
    expect(screen.queryByRole("region")).toBeNull()
  })

  it("keeps a long list bounded and starts on the actual active item", () => {
    const long = Array.from({ length: 24 }, (_, index) => ({ content: `Item ${index + 1}`, status: index < 12 ? "completed" as const : index === 13 ? "in_progress" as const : "pending" as const }))
    render(<TodoProgress todos={long} onOpenTasks={() => {}} />)
    const card = within(screen.getByRole("region", { name: "待辦進度" }))
    expect(card.getByLabelText("已完成 12/24")).toBeTruthy()
    expect(card.getByText("Item 14")).toBeTruthy()
    expect(card.getAllByRole("listitem")).toHaveLength(8)
    fireEvent.click(card.getByRole("button", { name: "下一頁" }))
    expect(card.getByText("Item 24")).toBeTruthy()
    expect(card.queryByText("Item 14")).toBeNull()
  })
})
