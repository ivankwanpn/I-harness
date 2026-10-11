// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopEvent } from "../src/shared/bridge.ts"
import { ContextUsage } from "../src/renderer/session/ContextUsage.tsx"

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function connection(request: DesktopBridge["request"]) {
  const listeners = new Set<(event: DesktopEvent) => void>()
  const bridge: DesktopBridge = {
    request,
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { bridge, listeners, emit(event: DesktopEvent) { for (const listener of listeners) listener(event) } }
}

function event(record: { type: string; [key: string]: unknown }, workspaceId = "w", sessionId = "s"): DesktopEvent {
  return { kind: "sdk/notification", workspaceId, method: "session/event", params: { sessionId, event: record } }
}

const ready = (estimatedTokens: number, contextWindow = 100) => ({ kind: "ready", estimatedTokens, contextWindow })
const trigger = () => screen.getByRole("button", { name: "上下文容量" })
const flush = () => act(async () => {})
const advance = (milliseconds: number) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })

afterEach(() => { cleanup(); vi.useRealTimers() })

it("loads a scoped estimate on mount and keeps its percentage accessible before opening details", async () => {
  const pending = deferred()
  const request = vi.fn(() => pending.promise)
  const { bridge } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  expect(trigger().textContent).toBe("—")
  await flush()
  expect(request).toHaveBeenCalledExactlyOnceWith({ kind: "session/context", workspaceId: "w", sessionId: "s" })
  await act(async () => { pending.resolve(ready(8100, 100000)) })
  expect(trigger().textContent).toBe("8.1%")
  expect(screen.getByRole("button", { name: "上下文容量", description: "8.1%" })).toBe(trigger())
  expect(trigger().getAttribute("title")).toContain("8.1%")
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("makes one initial read when StrictMode replays mount effects", async () => {
  const pending = deferred()
  const request = vi.fn(() => pending.promise)
  const { bridge, listeners } = connection(request)
  render(<StrictMode><ContextUsage bridge={bridge} workspaceId="w" sessionId="s" /></StrictMode>)
  await flush()
  expect(request).toHaveBeenCalledTimes(1)
  expect(listeners.size).toBe(1)
  await act(async () => { pending.resolve(ready(8)) })
  expect(trigger().textContent).toBe("8.0%")
})

it("keeps estimated tokens, role breakdown, and the estimate disclaimer in the popup", async () => {
  const request = vi.fn().mockResolvedValue({ ...ready(49000, 1000000), roleTokens: { user: 10000, assistant: 9000, tool: 30000 } })
  const { bridge } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  expect(trigger().textContent).toBe("4.9%")
  fireEvent.click(trigger())
  const dialog = screen.getByRole("dialog", { name: "上下文容量" })
  expect(within(dialog).getByText("49,000 / 1,000,000 (4.9%)")).toBeTruthy()
  expect(within(dialog).getByText("10,000")).toBeTruthy()
  expect(within(dialog).getByText("9,000")).toBeTruthy()
  expect(within(dialog).getByText("30,000")).toBeTruthy()
  expect(within(dialog).getByText("根據目前可見的模型訊息估算；不是供應商帳單或快取命中率。")).toBeTruthy()
  expect(within(dialog).getByRole("progressbar", { name: "估算已用 Token" }).getAttribute("value")).toBe("49000")
  expect(request).toHaveBeenCalledTimes(1)
})

it("keeps the context total visible when a running gateway has no role breakdown", async () => {
  const { bridge } = connection(vi.fn().mockResolvedValue(ready(12)))
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  fireEvent.click(trigger())
  expect(screen.getByText("12 / 100 (12.0%)")).toBeTruthy()
  expect(screen.queryByText("使用者訊息")).toBeNull()
})

it.each([
  ["unavailable", { kind: "unavailable", reason: "No model context window" }],
  ["unknown", { kind: "unknown" }],
  ["missing", undefined],
  ["null", null],
  ["zero capacity", ready(0, 0)],
  ["negative capacity", ready(0, -100)],
  ["negative usage", ready(-1)],
  ["nonfinite usage", ready(Number.NaN)],
  ["nonfinite capacity", ready(10, Number.POSITIVE_INFINITY)],
  ["missing usage", { kind: "ready", contextWindow: 100 }],
])("shows an em dash for %s rather than reporting zero usage", async (_name, response) => {
  const { bridge } = connection(vi.fn().mockResolvedValue(response))
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  expect(trigger().textContent).toBe("—")
  fireEvent.click(trigger())
  expect(screen.queryByRole("progressbar")).toBeNull()
  expect(screen.queryByText("讀取上下文容量中…")).toBeNull()
  expect(screen.queryByText(/0\.0%/)).toBeNull()
})

it.each([
  [0, 100, "0.0%"],
  [1, 100000, "<0.1%"],
  [Number.MIN_VALUE, 100000, "<0.1%"],
  [120, 100, "120.0%"],
])("formats a known estimate of %s / %s as %s", async (used, capacity, reading) => {
  const { bridge } = connection(vi.fn().mockResolvedValue(ready(used, capacity)))
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  expect(trigger().textContent).toBe(reading)
})

it("keeps a failed estimate explicit and retries from the popup", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("Meter unavailable")).mockResolvedValueOnce(ready(23))
  const { bridge } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  expect(trigger().textContent).toBe("—")
  fireEvent.click(trigger())
  expect(screen.getByRole("alert").textContent).toBe("Meter unavailable")
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await flush()
  expect(trigger().textContent).toBe("23.0%")
  expect(screen.queryByRole("alert")).toBeNull()
  expect(request).toHaveBeenCalledTimes(2)
})

