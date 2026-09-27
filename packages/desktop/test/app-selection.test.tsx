// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { WorkbenchProps } from "../src/renderer/shell/Workbench.tsx"
import type { DesktopBridge, DesktopRequest } from "../src/shared/bridge.ts"
const captured = vi.hoisted(() => ({ props: undefined as WorkbenchProps | undefined }))
vi.mock("../src/renderer/shell/Workbench.tsx", () => ({ Workbench: (props: WorkbenchProps) => { captured.props = props; return null } }))
import { App } from "../src/renderer/app.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
afterEach(() => { cleanup(); useUiStore.setState({ selectedWorkspaceId: undefined, selectedSessionId: undefined, providerRevision: 0 }) })

function defer() { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>((done) => { resolve = done }); return { promise, resolve } }
it("recovers the selected unconfigured session after provider settings are saved", async () => {
  let configured = false
  fixture((request) => request.kind === "session/model/state" ? Promise.resolve(configured ? { status: "ready", providerId: "p", modelId: "m", label: "Configured" } : { status: "unconfigured", reason: "missing key" }) : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(captured.props!.conversation!.modelState?.status).toBe("unconfigured"))
  configured = true
  act(() => useUiStore.setState((state) => ({ providerRevision: state.providerRevision + 1 })))
  await waitFor(() => expect(captured.props!.conversation!.modelLabel).toBe("Configured"))
})
it("loads work state for the selected session and refreshes it after a Todo event", async () => {
  let readCount = 0
  let emit!: Parameters<DesktopBridge["onEvent"]>[0]
  const request = fixture((request) => request.kind === "desktop/capabilities" ? Promise.resolve({ "desktop-work-state": ["1"] })
    : request.kind === "desktop/session/work-state" ? Promise.resolve({ todos: [{ content: ++readCount === 1 ? "First" : "Second", status: "in_progress" }], goal: null }) : undefined,
  (listener) => { emit = listener; return () => {} })
  await waitFor(() => expect(captured.props?.capabilities["desktop-work-state"]).toEqual(["1"]))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(captured.props!.conversation?.workState?.todos?.[0]?.content).toBe("First"))
  act(() => emit({ kind: "sdk/notification", workspaceId: "w1", method: "session/event", params: { sessionId: "a", event: { type: "todo/write", version: 1, items: [{ content: "Second", status: "in_progress" }] } } }))
  await waitFor(() => expect(captured.props!.conversation?.workState?.todos?.[0]?.content).toBe("Second"))
  expect(request.mock.calls.filter(([value]) => value.kind === "desktop/session/work-state")).toHaveLength(2)
})

it("ignores a late work-state read from the previously selected session", async () => {
  const old = defer()
  fixture((request) => request.kind === "desktop/capabilities" ? Promise.resolve({ "desktop-work-state": ["1"] })
    : request.kind === "desktop/session/work-state" ? request.sessionId === "a" ? old.promise : Promise.resolve({ todos: [{ content: "B only", status: "pending" }], goal: null }) : undefined)
  await waitFor(() => expect(captured.props?.capabilities["desktop-work-state"]).toEqual(["1"]))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(captured.props?.selectedSessionId).toBe("a"))
  act(() => captured.props!.onSelectSession("b"))
  await waitFor(() => expect(captured.props!.conversation?.workState?.todos?.[0]?.content).toBe("B only"))
  await act(async () => { old.resolve({ todos: [{ content: "A only", status: "pending" }], goal: null }); await old.promise })
  expect(captured.props!.conversation?.workState?.todos?.[0]?.content).toBe("B only")
})

it("keeps a newer Goal projection when an older same-session read resolves last", async () => {
  const old = defer()
  let reads = 0
  let emit!: Parameters<DesktopBridge["onEvent"]>[0]
  fixture((request) => request.kind === "desktop/capabilities" ? Promise.resolve({ "desktop-work-state": ["1"] })
    : request.kind === "desktop/session/work-state" ? ++reads === 1 ? old.promise : Promise.resolve({ todos: null, goal: { id: "g", revision: 2, objective: "New goal", phase: "active" } }) : undefined,
  (listener) => { emit = listener; return () => {} })
  await waitFor(() => expect(captured.props?.capabilities["desktop-work-state"]).toEqual(["1"]))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(reads).toBe(1))
  act(() => emit({ kind: "sdk/notification", workspaceId: "w1", method: "session/event", params: { sessionId: "a", event: { type: "goal/change", version: 1, operation: "edit" } } }))
  await waitFor(() => expect(captured.props!.conversation?.workState?.goal?.objective).toBe("New goal"))
  await act(async () => { old.resolve({ todos: null, goal: { id: "g", revision: 1, objective: "Old goal", phase: "active" } }); await old.promise })
  expect(captured.props!.conversation?.workState?.goal?.objective).toBe("New goal")
})

