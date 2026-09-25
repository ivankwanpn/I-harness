// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createElement } from "react"
import { cleanup, render } from "@testing-library/react"
import type { HistoryRange } from "@i-harness/sdk"
import { Timeline } from "../src/renderer/session/Timeline.tsx"
import { projectTimeline, type TimelineRow } from "../src/renderer/session/project.ts"

const VIEWPORT_HEIGHT = 768
const ROW_ESTIMATE = 56
const OVERSCAN = 8
const BOUND = Math.ceil(VIEWPORT_HEIGHT / ROW_ESTIMATE) + 2 * OVERSCAN + 5

const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")
const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")

beforeAll(() => {
  // react-virtual sizes itself from offsetHeight/offsetWidth, which jsdom keeps
  // at 0 for every element; give the scroller a viewport and the rows a height.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList?.contains("timeline")) return VIEWPORT_HEIGHT
      if (this.classList?.contains("timeline-row")) return ROW_ESTIMATE
      return 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains("timeline") ? 900 : 800
    },
  })
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterAll(() => {
  if (originalHeight === undefined) delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight
  else Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalHeight)
  if (originalWidth === undefined) delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth
  else Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalWidth)
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver
})

afterAll(cleanup)

function generated(count: number, tag = "a"): TimelineRow[] {
  const events: HistoryRange["events"] = []
  for (let index = 0; index < count; index += 1) {
    events.push(index % 2 === 0
      ? { type: "user/message", text: `${tag} user ${index}`, seq: index }
      : { type: "assistant/message", text: `${tag} assistant ${index}`, seq: index })
  }
  return projectTimeline(events)
}

describe("long history stays bounded", () => {
  it("mounts only a viewport-sized window of a 10,000-event timeline", () => {
    const rows = generated(10_000)
    const view = render(createElement(Timeline, { rows }))

    const mounted = view.container.querySelectorAll(".timeline-row")
    expect(mounted.length).toBeGreaterThan(0)
    expect(mounted.length).toBeLessThanOrEqual(BOUND)
  })

  it("stays bounded while switching selected sessions repeatedly", () => {
    const first = generated(10_000, "first")
    const second = generated(8_000, "second")
    const view = render(createElement(Timeline, { rows: first }))

    for (let round = 0; round < 6; round += 1) {
      view.rerender(createElement(Timeline, { rows: round % 2 === 0 ? second : first }))
      const mounted = view.container.querySelectorAll(".timeline-row").length
      expect(mounted).toBeGreaterThan(0)
      expect(mounted).toBeLessThanOrEqual(BOUND)
    }
  })
})
