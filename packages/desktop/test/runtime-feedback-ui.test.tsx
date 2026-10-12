// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopEvent } from "../src/shared/bridge.ts"
import type { RuntimeDiagnosticEntry } from "../src/shared/runtime-diagnostics.ts"
import { RuntimeFeedback } from "../src/renderer/session/RuntimeFeedback.tsx"
import { NewTaskComposer } from "../src/renderer/session/Composer.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import { classifyNotification } from "../src/renderer/session/notifications.ts"
import { applyHistory, applyNotification, emptyEventWindow, historyViewport, pageHistoryViewport } from "../src/renderer/session/event-window.ts"

afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); useUiStore.setState({ surface: "conversation", settingsLogRevision: 0 }) })
it("keeps transient activity out of durable notification and replay windows", () => {
  const event = { type: "model/activity", version: 1, activity: { requestId: "physical", phase: "quiet", startedAt: 1000, waitingFor: "progress" } }
  expect(classifyNotification("session/event", { sessionId: "a", event })).toEqual({ kind: "ignore" })
  expect(applyNotification(emptyEventWindow(), event as never)).toEqual(emptyEventWindow())
  expect(applyHistory(emptyEventWindow(), { events: [event], nextSeq: 0 } as never).events).toEqual([])
  expect(pageHistoryViewport({ events: [], startSeq: 0, endSeq: 0, hasBefore: false, hasAfter: false }, { events: [event], nextSeq: 0 } as never, 0, "after").events).toEqual([])
  expect(historyViewport({ events: [event], nextSeq: 0 } as never, 0).events).toEqual([])
  expect(applyHistory(emptyEventWindow(), { events: [{ ...event, seq: 1 }], nextSeq: 2 } as never).events).toEqual([])
})
function fixture() {
  const listeners = new Set<(event: DesktopEvent) => void>()
  const bridge: DesktopBridge = { request: vi.fn(async () => ({ entries: [] })), onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const emit = (event: DesktopEvent) => act(() => { listeners.forEach(listener => listener(event)) })
  const entry = (patch: Partial<RuntimeDiagnosticEntry> = {}) => emit({ kind: "runtime/diagnostic", entry: { id: "retry", timestamp: Date.now(), workspaceId: "w", sessionId: "a", requestId: "request", level: "warning", kind: "model/retry", message: "Model connection retry 1 (waiting).", retry: { requestId: "request", phase: "waiting", attempt: 1, maxRetries: 5, delayMs: 10000, nextAttemptAt: Date.now() + 10000, code: "CAPACITY" }, ...patch } })
  const status = (status: string, sessionId = "a") => emit({ kind: "sdk/notification", workspaceId: "w", method: "session/status", params: { sessionId, status } })
  return { bridge, emit, entry, status }
}

it.each(["failed", "cancelled", "completed"])("retains current quiet and retry feedback after an uncorrelated old %s status", terminal => {
  const f = fixture(); const props = { bridge: f.bridge, workspaceId: "w", sessionId: "a", onOpenLog() {} }
  const view = render(<RuntimeFeedback {...props} />)
  const execution = (running: boolean, queued: number, revision: number) => f.emit({ kind: "sdk/notification", workspaceId: "w", method: "session/execution-state", params: { sessionId: "a", running, queued, revision } })
  execution(true, 0, 7)
  view.rerender(<RuntimeFeedback {...props} sessionId="b" />)
  view.rerender(<RuntimeFeedback {...props} />)
  for (const phase of ["connecting", "quiet"] as const) f.emit({ kind: "runtime/activity", workspaceId: "w", sessionId: "a", activity: { requestId: "physical-new", phase, startedAt: Date.now(), waitingFor: "progress" } })
  f.entry()
  execution(false, 0, 6)
  if (terminal !== "completed") f.entry({ id: "old-terminal", requestId: undefined, kind: terminal === "failed" ? "session/error" : "session/cancelled", level: terminal === "failed" ? "error" : "info", retry: undefined })
  f.status(terminal)
  expect(screen.getByRole("status").textContent).toContain("容量")
  if (terminal === "failed") expect(screen.getByRole("alert")).toBeTruthy()
  f.entry({ id: "recovered", kind: "model/recovered", level: "info", retry: undefined })
  expect(screen.getByRole("status").textContent).toContain("等待模型繼續")
  execution(false, 1, 8); f.status(terminal)
  expect(screen.getByRole("status")).toBeTruthy()
  execution(false, 0, 9)
  expect(screen.queryByRole("status")).toBeNull()
})

it("honors native uncorrelated errors even when the renderer missed earlier execution state", () => {
  const f = fixture(); render(<RuntimeFeedback bridge={f.bridge} workspaceId="w" sessionId="a" onOpenLog={() => {}} />)
  f.entry()
  f.entry({ id: "old-error", kind: "session/error", level: "error", requestId: undefined, retry: undefined, executionUncorrelated: true })
  expect(screen.getByRole("status").textContent).toContain("容量")
  expect(screen.getByRole("alert")).toBeTruthy()
  f.entry({ id: "old-cancellation", kind: "session/cancelled", level: "info", requestId: undefined, retry: undefined, executionUncorrelated: true })
  expect(screen.getByRole("status").textContent).toContain("容量")
})

it("keeps capacity countdown through the next attempt until real progress, without focus stealing", () => {
  vi.useFakeTimers(); const f = fixture()
  render(<><textarea aria-label="draft" /><RuntimeFeedback bridge={f.bridge} workspaceId="w" sessionId="a" onOpenLog={() => {}} /></>)
  const draft = screen.getByRole("textbox"); draft.focus(); f.entry()
  expect(screen.getByRole("status").textContent).toContain("10")
  expect(screen.getByRole("status").textContent).toContain("容量")
  expect(document.activeElement).toBe(draft)
  act(() => vi.advanceTimersByTime(10000))
  expect(screen.getByRole("status").textContent).toContain("重新連線中")
  f.entry({ id: "attempting", retry: { requestId: "request", phase: "attempting", attempt: 1, maxRetries: 5, delayMs: 10000, code: "CAPACITY" } })
  f.status("running"); expect(screen.getByRole("status")).toBeTruthy()
  f.entry({ id: "recovered", kind: "model/recovered", level: "info", message: "Model connection recovered.", retry: undefined })
  expect(screen.queryByRole("status")).toBeNull(); expect(screen.queryByRole("alert")).toBeNull()
})

it("shows one dismissible terminal popup and never resurrects duplicate entries", () => {
  const f = fixture(); render(<RuntimeFeedback bridge={f.bridge} workspaceId="w" sessionId="a" onOpenLog={() => {}} />)
  const failure = { id: "failure", kind: "session/error" as const, level: "error" as const, message: "Model request failed.", retry: undefined }
  f.entry(failure); f.entry(failure)
  expect(screen.getAllByRole("alert")).toHaveLength(1)
  fireEvent.click(screen.getByRole("button", { name: "關閉錯誤通知" }))
  f.entry(failure); expect(screen.queryByRole("alert")).toBeNull()
})

it("isolates background chats and rejected admissions from the active retry", () => {
  const f = fixture(); const props = { bridge: f.bridge, workspaceId: "w", sessionId: "a", onOpenLog() {} }
  const view = render(<RuntimeFeedback {...props} />); f.entry()
  f.entry({ id: "admission", kind: "runtime/error", level: "error", requestId: "other-request", retry: undefined, message: "Runtime request could not start." })
  expect(screen.getByRole("status")).toBeTruthy()
  f.entry({ id: "background", sessionId: "b", kind: "session/error", level: "error", retry: undefined, message: "Background request failed." })
  expect(screen.queryByText("Background request failed.")).toBeNull()
  view.rerender(<RuntimeFeedback {...props} sessionId="b" />)
  expect(screen.getByText("Background request failed.")).toBeTruthy(); expect(screen.queryByRole("status")).toBeNull()
  view.rerender(<RuntimeFeedback {...props} />); expect(screen.getByRole("status")).toBeTruthy()
  f.status("cancelled"); expect(screen.queryByRole("status")).toBeNull()
})

it("opens safe details explicitly, copies through native IPC and sends Log navigation", async () => {
  const f = fixture(); const onOpenLog = vi.fn()
  f.bridge.request = vi.fn(async action => action.kind === "desktop/diagnostics/copy" ? { copied: true } : { entries: [{ id: "final", timestamp: 1, level: "error", kind: "session/error", message: "Native safe summary", code: "http_503" }] })
  render(<div id="root"><RuntimeFeedback bridge={f.bridge} workspaceId="w" sessionId="a" onOpenLog={onOpenLog} /></div>)
  f.entry({ id: "final", kind: "session/error", level: "error", retry: undefined })
  expect(screen.queryByRole("dialog")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "詳細資料" }))
  await screen.findByText(/Native safe summary/)
  expect(document.getElementById("root")?.hasAttribute("inert")).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "複製安全詳細資料" }))
  await screen.findByText("已複製安全詳細資料。")
  expect(f.bridge.request).toHaveBeenCalledWith({ kind: "desktop/diagnostics/copy", id: "final" })
  fireEvent.click(screen.getByRole("button", { name: "關閉" }))
  fireEvent.click(screen.getByRole("button", { name: "診斷記錄" }))
  expect(onOpenLog).toHaveBeenCalled()
})

