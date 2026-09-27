// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
const viewport = vi.hoisted(() => ({ visible: true, scroll: vi.fn() }))
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: (options: { count: number }) => ({ getTotalSize: () => 200, getVirtualItems: () => viewport.visible ? Array.from({ length: options.count }, (_, index) => ({ index, start: index * 56 })) : [], measureElement: () => {}, scrollToIndex: viewport.scroll }) }))
import { Timeline } from "../src/renderer/session/Timeline.tsx"
import { projectTimeline } from "../src/renderer/session/project.ts"
afterEach(() => { cleanup(); viewport.visible = true; viewport.scroll.mockClear(); vi.useRealTimers() })

it("does not jump to the end when the reader opens tool details", () => {
  vi.useFakeTimers()
  render(<Timeline rows={[{ id: "r", kind: "tool", name: "read", output: "details" }]} />)
  act(() => vi.runOnlyPendingTimers())
  viewport.scroll.mockClear()
  fireEvent.click(screen.getByRole("button", { name: "工具詳情 read" }))
  act(() => vi.runOnlyPendingTimers())
  expect(viewport.scroll).not.toHaveBeenCalled()
})

it("collapses intermediate work while keeping the final reply visible", () => {
  const rows = projectTimeline([{ type: "turn/start", seq: 0 }, { type: "user/message", text: "Task", seq: 1 }, { type: "tool/call", callId: "r", name: "read", args: { path: "a.md" }, seq: 2 }, { type: "assistant/message", text: "Final reply", seq: 3 }, { type: "turn/end", seq: 4 }])
  render(<Timeline rows={rows} />)
  expect(screen.queryByRole("button", { name: "工具詳情 read" })).toBeNull()
  expect(screen.getByRole("button", { name: "工作過程" }).getAttribute("aria-expanded")).toBe("false")
  fireEvent.click(screen.getByRole("button", { name: "工作過程" }))
  expect(screen.getByRole("button", { name: "工具詳情 read" })).toBeTruthy()
  expect(screen.getByText("Final reply")).toBeTruthy()
  expect(screen.getByText("Task")).toBeTruthy()
})

it("keeps inner and outer disclosure choices across growth and virtual unmount", () => {
  const a = { id: "a", kind: "tool" as const, name: "read", args: { path: "a.txt" }, output: "first contents" }
  const b = { ...a, id: "b", name: "list_dir", output: "directory listing" }
  const view = render(<Timeline rows={[a, b]} />)
  expect(screen.queryByRole("button", { name: "工具詳情 read" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "查閱 2" }))
  fireEvent.click(screen.getByRole("button", { name: "工具詳情 read" }))
  expect(screen.getByText("first contents")).toBeTruthy()
  view.rerender(<Timeline rows={[a, b, { ...b, id: "c" }]} />)
  expect(screen.getByText("first contents")).toBeTruthy()
  viewport.visible = false
  view.rerender(<Timeline rows={[a, b]} />)
  expect(screen.queryByText("first contents")).toBeNull()
  viewport.visible = true
  view.rerender(<Timeline rows={[a, b]} />)
  expect(screen.getByText("first contents")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "查閱 2" }))
  expect(screen.queryByText("first contents")).toBeNull()
})

it("returns to the inspected tool's page after virtual unmount", () => {
  const rows = Array.from({ length: 51 }, (_, index) => ({ id: String(index), kind: "tool" as const, name: "read", output: `contents-${index}` }))
  const view = render(<Timeline rows={rows} />)
  fireEvent.click(screen.getByRole("button", { name: "查閱 51" }))
  fireEvent.click(screen.getByRole("button", { name: "下一頁" }))
  fireEvent.click(screen.getByRole("button", { name: "工具詳情 read" }))
  expect(screen.getByText("contents-50")).toBeTruthy()
  viewport.visible = false; view.rerender(<Timeline rows={[...rows]} />)
  viewport.visible = true; view.rerender(<Timeline rows={[...rows]} />)
  expect(screen.getByText("contents-50")).toBeTruthy()
})
