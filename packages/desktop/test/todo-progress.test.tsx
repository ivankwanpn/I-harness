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

  it("keeps all seven completed CJK and tool-path items in the authoritative snapshot", () => {
    const completed = [
      "環境盤點：系統/工具/CLI ✅",
      "檢查命令工具（exec_command/shell/powershell/背景程序）",
      "檢查檔案工具（read/write/edit/apply_patch/view_image/list_directory）",
      "檢查搜尋工具 🔎（skill/tool/memory/session）",
      "檢查子代理/團隊/待辦/目標/排程",
      "確認 D:/workspace/packages/desktop/src/renderer/session/TodoProgress.tsx",
      "確認 very_long_unbroken_ASCII_tool_name_without_spaces",
    ].map((content) => ({ content, status: "completed" as const }))
    render(<TodoProgress todos={completed} onOpenTasks={() => {}} />)
    expect(screen.getByLabelText("已完成 7/7").textContent).toBe("7/7")
    expect(screen.getAllByRole("listitem")).toHaveLength(7)
    for (const item of completed) expect(screen.getByText(item.content).closest("s")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "下一頁" })).toBeNull()
  })

  it("keeps every page and the existing editor reachable for more than fifty items", () => {
    const open = vi.fn()
    const long = Array.from({ length: 57 }, (_, index) => ({
      content: `工作 ${index + 1} 📂 read/write/apply_patch/確認結果`,
      status: index < 53 ? "completed" as const : index === 53 ? "in_progress" as const : "pending" as const,
    }))
    const view = render(<TodoProgress todos={long} onOpenTasks={open} />)
    const card = within(screen.getByRole("region", { name: "待辦進度" }))
    expect(card.getByText(long[53]!.content)).toBeTruthy()
    expect(card.getAllByRole("listitem")).toHaveLength(8)
    for (let page = 0; page < 6; page++) fireEvent.click(card.getByRole("button", { name: "上一頁" }))
    expect(card.getByText(long[0]!.content)).toBeTruthy()
    expect(card.getByRole("button", { name: "上一頁" }).hasAttribute("disabled")).toBe(true)
    for (let page = 0; page < 7; page++) fireEvent.click(card.getByRole("button", { name: "下一頁" }))
    expect(card.getByText(long[56]!.content)).toBeTruthy()
    expect(card.getAllByRole("listitem")).toHaveLength(1)
    expect(card.getByRole("button", { name: "下一頁" }).hasAttribute("disabled")).toBe(true)
    expect(card.getByLabelText("已完成 53/57").textContent).toBe("53/57")
    fireEvent.click(card.getByRole("button", { name: "開啟待辦編輯" }))
    expect(open).toHaveBeenCalledTimes(1)
    view.rerender(<TodoProgress todos={long.map((item, index) => ({ ...item, status: index === 0 ? "in_progress" : "pending" }))} onOpenTasks={open} />)
    expect(card.getByText(long[0]!.content)).toBeTruthy()
    expect(card.getByLabelText("已完成 0/57").textContent).toBe("0/57")
  })
})