it("shows a work-state read failure and recovers through the retry action", async () => {
  let reads = 0
  fixture((request) => request.kind === "desktop/capabilities" ? Promise.resolve({ "desktop-work-state": ["1"] })
    : request.kind === "desktop/session/work-state" ? ++reads === 1 ? Promise.reject(new Error("work state offline")) : Promise.resolve({ todos: [], goal: null }) : undefined)
  await waitFor(() => expect(captured.props?.capabilities["desktop-work-state"]).toEqual(["1"]))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(captured.props!.conversation?.workStateError).toContain("work state offline"))
  expect(captured.props!.conversation?.workState).toBeUndefined()
  act(() => captured.props!.conversation!.onRetryWorkState!())
  await waitFor(() => expect(captured.props!.conversation?.workState?.todos).toEqual([]))
  expect(captured.props!.conversation?.workStateError).toBeUndefined()
})
it("refreshes the model after leaving and returning during a pending switch", async () => {
  const pending = defer()
  let modelId = "old"
  fixture((request) => request.kind === "session/model/set" ? pending.promise : request.kind === "session/model/state" ? Promise.resolve({ status: "ready", providerId: "p", modelId, label: modelId }) : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(captured.props!.conversation!.modelLabel).toBe("old"))
  let switchJob!: Promise<void>
  act(() => { switchJob = captured.props!.conversation!.onSetModel!({ provider: "p", model: "new" }) })
  act(() => captured.props!.onSelectSession("b"))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(captured.props!.conversation!.modelLabel).toBe("old"))
  modelId = "new"
  await act(async () => { pending.resolve({ status: "ready", providerId: "p", modelId, label: modelId }); await switchJob })
  await waitFor(() => expect(captured.props!.conversation!.modelLabel).toBe("new"))
})
function fixture(override: (request: DesktopRequest) => Promise<unknown> | undefined, onEvent: DesktopBridge["onEvent"] = () => () => {}) {
  const request = vi.fn(async (request: DesktopRequest): Promise<unknown> => {
    const custom = override(request)
    if (custom) return custom
    switch (request.kind) {
      case "workspace/list": return [{ id: "w1", path: "D:/agent-complete/playground", label: "playground" }]
      case "session/dashboard": return { sessions: [] }
      case "desktop/capabilities": return {}
      case "workspace/sandbox/state": return { mode: "read-only", source: "settings", wired: true }
      case "session/history": return { events: [], nextSeq: 0 }
      case "session/model/state": return { status: "unconfigured", reason: "test" }
      case "desktop/review/changes": return { kind: "ok", files: [], truncated: false }
      default: return []
    }
  })
  const bridge: DesktopBridge = { request, onEvent }
  render(<App bridge={bridge} />)
  return request
}

it("retains a successful initial dashboard when a newer background read fails", async () => {
  const initial = defer()
  let reads = 0
  let emit!: Parameters<DesktopBridge["onEvent"]>[0]
  fixture((request) => request.kind === "session/dashboard"
    ? ++reads === 1 ? initial.promise : Promise.reject(new Error("temporary failure"))
    : undefined, (listener) => { emit = listener; return () => {} })
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => emit({ kind: "sdk/notification", workspaceId: "w1", method: "session/status", params: { sessionId: "a", status: "idle" } }))
  await waitFor(() => expect(reads).toBe(2))
  await act(async () => { initial.resolve({ sessions: [], marker: "initial" }); await initial.promise })
  expect(captured.props!.dashboard).toMatchObject({ marker: "initial" })
})

it("ignores history from a session left while loading", async () => {
  const old = defer()
  fixture((request) => request.kind === "session/history" && request.sessionId === "a" ? old.promise : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => captured.props!.onSelectSession("a"))
  act(() => captured.props!.onSelectSession("b"))
  await act(async () => { old.resolve({ events: [{ type: "user/message", seq: 0, text: "old session content" }], nextSeq: 1 }); await old.promise })
  expect(captured.props!.selectedSessionId).toBe("b")
  expect(captured.props!.conversation!.rows).toEqual([])
})

