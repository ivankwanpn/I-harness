// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
const viewport = vi.hoisted(() => ({ visible: true }))
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: (options: { count: number }) => ({ getTotalSize: () => 200, getVirtualItems: () => viewport.visible ? Array.from({ length: options.count }, (_, index) => ({ index, start: index * 56 })) : [], measureElement: () => {}, scrollToIndex: () => {} }) }))
import { Timeline } from "../src/renderer/session/Timeline.tsx"
afterEach(() => { cleanup(); viewport.visible = true })

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
