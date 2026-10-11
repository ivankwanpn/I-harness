// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const virtual = vi.hoisted(() => ({ scrollToIndex: vi.fn(), scrollToOffset: vi.fn(), getTotalSize: () => 2000, getVirtualItems: () => [], measureElement: vi.fn(), scrollToFn: undefined as undefined | ((offset: number, options: { adjustments?: number }, instance: { scrollElement: HTMLElement }) => void) }))
vi.mock("@tanstack/react-virtual", () => ({
  elementScroll: (offset: number, options: { adjustments?: number }, instance: { scrollElement: HTMLElement }) => {
    const element = instance.scrollElement
    element.scrollTop = Math.max(0, Math.min(offset + (options.adjustments ?? 0), element.scrollHeight - element.clientHeight))
  },
  useVirtualizer: (options: { scrollToFn?: typeof virtual.scrollToFn }) => { virtual.scrollToFn = options.scrollToFn; return virtual },
}))
import { Timeline } from "../src/renderer/session/Timeline.tsx"
beforeEach(() => {
  virtual.scrollToOffset.mockImplementation((offset: number, options?: { align?: string }) => {
    const element = document.querySelector<HTMLElement>('[data-testid="timeline"]')
    if (element) {
      const target = options?.align === "end" ? offset - element.clientHeight : offset
      if (virtual.scrollToFn) virtual.scrollToFn(target, {}, { scrollElement: element })
      else element.scrollTop = Math.max(0, Math.min(target, element.scrollHeight - element.clientHeight))
    }
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); virtual.scrollToIndex.mockClear(); virtual.scrollToOffset.mockClear(); vi.unstubAllGlobals() })
it("follows new content only while the reader stays at the bottom", () => {
  vi.useFakeTimers()
  const rows = [{ id: "a", kind: "message" as const, role: "assistant" as const, text: "First" }]
  const view = render(<Timeline rows={rows} />)
  act(() => vi.runOnlyPendingTimers())
  expect(virtual.scrollToOffset).toHaveBeenLastCalledWith(0)
  const scroller = screen.getByTestId("timeline")
  Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  scroller.scrollTop = 200
  fireEvent.wheel(scroller, { deltaY: -300 })
  fireEvent.scroll(scroller)
  virtual.scrollToOffset.mockClear()
  view.rerender(<Timeline rows={[...rows, { ...rows[0]!, id: "b", text: "Next" }]} />)
  act(() => vi.runOnlyPendingTimers())
  expect(virtual.scrollToOffset).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "回到最新內容" }))
  act(() => vi.runOnlyPendingTimers())
  expect(scroller.scrollTop).toBe(1600)
})

it("keeps the physical bottom when the current assistant message grows before its layout scroll event", () => {
  vi.useFakeTimers()
  const rows = [{ id: "stream", kind: "message" as const, role: "assistant" as const, text: "First" }]
  const view = render(<Timeline rows={rows} running />)
  const element = screen.getByTestId("timeline")
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  element.scrollTop = 1600
  act(() => vi.runOnlyPendingTimers())
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 3200 })
  fireEvent.scroll(element)
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "The same message now spans several screens" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(2800)
  expect(screen.queryByRole("button", { name: "回到最新內容" })).toBeNull()
})

it("pauses on an upward wheel gesture and keeps the reader's position through later text growth", () => {
  vi.useFakeTimers()
  const rows = [{ id: "stream", kind: "message" as const, role: "assistant" as const, text: "First" }]
  const view = render(<Timeline rows={rows} running />)
  const element = screen.getByTestId("timeline")
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  element.scrollTop = 1600
  act(() => vi.runOnlyPendingTimers())
  fireEvent.wheel(element, { deltaY: -300 })
  element.scrollTop = 1300
  fireEvent.scroll(element)
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 3200 })
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "Additional streamed paragraphs" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(1300)
  fireEvent.click(screen.getByRole("button", { name: "回到最新內容" }))
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(2800)
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 4000 })
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "Latest content keeps growing" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(3600)
})

it("follows delayed layout and viewport changes without a new message event", () => {
  vi.useFakeTimers()
  let resized: (() => void) | undefined
  const disconnected = vi.fn()
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback }
    observe() {}
    disconnect = disconnected
  })
  const view = render(<Timeline rows={[{ id: "long", kind: "message", role: "assistant", text: "Long response" }]} />)
  const element = screen.getByTestId("timeline")
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: 3200 }, clientHeight: { configurable: true, value: 400 } })
  element.scrollTop = 2800
  act(() => vi.runOnlyPendingTimers())
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 300 })
  act(() => { resized?.(); vi.runOnlyPendingTimers() })
  expect(element.scrollTop).toBe(2900)
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 3800 })
  act(() => { resized?.(); vi.runOnlyPendingTimers() })
  expect(element.scrollTop).toBe(3500)
  view.unmount()
  expect(disconnected).toHaveBeenCalledOnce()
})

it("lets Shift+Space page upward during a reply instead of immediately pulling the reader back", () => {
  vi.useFakeTimers()
  const rows = [{ id: "stream", kind: "message" as const, role: "assistant" as const, text: "First" }]
  const view = render(<Timeline rows={rows} running />)
  const element = screen.getByTestId("timeline")
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  element.scrollTop = 1600
  act(() => vi.runOnlyPendingTimers())
  element.focus()
  fireEvent.keyDown(element, { key: " ", code: "Space", shiftKey: true })
  element.scrollTop = 1200
  fireEvent.scroll(element)
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 3200 })
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "More streaming text" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(1200)
})