it("associates a failed new-task admission with its created native session while retaining the draft", async () => {
  const f = fixture()
  f.bridge.request = vi.fn(async action => {
    if (action.kind === "desktop/provider/directory") return [{ id: "fixture", configured: true, models: [{ id: "test-model" }] }]
    if (action.kind === "session/create") return { sessionId: "created" }
    if (action.kind === "desktop/session/input/submit") {
      f.entry({ id: "admission", sessionId: "created", kind: "runtime/error", level: "error", retry: undefined, message: "Safe admission failure." })
      throw new Error("private admission body")
    }
    return undefined
  })
  render(<><NewTaskComposer bridge={f.bridge} workspaceId="w" capabilities={{ "session-create": ["1"], "desktop-input": ["1"], "desktop-draft-create": ["1"] }} onSubmitted={() => {}} /><RuntimeFeedback bridge={f.bridge} workspaceId="w" onOpenLog={() => {}} /></>)
  fireEvent.click(screen.getByRole("button", { name: "選擇模型" }))
  fireEvent.click(await screen.findByRole("button", { name: "test-model" }))
  fireEvent.change(screen.getByRole("textbox", { name: "提示" }), { target: { value: "retain new draft" } })
  fireEvent.click(screen.getByRole("button", { name: "送出" }))
  await screen.findByText("Safe admission failure.")
  expect((screen.getByRole("textbox", { name: "提示" }) as HTMLTextAreaElement).value).toBe("retain new draft")
  expect(screen.queryByText("private admission body")).toBeNull()
})

