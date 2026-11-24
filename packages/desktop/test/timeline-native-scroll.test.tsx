// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { Timeline } from "../src/renderer/session/Timeline.tsx"

afterEach(() => { cleanup(); vi.useRealTimers() })

it("honors the first upward gesture between landing at the physical bottom and the next native scroll event", () => {
  vi.useFakeTimers()
  const rows = Array.from({ length: 250 }, (_, index) => ({
    id: `reply-${index}`, kind: "message" as const, role: "assistant" as const, text: `Reply ${index}`,
  }))
  const earlier = vi.fn()
  const history = { loading: false, earlier }
  const view = render(<Timeline rows={rows} history={history} />)
  const scroller = screen.getByTestId("timeline")
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
    // Chromium scrolls the element before delivering its native scroll event.
    scrollTo: { configurable: true, value: ({ top }: ScrollToOptions) => { if (top !== undefined) scroller.scrollTop = top } },
  })
  scroller.scrollTop = 1599.5
  fireEvent.scroll(scroller)
  view.rerender(<Timeline rows={[...rows]} history={history} />)
  act(() => vi.advanceTimersToNextFrame())
  expect(scroller.scrollTop).toBe(1600)

  fireEvent.wheel(scroller, { deltaY: -100 })
  scroller.scrollTop = 0
  act(() => vi.advanceTimersToNextFrame())
  fireEvent.scroll(scroller)
  expect(scroller.scrollTop).toBe(0)
  expect(earlier).toHaveBeenCalledOnce()
})