it("preserves the reason and allows retry when the estimate is unavailable", async () => {
  const request = vi.fn().mockResolvedValueOnce({ kind: "unavailable", reason: "No configured model" }).mockResolvedValueOnce(ready(10))
  const { bridge } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  fireEvent.click(trigger())
  expect(screen.getByText("No configured model")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await flush()
  expect(trigger().textContent).toBe("10.0%")
})

it("keeps an empty failure retryable rather than leaving the popup loading forever", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("")).mockResolvedValueOnce(ready(23))
  const { bridge } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  fireEvent.click(trigger())
  expect(screen.getByRole("alert").textContent).toBe("無法取得上下文容量。")
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await flush()
  expect(trigger().textContent).toBe("23.0%")
})

it("clears a displayed estimate when a subsequent read fails", async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValueOnce(ready(50)).mockRejectedValueOnce(new Error("Meter unavailable"))
  const { bridge, emit } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  expect(trigger().textContent).toBe("50.0%")
  act(() => { emit(event({ type: "assistant/message", text: "completed" })) })
  await advance(2000)
  expect(trigger().textContent).toBe("—")
  fireEvent.click(trigger())
  expect(screen.getByRole("alert").textContent).toBe("Meter unavailable")
})

it("refreshes durable session activity in a coalesced burst and ignores chunks or other scopes", async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValueOnce(ready(10)).mockResolvedValue(ready(20))
  const { bridge, emit } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  await advance(10000)
  expect(request).toHaveBeenCalledTimes(1)
  act(() => {
    emit(event({ type: "user/message", text: "unrelated" }, "other", "s"))
    emit(event({ type: "user/message", text: "unrelated" }, "w", "other"))
    for (let index = 0; index < 100; index++) {
      emit(event({ type: "assistant/chunk", text: "chunk" }))
      emit(event({ type: "reasoning/chunk", text: "chunk", streamId: "r", offset: index, atSeq: 0 }))
    }
  })
  await advance(2000)
  expect(request).toHaveBeenCalledTimes(1)
  act(() => {
    emit(event({ type: "user/message", text: "added" }))
    emit(event({ type: "tool/call", callId: "call", name: "read", args: {} }))
    emit(event({ type: "tool/result", callId: "call", name: "read", output: "result" }))
    emit(event({ type: "assistant/message", text: "completed" }))
    emit({ kind: "sdk/notification", workspaceId: "w", method: "session/status", params: { sessionId: "s", status: "completed" } })
  })
  expect(request).toHaveBeenCalledTimes(1)
  await advance(2000)
  expect(request).toHaveBeenCalledTimes(2)
  expect(trigger().textContent).toBe("20.0%")
  await advance(10000)
  expect(request).toHaveBeenCalledTimes(2)
})

