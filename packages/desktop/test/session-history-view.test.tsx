// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SessionHistoryView } from "../src/renderer/session/SessionHistoryView.tsx"
import { applyHistory, emptyEventWindow, MAX_RETAINED_EVENTS } from "../src/renderer/session/event-window.ts"
import type { HistoryRange } from "@i-harness/sdk"
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("timeline") ? 768 : 56 })
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1024)
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100_000)
  HTMLElement.prototype.scrollTo = function (options) { if (typeof options === "object") { this.scrollTop = options.top ?? 0; queueMicrotask(() => this.dispatchEvent(new Event("scroll"))) } }
})
it("scrolls the actual virtual viewport to a target in the middle of a historic page", async () => {
  const events = Array.from({ length: 200 }, (_, index) => ({ type: "assistant/message" as const, seq: index + 300, text: index === 100 ? "middle history target" : `entry ${index}` }))
  const request = vi.fn(async () => ({ events, nextSeq: 500 }))
  render(<SessionHistoryView selection={{ workspaceId: "w", sessionId: "s", seq: 400 }} request={request} onLatest={() => {}} />)
  const text = await screen.findByText("middle history target")
  expect(text.closest('[data-search-target="true"]')).not.toBeNull()
  expect(screen.getByTestId("timeline").scrollTop).toBeGreaterThan(0)
  expect(document.querySelectorAll(".timeline-row").length).toBeLessThan(60)
})
it("expands a completed work stage and the exact grouped tool result selected by seq", async () => {
  const events: HistoryRange["events"] = [
    { type: "turn/start", seq: 0 }, { type: "user/message", seq: 1, text: "read files" },
    { type: "tool/call", callId: "a", name: "read", args: {}, seq: 2 }, { type: "tool/result", name: "read", callId: "a", output: "first result", seq: 3 },
    { type: "tool/call", callId: "b", name: "read", args: {}, seq: 4 }, { type: "tool/result", name: "read", callId: "b", output: "selected tool result", seq: 5 },
    { type: "assistant/message", seq: 6, text: "final" }, { type: "turn/end", seq: 7 },
  ]
  const request = vi.fn(async () => ({ events, nextSeq: 8 }))
  render(<SessionHistoryView selection={{ workspaceId: "w", sessionId: "s", seq: 5 }} request={request} onLatest={() => {}} />)
  const text = await screen.findByText("selected tool result")
  expect(text.closest('[data-search-target="true"]')).not.toBeNull()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it("shows and marks an old search target outside the retained live tail without changing unread cursor", async () => {
  const events = Array.from({ length: MAX_RETAINED_EVENTS + 1000 }, (_, seq) => ({ type: "assistant/message" as const, seq, text: seq === 4 ? "old search target" : `event ${seq}` }))
  const live = applyHistory(emptyEventWindow(), { events, nextSeq: events.length })
  expect(live.events.some(event => event.seq === 4)).toBe(false)
  const request = vi.fn(async ({ afterSeq, limit }) => ({ events: events.slice(afterSeq, afterSeq + limit), nextSeq: Math.min(afterSeq + limit, events.length) }))
  render(<SessionHistoryView selection={{ workspaceId: "w", sessionId: "s", seq: 4 }} request={request} onLatest={() => {}} />)
  const target = await screen.findByText("old search target")
  expect(target.closest('[data-search-target="true"]')).not.toBeNull()
  expect(request).toHaveBeenCalledWith({ kind: "session/history", workspaceId: "w", sessionId: "s", afterSeq: 0, limit: 200 })
  expect(live.cursor).toBe(events.length)
  fireEvent.click(screen.getByRole("button", { name: "載入較後內容" }))
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "session/history", workspaceId: "w", sessionId: "s", afterSeq: 200, limit: 200 }))
})
it("discards delayed old workspace history and keeps before paging distinct from next unread", async () => {
  let finish!: (page: HistoryRange) => void
  const request = vi.fn(({ workspaceId }) => workspaceId === "a" ? new Promise<HistoryRange>(resolve => { finish = resolve }) : Promise.resolve({ events: [{ type: "user/message" as const, seq: 300, text: "current target" }], nextSeq: 301 }))
  const view = render(<SessionHistoryView selection={{ workspaceId: "a", sessionId: "old", seq: 5 }} request={request} onLatest={() => {}} />)
  view.rerender(<SessionHistoryView selection={{ workspaceId: "b", sessionId: "new", seq: 300 }} request={request} onLatest={() => {}} />)
  await screen.findByText("current target")
  await act(async () => finish({ events: [{ type: "assistant/message", seq: 5, text: "stale history" }], nextSeq: 6 }))
  expect(screen.queryByText("stale history")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "載入較早內容" }))
  await waitFor(() => expect(request).toHaveBeenLastCalledWith({ kind: "session/history", workspaceId: "b", sessionId: "new", afterSeq: 0, limit: 200 }))
})