it("keeps the latest chosen file when an earlier diff arrives late", async () => {
  const first = defer(); const second = defer()
  fixture((request) => request.kind === "desktop/review/diff" ? request.path === "a" ? first.promise : second.promise : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => captured.props!.review!.onSelect("a", "diff"))
  act(() => captured.props!.review!.onSelect("b", "diff"))
  await act(async () => { second.resolve({ kind: "text", text: "B", truncated: false, bytes: 1 }); await second.promise })
  await act(async () => { first.resolve({ kind: "text", text: "A", truncated: false, bytes: 1 }); await first.promise })
  expect(captured.props!.review!.selected?.path).toBe("b")
  expect(captured.props!.review!.diff).toMatchObject({ text: "B" })
})

it("clears a selected review detail when refresh reports no remaining changes", async () => {
  let files = [{ path: "note.txt", status: "modified", canDiff: true, canPreview: true }]
  fixture((request) => request.kind === "desktop/review/changes"
    ? Promise.resolve({ kind: "ok", files, truncated: false })
    : request.kind === "desktop/review/diff"
      ? Promise.resolve({ kind: "text", text: "+after", truncated: false, bytes: 6 })
      : undefined)
  await waitFor(() => expect(captured.props?.review?.changes).toMatchObject({ kind: "ok", files: [{ path: "note.txt" }] }))
  act(() => captured.props!.review!.onSelect("note.txt", "diff"))
  await waitFor(() => expect(captured.props?.review?.diff).toMatchObject({ text: "+after" }))
  files = []
  act(() => captured.props!.review!.onRefresh())
  await waitFor(() => expect(captured.props?.review?.changes).toMatchObject({ kind: "ok", files: [] }))
  expect(captured.props!.review!.selected).toBeUndefined()
  expect(captured.props!.review!.diff).toBeUndefined()
})

it("reloads pending interactions on retry without losing an outstanding approval", async () => {
  const approval = { requestId: "approval", sessionId: "a", kind: "approval", payload: { name: "write" }, openedAt: 1 }
  const request = fixture((value) => value.kind === "desktop/interaction/pending" ? Promise.resolve([approval]) : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(captured.props!.conversation!.pending).toHaveLength(1))
  const reads = () => request.mock.calls.filter(([value]) => value.kind === "desktop/interaction/pending").length
  const before = reads()
  act(() => captured.props!.onRetry!())
  await waitFor(() => expect(reads()).toBeGreaterThan(before))
  expect(captured.props!.conversation!.pending).toEqual([approval])
})

it("does not carry an outstanding prompt into another session's running state", async () => {
  const old = defer()
  fixture((request) => request.kind === "session/prompt" ? old.promise : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => captured.props!.onSelectSession("a"))
  let prompt!: Promise<void>
  act(() => { prompt = captured.props!.conversation!.onPrompt("test") })
  expect(captured.props!.conversation!.running).toBe(true)
  act(() => captured.props!.onSelectSession("b"))
  expect(captured.props!.conversation!.running).toBe(false)
  act(() => captured.props!.onSelectSession("a"))
  expect(captured.props!.conversation!.running).toBe(true)
  await act(async () => { old.resolve({}); await prompt })
  expect(captured.props!.conversation!.running).toBe(false)
})

it("reports real connection bootstrap failure and a successful retry", async () => {
  let fail = true
  fixture((request) => request.kind === "desktop/capabilities" ? fail ? Promise.reject(new Error("offline")) : Promise.resolve({}) : undefined)
  await waitFor(() => expect(captured.props?.connection).toBe("offline"))
  fail = false
  act(() => captured.props!.onRetry!())
  expect(captured.props!.connection).toBe("reconnecting")
  await waitFor(() => expect(captured.props!.connection).toBe("online"))
  act(() => captured.props!.onSelectWorkspace("w1"))
  expect(captured.props!.connection).toBe("online")
  expect(captured.props!.dashboard).toBeDefined()
})

it("keeps a history failure visible even when task loading succeeds", async () => {
  fixture((request) => request.kind === "session/history" ? Promise.reject(new Error("history unavailable")) : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(captured.props!.conversation!.queue).toEqual([]))
  expect(captured.props!.conversation!.historyError).toBe("history unavailable")
})

it("refreshes the selected file content together with the change list", async () => {
  let reads = 0
  fixture((request) => request.kind === "desktop/review/changes"
    ? Promise.resolve({ kind: "ok", files: [{ path: "file", status: "modified", canDiff: true, canPreview: true }], truncated: false })
    : request.kind === "desktop/review/diff" ? Promise.resolve({ kind: "text", text: `version${++reads}`, truncated: false, bytes: 8 }) : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => captured.props!.review!.onSelect("file", "diff"))
  await waitFor(() => expect(captured.props!.review!.diff).toMatchObject({ text: "version1" }))
  act(() => captured.props!.review!.onRefresh())
  await waitFor(() => expect(captured.props!.review!.diff).toMatchObject({ text: "version2" }))
})