it("coalesces activity received before the mount read into that initial read", async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValue(ready(20))
  const { bridge, emit } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  act(() => { emit(event({ type: "user/message", text: "added" })) })
  await flush()
  expect(trigger().textContent).toBe("20.0%")
  await advance(2000)
  expect(request).toHaveBeenCalledTimes(1)
})

it.each([
  { type: "compaction/end" },
  { type: "compaction/summary", text: "summary", shadowedSeqs: [0] },
  { type: "compaction/reset", removedSeqs: [0] },
  { type: "compaction/prune", version: 1, pruned: [] },
  { type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: 0, mode: "conversation", fileOps: [] },
])("refreshes changed model context after $type", async (record) => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValueOnce(ready(90)).mockResolvedValueOnce(ready(8))
  const { bridge, emit } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  act(() => { emit(event(record)) })
  await advance(2000)
  expect(trigger().textContent).toBe("8.0%")
  expect(request).toHaveBeenCalledTimes(2)
})

it("bounds requests to one in flight and one follow-up when events arrive during a read", async () => {
  vi.useFakeTimers()
  const first = deferred()
  const second = deferred()
  const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const { bridge, emit } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  fireEvent.click(trigger())
  act(() => { for (let index = 0; index < 100; index++) emit(event({ type: "assistant/message", text: "message" })) })
  await advance(2000)
  expect(request).toHaveBeenCalledTimes(1)
  await act(async () => { first.resolve(ready(10)) })
  await advance(2000)
  expect(request).toHaveBeenCalledTimes(2)
  expect(trigger().textContent).toBe("10.0%")
  await act(async () => { second.resolve(ready(20)) })
  expect(trigger().textContent).toBe("20.0%")
  await advance(10000)
  expect(request).toHaveBeenCalledTimes(2)
})

it.each(["workspace", "session", "bridge"])("ignores a late estimate after the %s scope changes", async (scope) => {
  const first = deferred()
  const second = deferred()
  const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const original = connection(request)
  const replacement = scope === "bridge" ? connection(request) : original
  const { rerender } = render(<ContextUsage bridge={original.bridge} workspaceId="w" sessionId="s" />)
  await flush()
  const workspaceId = scope === "workspace" ? "other" : "w"
  const sessionId = scope === "session" ? "other" : "s"
  rerender(<ContextUsage bridge={replacement.bridge} workspaceId={workspaceId} sessionId={sessionId} />)
  await act(async () => { first.resolve(ready(91)) })
  expect(trigger().textContent).toBe("—")
  await act(async () => { second.resolve(ready(22)) })
  expect(trigger().textContent).toBe("22.0%")
  expect(request).toHaveBeenNthCalledWith(2, { kind: "session/context", workspaceId, sessionId })
})

it("ignores a late failure from the previous session", async () => {
  const pending = deferred()
  const request = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ready(22))
  const { bridge } = connection(request)
  const { rerender } = render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  rerender(<ContextUsage bridge={bridge} workspaceId="w" sessionId="next" />)
  await flush()
  await act(async () => { pending.reject(new Error("Old session unavailable")) })
  expect(trigger().textContent).toBe("22.0%")
  fireEvent.click(trigger())
  expect(screen.queryByRole("alert")).toBeNull()
})

it("clears the previous session's visible value while the next estimate loads", async () => {
  const pending = deferred()
  const request = vi.fn().mockResolvedValueOnce(ready(91)).mockReturnValueOnce(pending.promise)
  const { bridge } = connection(request)
  const { rerender } = render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  expect(trigger().textContent).toBe("91.0%")
  rerender(<ContextUsage bridge={bridge} workspaceId="w" sessionId="next" />)
  expect(trigger().textContent).toBe("—")
  await act(async () => { pending.resolve(ready(22)) })
  expect(trigger().textContent).toBe("22.0%")
})