it("preserves scrollbar reading intent through delayed layout growth", () => {
  vi.useFakeTimers()
  const rows = [{ id: "stream", kind: "message" as const, role: "assistant" as const, text: "First" }]
  const view = render(<Timeline rows={rows} running />)
  const element = screen.getByTestId("timeline")
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  element.scrollTop = 1600
  act(() => vi.runOnlyPendingTimers())
  fireEvent.pointerDown(element)
  element.scrollTop = 1000
  fireEvent.scroll(element)
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 3200 })
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "More streaming text" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(1000)
})

it("does not mistake an above-viewport layout compensation for reader intent while the scrollbar is held", () => {
  vi.useFakeTimers()
  const rows = [{ id: "stream", kind: "message" as const, role: "assistant" as const, text: "First" }]
  const view = render(<Timeline rows={rows} running />)
  const element = screen.getByTestId("timeline")
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  element.scrollTop = 1600
  act(() => vi.runOnlyPendingTimers())
  fireEvent.pointerDown(element)
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 2600 })
  virtual.scrollToFn?.(2200, {}, { scrollElement: element })
  fireEvent.scroll(element)
  expect(screen.queryByRole("button", { name: "回到最新內容" })).not.toBeNull()
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 3200 })
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "Later streaming continues" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(2200)
  fireEvent.pointerUp(window)
  expect(screen.queryByRole("button", { name: "回到最新內容" })).not.toBeNull()
})

it("resumes following when the reader drags the scrollbar back to the physical bottom", () => {
  vi.useFakeTimers()
  const rows = [{ id: "stream", kind: "message" as const, role: "assistant" as const, text: "First" }]
  const view = render(<Timeline rows={rows} running />)
  const element = screen.getByTestId("timeline")
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  element.scrollTop = 1600
  act(() => vi.runOnlyPendingTimers())
  fireEvent.pointerDown(element)
  element.scrollTop = 1000
  fireEvent.scroll(element)
  fireEvent.pointerUp(window)
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 3200 })
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "More streaming text" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(1000)
  fireEvent.pointerDown(element)
  element.scrollTop = 2800
  fireEvent.scroll(element)
  fireEvent.pointerUp(window)
  act(() => vi.runOnlyPendingTimers())
  expect(screen.queryByRole("button", { name: "回到最新內容" })).toBeNull()
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 3800 })
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "Stream continues after manual return" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(3400)
})

it("resumes following after a downward wheel gesture returns to the physical bottom", () => {
  vi.useFakeTimers()
  const rows = [{ id: "stream", kind: "message" as const, role: "assistant" as const, text: "First" }]
  const view = render(<Timeline rows={rows} running />)
  const element = screen.getByTestId("timeline")
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  element.scrollTop = 1600
  act(() => vi.runOnlyPendingTimers())
  fireEvent.wheel(element, { deltaY: -300 })
  element.scrollTop = 1300
  fireEvent.scroll(element)
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 3200 })
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "More streaming text" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  fireEvent.wheel(element, { deltaY: 1800 })
  element.scrollTop = 2800
  fireEvent.scroll(element)
  expect(screen.queryByRole("button", { name: "回到最新內容" })).toBeNull()
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 3800 })
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "Stream continues after wheel return" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(3400)
})

it("resumes as a downward scrollbar drag reaches the bottom and pauses again if that same drag moves upward", () => {
  vi.useFakeTimers()
  vi.stubGlobal("PointerEvent", MouseEvent)
  const rows = [{ id: "stream", kind: "message" as const, role: "assistant" as const, text: "First" }]
  const view = render(<Timeline rows={rows} running />)
  const element = screen.getByTestId("timeline")
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  element.scrollTop = 1600
  act(() => vi.runOnlyPendingTimers())
  fireEvent.pointerDown(element, { clientY: 100 })
  element.scrollTop = 1000
  fireEvent.scroll(element)
  element.scrollTop = 1600
  fireEvent.scroll(element)
  expect(screen.queryByRole("button", { name: "回到最新內容" })).toBeNull()
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 2600 })
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "Stream continues at the bottom during the drag" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(2200)
  element.scrollTop = 1500
  fireEvent.scroll(element)
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 3200 })
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "Reader moved upward again" }]} running />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(1500)
})

it.each(["pointercancel", "blur"])("does not retain downward drag intent after %s cancels the gesture", kind => {
  vi.useFakeTimers()
  vi.stubGlobal("PointerEvent", MouseEvent)
  render(<Timeline rows={[{ id: "stream", kind: "message", role: "assistant", text: "First" }]} running />)
  const element = screen.getByTestId("timeline")
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  element.scrollTop = 1600
  act(() => vi.runOnlyPendingTimers())
  fireEvent.pointerDown(element, { clientY: 100 })
  element.scrollTop = 1200
  fireEvent.scroll(element)
  element.scrollTop = 1400
  fireEvent.scroll(element)
  fireEvent(window, new Event(kind))
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 2600 })
  element.scrollTop = 2200
  fireEvent.scroll(element)
  expect(screen.queryByRole("button", { name: "回到最新內容" })).not.toBeNull()
})

it("does not follow a historical page or leave a frame running after unmount", () => {
  vi.useFakeTimers()
  const rows = [{ id: "historic", kind: "message" as const, role: "assistant" as const, text: "History" }]
  const view = render(<Timeline rows={rows} historical />)
  const element = screen.getByTestId("timeline")
  Object.defineProperties(element, { scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 400 } })
  element.scrollTop = 500
  view.rerender(<Timeline rows={[{ ...rows[0]!, text: "Updated history page" }]} historical />)
  act(() => vi.runOnlyPendingTimers())
  expect(element.scrollTop).toBe(500)
  expect(virtual.scrollToOffset).not.toHaveBeenCalled()
  view.unmount()
  const pending = render(<Timeline rows={rows} />)
  pending.unmount()
  act(() => vi.runOnlyPendingTimers())
  expect(virtual.scrollToOffset).not.toHaveBeenCalled()
})
