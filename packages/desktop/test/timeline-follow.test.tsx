// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
const virtual = vi.hoisted(() => ({ scrollToIndex: vi.fn(), getTotalSize: () => 2000, getVirtualItems: () => [], measureElement: vi.fn() }))
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: () => virtual }))
import { Timeline } from "../src/renderer/session/Timeline.tsx"
afterEach(() => { cleanup(); vi.useRealTimers(); virtual.scrollToIndex.mockClear() })
it("follows new content only while the reader stays at the bottom", () => {
  vi.useFakeTimers()
  const rows = [{ id: "a", kind: "message" as const, role: "assistant" as const, text: "First" }]
  const view = render(<Timeline rows={rows} />)
  act(() => vi.runOnlyPendingTimers())
  expect(virtual.scrollToIndex).toHaveBeenLastCalledWith(0, { align: "end" })
  const scroller = screen.getByTestId("timeline")
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  scroller.scrollTop = 200
  fireEvent.scroll(scroller)
  virtual.scrollToIndex.mockClear()
  view.rerender(<Timeline rows={[...rows, { ...rows[0]!, id: "b", text: "Next" }]} />)
  act(() => vi.runOnlyPendingTimers())
  expect(virtual.scrollToIndex).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "回到最新內容" }))
  expect(virtual.scrollToIndex).toHaveBeenCalledWith(1, { align: "end" })
})
