// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { PaneTabs } from "../src/renderer/vendor/zcode/PaneTabs.tsx"
import { ReviewResizeHandle } from "../src/renderer/review/ReviewResizeHandle.tsx"
afterEach(cleanup)
it("moves tab selection and focus with arrow keys", () => {
  const select = vi.fn()
  render(<PaneTabs id="test" label="Review" items={[{ id: "changes", label: "Changes" }, { id: "tasks", label: "Tasks" }]} selected="changes" onSelect={select} />)
  fireEvent.keyDown(screen.getByRole("tab", { name: "Changes" }), { key: "ArrowRight" })
  expect(select).toHaveBeenCalledWith("tasks")
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Tasks" }))
})
it("resizes the work pane using the keyboard", () => {
  const resize = vi.fn()
  render(<ReviewResizeHandle width={360} onResize={resize} />)
  const handle = screen.getByRole("separator")
  fireEvent.keyDown(handle, { key: "ArrowLeft" })
  expect(resize).toHaveBeenLastCalledWith(380)
  fireEvent.keyDown(handle, { key: "Home" })
  expect(resize).toHaveBeenLastCalledWith(280)
})