it("coalesces model refresh keys and rejects a read from the old model", async () => {
  vi.useFakeTimers()
  const first = deferred()
  const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ready(25))
  const { bridge } = connection(request)
  const { rerender } = render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" refreshKey="model-a" />)
  await flush()
  rerender(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" refreshKey="model-b" />)
  rerender(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" refreshKey="model-c" />)
  await advance(2000)
  expect(request).toHaveBeenCalledTimes(1)
  await act(async () => { first.resolve(ready(91)) })
  expect(trigger().textContent).toBe("—")
  await advance(2000)
  expect(trigger().textContent).toBe("25.0%")
  expect(request).toHaveBeenCalledTimes(2)
  rerender(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" refreshKey="model-c" />)
  await advance(10000)
  expect(request).toHaveBeenCalledTimes(2)
})

it("invalidates pending estimates when the workspace disconnects", async () => {
  const pending = deferred()
  const request = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ready(22))
  const { bridge, emit } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  act(() => { emit({ kind: "sdk/disconnected", workspaceId: "w", message: "SDK disconnected" }) })
  await act(async () => { pending.resolve(ready(91)) })
  expect(trigger().textContent).toBe("—")
  fireEvent.click(trigger())
  expect(screen.getByRole("alert").textContent).toBe("SDK disconnected")
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await flush()
  expect(trigger().textContent).toBe("22.0%")
})

it("preserves a disconnect before the initial mount read starts", async () => {
  const request = vi.fn().mockResolvedValue(ready(22))
  const { bridge, emit } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  act(() => { emit({ kind: "sdk/disconnected", workspaceId: "w", message: "SDK disconnected" }) })
  await flush()
  expect(request).not.toHaveBeenCalled()
  expect(trigger().textContent).toBe("—")
  fireEvent.click(trigger())
  expect(screen.getByRole("alert").textContent).toBe("SDK disconnected")
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await flush()
  expect(trigger().textContent).toBe("22.0%")
})

it("keeps a disconnected scope offline across refresh keys and session events until retry", async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValueOnce(ready(10)).mockResolvedValueOnce(ready(22)).mockResolvedValue(ready(33))
  const { bridge, emit } = connection(request)
  const { rerender } = render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" refreshKey="busy" />)
  await flush()
  expect(trigger().textContent).toBe("10.0%")
  act(() => { emit({ kind: "sdk/disconnected", workspaceId: "w", message: "Gateway exited" }) })
  rerender(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" refreshKey="idle" />)
  act(() => {
    emit(event({ type: "assistant/message", text: "last buffered message" }))
    emit({ kind: "sdk/notification", workspaceId: "w", method: "session/status", params: { sessionId: "s", status: "failed" } })
  })
  await advance(10000)
  expect(request).toHaveBeenCalledTimes(1)
  expect(trigger().textContent).toBe("—")
  fireEvent.click(trigger())
  expect(screen.getByRole("alert").textContent).toBe("Gateway exited")
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await flush()
  expect(request).toHaveBeenCalledTimes(2)
  expect(trigger().textContent).toBe("22.0%")
  expect(screen.queryByRole("alert")).toBeNull()
  act(() => { emit(event({ type: "assistant/message", text: "completed after retry" })) })
  await advance(2000)
  expect(request).toHaveBeenCalledTimes(3)
  expect(trigger().textContent).toBe("33.0%")
})

it("keeps explicit retry bounded while an invalidated disconnected read is still pending", async () => {
  vi.useFakeTimers()
  const pending = deferred()
  const request = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ready(22))
  const { bridge, emit } = connection(request)
  const { rerender } = render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" refreshKey="busy" />)
  await flush()
  act(() => { emit({ kind: "sdk/disconnected", workspaceId: "w", message: "Gateway exited" }) })
  rerender(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" refreshKey="idle" />)
  await advance(2000)
  expect(request).toHaveBeenCalledTimes(1)
  fireEvent.click(trigger())
  expect(screen.getByRole("alert").textContent).toBe("Gateway exited")
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await flush()
  expect(request).toHaveBeenCalledTimes(1)
  await act(async () => { pending.resolve(ready(91)) })
  expect(request).toHaveBeenCalledTimes(2)
  expect(trigger().textContent).toBe("22.0%")
  await advance(10000)
  expect(request).toHaveBeenCalledTimes(2)
})

it("removes its event listener and cancels scheduled reads on teardown", async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValue(ready(10))
  const { bridge, emit, listeners } = connection(request)
  const { unmount } = render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  act(() => { emit(event({ type: "user/message", text: "added" })) })
  unmount()
  await advance(10000)
  expect(listeners.size).toBe(0)
  expect(request).toHaveBeenCalledTimes(1)
})