it("does not open a stale search hit after transport retirement and waits for an explicit retry", async () => {
  const pending = Promise.withResolvers<HistoryRange>()
  const request = vi.fn<() => Promise<HistoryRange>>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ events: [{ type: "assistant/message", seq: 3, text: "current search hit" }], nextSeq: 4 })
  let live = true
  const oldScope = { isCurrent: () => live }
  const newScope = { isCurrent: () => true }
  const selection = { workspaceId: "w", sessionId: "s", seq: 3 }
  const view = render(<SessionHistoryView selection={selection} request={request} readScope={oldScope} onLatest={() => {}} />)
  expect(screen.getByRole("status")).toBeTruthy()

  live = false
  view.rerender(<SessionHistoryView selection={selection} request={request} readScope={newScope} onLatest={() => {}} />)
  expect(screen.queryByRole("status")).toBeNull()
  await act(async () => { pending.resolve({ events: [{ type: "assistant/message", seq: 3, text: "retired search hit" }], nextSeq: 4 }) })
  expect(screen.queryByText("retired search hit")).toBeNull()
  expect(request).toHaveBeenCalledOnce()

  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  expect(await screen.findByText("current search hit")).toBeTruthy()
})

it("holds a settled search window and discards an earlier page on transport retirement", async () => {
  const pending = Promise.withResolvers<HistoryRange>()
  const request = vi.fn<() => Promise<HistoryRange>>()
    .mockResolvedValueOnce({ events: [{ type: "assistant/message", seq: 300, text: "settled search hit" }], nextSeq: 400 })
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ events: [{ type: "assistant/message", seq: 99, text: "fresh earlier page" }], nextSeq: 100 })
  let live = true
  const oldScope = { isCurrent: () => live }
  const newScope = { isCurrent: () => true }
  const selection = { workspaceId: "w", sessionId: "s", seq: 300 }
  const view = render(<SessionHistoryView selection={selection} request={request} readScope={oldScope} onLatest={() => {}} />)
  await screen.findByText("settled search hit")
  const earlier = () => screen.getByRole("button", { name: "載入較早內容" }) as HTMLButtonElement
  fireEvent.click(earlier())
  expect(earlier().disabled).toBe(true)

  live = false
  view.rerender(<SessionHistoryView selection={selection} request={request} readScope={newScope} onLatest={() => {}} />)
  expect(earlier().disabled).toBe(false)
  await act(async () => { pending.resolve({ events: [{ type: "assistant/message", seq: 99, text: "retired earlier page" }], nextSeq: 100 }) })
  expect(screen.getByText("settled search hit")).toBeTruthy()
  expect(earlier().disabled).toBe(false)
  expect(request).toHaveBeenCalledTimes(2)

  await act(async () => { fireEvent.click(earlier()) })
  expect(request).toHaveBeenLastCalledWith({ kind: "session/history", workspaceId: "w", sessionId: "s", afterSeq: 0, limit: 200 })
})