it("clears exhausted recovery on its native failure and clears old popups at the next turn", () => {
  const f = fixture(); render(<RuntimeFeedback bridge={f.bridge} workspaceId="w" sessionId="a" onOpenLog={() => {}} />)
  f.entry(); f.entry({ id: "final", kind: "session/error", level: "error", retry: undefined })
  expect(screen.queryByRole("status")).toBeNull(); expect(screen.getByRole("alert")).toBeTruthy()
  f.emit({ kind: "sdk/notification", workspaceId: "w", method: "session/event", params: { sessionId: "a", event: { type: "turn/start", seq: 10 } } })
  expect(screen.queryByRole("alert")).toBeNull()
})

it("does not use raw SDK error or disconnect text as diagnostic content", () => {
  const f = fixture(); render(<RuntimeFeedback bridge={f.bridge} workspaceId="w" sessionId="a" onOpenLog={() => {}} />)
  for (const status of ["failed", "error"]) f.emit({ kind: "sdk/notification", workspaceId: "w", method: "session/status", params: { sessionId: "a", status, error: "private provider body" } })
  f.emit({ kind: "sdk/disconnected", workspaceId: "w", message: "private stderr" })
  expect(screen.queryByRole("alert")).toBeNull()
  f.entry({ id: "disconnect", kind: "gateway/disconnected", sessionId: undefined, level: "error", retry: undefined, message: "Local gateway disconnected." })
  expect(screen.getByRole("alert").textContent).toContain("Local gateway disconnected.")
})

it("renders the App feedback surface safely before workspace or session selection", () => {
  useUiStore.setState({ draftSubmissionScope: undefined })
  const f = fixture()
  render(<RuntimeFeedback bridge={f.bridge} onOpenLog={() => {}} />)
  expect(screen.queryByRole("alert")).toBeNull(); expect(screen.queryByRole("status")).toBeNull()
})