it.each(["click", "keyboard"])("moves focus into details on %s activation and returns it on Escape", async (activation) => {
  const { bridge } = connection(vi.fn().mockResolvedValue(ready(12)))
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  const button = trigger()
  button.focus()
  fireEvent.click(button, { detail: activation === "keyboard" ? 0 : 1 })
  const dialog = screen.getByRole("dialog", { name: "上下文容量" })
  expect(document.activeElement).toBe(dialog)
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(button)
})

it("opens hover details without stealing editor focus and closes after mouse departure", async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValue(ready(12))
  const { bridge } = connection(request)
  render(<><textarea aria-label="Editor" /><ContextUsage bridge={bridge} workspaceId="w" sessionId="s" /></>)
  await flush()
  const editor = screen.getByRole("textbox", { name: "Editor" })
  editor.focus()
  fireEvent.mouseEnter(trigger())
  expect(screen.getByRole("dialog", { name: "上下文容量" })).toBeTruthy()
  expect(trigger().getAttribute("title")).toBeNull()
  expect(screen.getByText("12 / 100 (12.0%)")).toBeTruthy()
  expect(document.activeElement).toBe(editor)
  fireEvent.mouseLeave(trigger())
  await advance(200)
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(trigger().getAttribute("title")).toContain("12.0%")
  expect(document.activeElement).toBe(editor)
  expect(request).toHaveBeenCalledTimes(1)
})

