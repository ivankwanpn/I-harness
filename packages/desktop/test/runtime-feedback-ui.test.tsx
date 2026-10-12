// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopEvent } from "../src/shared/bridge.ts"
import type { RuntimeDiagnosticEntry } from "../src/shared/runtime-diagnostics.ts"
import { RuntimeFeedback } from "../src/renderer/session/RuntimeFeedback.tsx"
import { NewTaskComposer } from "../src/renderer/session/Composer.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"

afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); useUiStore.setState({ surface: "conversation", settingsLogRevision: 0 }) })
function fixture() {
  const listeners = new Set<(event: DesktopEvent) => void>()
  const bridge: DesktopBridge = { request: vi.fn(async () => ({ entries: [] })), onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const emit = (event: DesktopEvent) => act(() => { listeners.forEach(listener => listener(event)) })
  const entry = (patch: Partial<RuntimeDiagnosticEntry> = {}) => emit({ kind: "runtime/diagnostic", entry: { id: "retry", timestamp: Date.now(), workspaceId: "w", sessionId: "a", requestId: "request", level: "warning", kind: "model/retry", message: "Model connection retry 1 (waiting).", retry: { requestId: "request", phase: "waiting", attempt: 1, maxRetries: 5, delayMs: 10000, nextAttemptAt: Date.now() + 10000, code: "CAPACITY" }, ...patch } })
  const status = (status: string, sessionId = "a") => emit({ kind: "sdk/notification", workspaceId: "w", method: "session/status", params: { sessionId, status } })
  return { bridge, emit, entry, status }
}

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