it("shows quiet physical attempt elapsed time, retains logical retry until recovered, and ignores stale settlement", () => {
  vi.useFakeTimers(); vi.setSystemTime(20_000)
  const f = fixture(); render(<RuntimeFeedback bridge={f.bridge} workspaceId="w" sessionId="a" onOpenLog={() => {}} />)
  const activity = (phase: "connecting" | "streaming" | "quiet" | "settled", requestId: string, patch: Partial<import("../../core-session/src/index.ts").ModelActivityInfo> = {}) => f.emit({ kind: "runtime/activity", workspaceId: "w", sessionId: "a", activity: { requestId, phase, startedAt: 1_000, waitingFor: "first-response", ...patch } })
  activity("connecting", "physical-1")
  activity("streaming", "physical-1", { waitingFor: "progress" })
  expect(screen.queryByRole("status")).toBeNull()
  activity("quiet", "physical-1", { waitingFor: "progress" })
  expect(screen.getByRole("status").textContent).toContain("19")
  f.entry(); activity("connecting", "physical-2"); activity("quiet", "physical-2")
  activity("settled", "physical-1")
  expect(screen.getByRole("status").textContent).toContain("容量")
  activity("streaming", "physical-2", { waitingFor: "progress", lastProgressAt: 19_000 })
  expect(screen.getByRole("status").textContent).toContain("容量")
  f.entry({ id: "recovered", kind: "model/recovered", level: "info", retry: undefined })
  expect(screen.queryByRole("status")).toBeNull()
})
it("clears quiet feedback on progress, matching settlement, Stop, disconnect and authoritative idle", () => {
  vi.useFakeTimers(); vi.setSystemTime(20_000)
  const f = fixture(); render(<RuntimeFeedback bridge={f.bridge} workspaceId="w" sessionId="a" onOpenLog={() => {}} />)
  const activity = (phase: "connecting" | "streaming" | "quiet" | "settled", requestId: string) => f.emit({ kind: "runtime/activity", workspaceId: "w", sessionId: "a", activity: { requestId, phase, startedAt: 1_000, waitingFor: "progress" } })
  activity("connecting", "p1"); activity("quiet", "p1"); expect(screen.getByRole("status")).toBeTruthy()
  activity("streaming", "p1"); expect(screen.queryByRole("status")).toBeNull()
  activity("quiet", "p1"); activity("settled", "p1"); expect(screen.queryByRole("status")).toBeNull()
  activity("connecting", "p2"); activity("quiet", "p2"); f.status("cancelled"); expect(screen.queryByRole("status")).toBeNull()
  activity("connecting", "p3"); activity("quiet", "p3"); f.emit({ kind: "sdk/disconnected", workspaceId: "w", message: "private" }); expect(screen.queryByRole("status")).toBeNull()
  activity("connecting", "p4"); activity("quiet", "p4"); f.emit({ kind: "sdk/notification", workspaceId: "w", method: "session/execution-state", params: { sessionId: "a", running: false, queued: 1, revision: 1 } }); expect(screen.getByRole("status")).toBeTruthy()
  f.emit({ kind: "sdk/notification", workspaceId: "w", method: "session/execution-state", params: { sessionId: "a", running: false, queued: 0, revision: 2 } }); expect(screen.queryByRole("status")).toBeNull()
})
it("does not revive a quiet card after selection changes or an older execution revision", () => {
  const f = fixture(); const props = { bridge: f.bridge, workspaceId: "w", sessionId: "a", onOpenLog() {} }
  const view = render(<RuntimeFeedback {...props} />)
  const quiet = (sessionId: string, requestId: string) => {
    f.emit({ kind: "runtime/activity", workspaceId: "w", sessionId, activity: { requestId, phase: "connecting", startedAt: Date.now() - 20_000, waitingFor: "progress" } })
    f.emit({ kind: "runtime/activity", workspaceId: "w", sessionId, activity: { requestId, phase: "quiet", startedAt: Date.now() - 20_000, waitingFor: "progress" } })
  }
  quiet("a", "p1"); expect(screen.getByRole("status")).toBeTruthy()
  view.rerender(<RuntimeFeedback {...props} sessionId="b" />); expect(screen.queryByRole("status")).toBeNull()
  view.rerender(<RuntimeFeedback {...props} />); expect(screen.queryByRole("status")).toBeNull()
  quiet("a", "p2"); expect(screen.getByRole("status")).toBeTruthy()
  f.emit({ kind: "sdk/notification", workspaceId: "w", method: "session/execution-state", params: { sessionId: "a", running: true, queued: 0, revision: 5 } })
  f.emit({ kind: "sdk/notification", workspaceId: "w", method: "session/execution-state", params: { sessionId: "a", running: false, queued: 0, revision: 4 } })
  expect(screen.getByRole("status")).toBeTruthy()
  f.emit({ kind: "sdk/notification", workspaceId: "w", method: "session/execution-state", params: { sessionId: "a", running: false, queued: 0, revision: 6 } })
  expect(screen.queryByRole("status")).toBeNull()
})
it("does not clear a replacement retry from an older logical recovery", () => {
  const f = fixture(); render(<RuntimeFeedback bridge={f.bridge} workspaceId="w" sessionId="a" onOpenLog={() => {}} />)
  f.entry({ id: "new-retry", requestId: "new-logical", retry: { requestId: "new-logical", phase: "attempting", attempt: 2, delayMs: 0, code: "TIMEOUT" } })
  f.entry({ id: "old-recovery", kind: "model/recovered", level: "info", requestId: "old-logical", retry: undefined })
  expect(screen.getByRole("status").textContent).toContain("重新連線中")
})