it("supports pointer hover without changing keyboard focus", async () => {
  vi.useFakeTimers()
  const { bridge } = connection(vi.fn().mockResolvedValue(ready(12)))
  render(<><textarea aria-label="Editor" /><ContextUsage bridge={bridge} workspaceId="w" sessionId="s" /></>)
  await flush()
  const editor = screen.getByRole("textbox", { name: "Editor" })
  editor.focus()
  fireEvent.pointerEnter(trigger(), { pointerType: "mouse" })
  expect(screen.getByRole("dialog", { name: "上下文容量" })).toBeTruthy()
  expect(document.activeElement).toBe(editor)
  fireEvent.pointerLeave(trigger(), { pointerType: "mouse" })
  await advance(200)
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("allows crossing into the hover popup to cancel dismissal and use Retry", async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockRejectedValueOnce(new Error("Meter unavailable")).mockResolvedValueOnce(ready(22))
  const { bridge } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  fireEvent.mouseEnter(trigger())
  const dialog = screen.getByRole("dialog", { name: "上下文容量" })
  expect(screen.getByRole("alert").textContent).toBe("Meter unavailable")
  fireEvent.mouseLeave(trigger())
  await advance(50)
  expect(screen.getByRole("dialog")).toBe(dialog)
  fireEvent.mouseEnter(dialog)
  await advance(200)
  expect(screen.getByRole("dialog")).toBe(dialog)
  fireEvent.click(screen.getByRole("button", { name: "重試" }))
  await flush()
  expect(screen.getByText("22 / 100 (22.0%)")).toBeTruthy()
  expect(request).toHaveBeenCalledTimes(2)
  fireEvent.mouseLeave(dialog)
  await advance(200)
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("upgrades a hover preview on click and keeps explicit click toggling", async () => {
  const { bridge } = connection(vi.fn().mockResolvedValue(ready(12)))
  render(<><textarea aria-label="Editor" /><ContextUsage bridge={bridge} workspaceId="w" sessionId="s" /></>)
  await flush()
  screen.getByRole("textbox", { name: "Editor" }).focus()
  fireEvent.mouseEnter(trigger())
  const dialog = screen.getByRole("dialog", { name: "上下文容量" })
  fireEvent.click(trigger())
  expect(screen.getByRole("dialog")).toBe(dialog)
  expect(document.activeElement).toBe(dialog)
  fireEvent.click(trigger())
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(trigger())
})

it("dismisses a passive hover preview with Escape while preserving editor focus", async () => {
  const { bridge } = connection(vi.fn().mockResolvedValue(ready(12)))
  render(<><textarea aria-label="Editor" /><ContextUsage bridge={bridge} workspaceId="w" sessionId="s" /></>)
  await flush()
  const editor = screen.getByRole("textbox", { name: "Editor" })
  editor.focus()
  fireEvent.mouseEnter(trigger())
  expect(screen.getByRole("dialog")).toBeTruthy()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(editor)
})

it("does not request another estimate for repeated hover previews", async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValue(ready(12))
  const { bridge } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  for (let index = 0; index < 5; index++) {
    fireEvent.mouseEnter(trigger())
    expect(screen.getByRole("dialog")).toBeTruthy()
    fireEvent.mouseLeave(trigger())
    await advance(200)
    expect(screen.queryByRole("dialog")).toBeNull()
  }
  expect(request).toHaveBeenCalledTimes(1)
})

it.each(["workspace", "session", "bridge"])("resets hover details and old dismissal timers when the %s scope changes", async (scope) => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValue(ready(12))
  const original = connection(request)
  const replacement = scope === "bridge" ? connection(request) : original
  const { rerender } = render(<ContextUsage bridge={original.bridge} workspaceId="w" sessionId="s" />)
  await flush()
  fireEvent.mouseEnter(trigger())
  expect(screen.getByRole("dialog")).toBeTruthy()
  fireEvent.mouseLeave(trigger())
  rerender(<ContextUsage bridge={replacement.bridge} workspaceId={scope === "workspace" ? "other" : "w"} sessionId={scope === "session" ? "other" : "s"} />)
  expect(screen.queryByRole("dialog")).toBeNull()
  fireEvent.mouseEnter(trigger())
  await advance(200)
  expect(screen.getByRole("dialog")).toBeTruthy()
  expect(vi.getTimerCount()).toBe(0)
  expect(request).toHaveBeenCalledTimes(2)
})

it("cancels hover dismissal timers on unmount", async () => {
  vi.useFakeTimers()
  const { bridge } = connection(vi.fn().mockResolvedValue(ready(12)))
  const { unmount } = render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  fireEvent.mouseEnter(trigger())
  expect(screen.getByRole("dialog")).toBeTruthy()
  fireEvent.mouseLeave(trigger())
  expect(vi.getTimerCount()).toBe(1)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
  await advance(200)
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("returns focus on Escape after explicit Retry replaces the focused popup button", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("Meter unavailable")).mockResolvedValueOnce(ready(22))
  const { bridge } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  fireEvent.click(trigger(), { detail: 0 })
  const retry = screen.getByRole("button", { name: "重試" })
  retry.focus()
  fireEvent.click(retry)
  await flush()
  expect(screen.getByRole("dialog")).toBeTruthy()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(trigger())
})

it("returns focus on pointer departure after explicit Retry removes the focused button", async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockRejectedValueOnce(new Error("Meter unavailable")).mockResolvedValueOnce(ready(22))
  const { bridge } = connection(request)
  render(<ContextUsage bridge={bridge} workspaceId="w" sessionId="s" />)
  await flush()
  fireEvent.click(trigger(), { detail: 0 })
  const dialog = screen.getByRole("dialog")
  const retry = screen.getByRole("button", { name: "重試" })
  retry.focus()
  fireEvent.click(retry)
  await flush()
  expect(document.activeElement).toBe(document.body)
  fireEvent.mouseLeave(dialog)
  await advance(200)
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(trigger())
})

it("preserves intentional external focus when pointer departure closes explicit details", async () => {
  vi.useFakeTimers()
  const { bridge } = connection(vi.fn().mockResolvedValue(ready(22)))
  render(<><textarea aria-label="Editor" /><ContextUsage bridge={bridge} workspaceId="w" sessionId="s" /></>)
  await flush()
  fireEvent.click(trigger(), { detail: 0 })
  const dialog = screen.getByRole("dialog")
  const editor = screen.getByRole("textbox", { name: "Editor" })
  editor.focus()
  fireEvent.mouseLeave(dialog)
  await advance(200)
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(document.activeElement).toBe(editor)
})
