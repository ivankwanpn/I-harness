// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import { afterEach, expect, it, vi } from "vitest"
import type { WorkbenchProps } from "../src/renderer/shell/Workbench.tsx"
import type { DesktopBridge, DesktopRequest } from "../src/shared/bridge.ts"
const captured = vi.hoisted(() => ({ props: undefined as WorkbenchProps | undefined }))
vi.mock("../src/renderer/shell/Workbench.tsx", () => ({ Workbench: (props: WorkbenchProps) => { captured.props = props; return null } }))
import { App } from "../src/renderer/app.tsx"
import { useUiStore } from "../src/renderer/shell/ui-store.ts"
import { writeDraft, readDraft } from "../src/renderer/session/Composer.tsx"
afterEach(() => { cleanup(); useUiStore.setState({ selectedWorkspaceId: undefined, selectedSessionId: undefined, providerRevision: 0 }) })

function defer() { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>((done) => { resolve = done }); return { promise, resolve } }
it("clears renderer drafts only for confirmed successful native permanent deletions", async () => {
  writeDraft("w1", "delete-ok", "delete me"); writeDraft("w1", "delete-failed", "keep failure"); writeDraft("w1", "new-task:unassigned", "keep new task")
  fixture(request => request.kind === "desktop/session/batch" ? Promise.resolve({ results: [{ sessionId: "delete-ok", ok: true }, { sessionId: "delete-failed", ok: false, sessionDeleted: true, error: "Native cleanup failed" }] }) : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  await act(async () => { await captured.props!.onBatchSessions!("w1", { action: "delete", sessionIds: ["delete-ok", "delete-failed"] }) })
  expect(readDraft("w1", "delete-ok")).toBe(""); expect(readDraft("w1", "delete-failed")).toBe("keep failure"); expect(readDraft("w1", "new-task:unassigned")).toBe("keep new task")
})
it.each([undefined, "destination"])("settles async authoritative ownership %s despite the selected workspace grouping", async (owner) => {
  const pending: ReturnType<typeof defer>[] = []
  fixture(request => request.kind === "projects/list" ? Promise.resolve([{ id: "original", name: "Original", workspaceIds: ["w1"] }, { id: "destination", name: "Destination", workspaceIds: ["w2"] }])
    : request.kind === "desktop/capabilities" ? Promise.resolve({ "desktop-project-scope": ["1"] })
    : request.kind === "desktop/session/project/state" ? (() => { const reply = defer(); pending.push(reply); return reply.promise })() : undefined)
  await waitFor(() => expect(captured.props?.capabilities["desktop-project-scope"]).toEqual(["1"]))
  act(() => captured.props!.onSelectSessionInWorkspace!("w1", "a", "original"))
  await waitFor(() => expect(pending).toHaveLength(1))
  expect(captured.props!.conversation!.projectReady).toBe(false)
  await act(async () => { pending[0]!.resolve({ sessionId: "a", ...(owner ? { projectId: owner } : {}) }); await pending[0]!.promise })
  expect(pending).toHaveLength(1)
  expect(captured.props!.conversation!.projectReady).toBe(true)
  expect(captured.props!.selectedProjectId).toBe(owner)
})
it("clears a persisted selection that is no longer in the conversation list", async () => {
  useUiStore.setState({ selectedWorkspaceId: "w1", selectedSessionId: "old-reviewer" })
  fixture(() => undefined)
  await waitFor(() => expect(captured.props?.selectedSessionId).toBeUndefined())
})
it("reconciles the restored selection when StrictMode replays the initial effect", async () => {
  useUiStore.setState({ selectedWorkspaceId: "w1", selectedSessionId: "old-reviewer" })
  fixture(() => undefined, undefined, true)
  await waitFor(() => expect(captured.props?.selectedSessionId).toBeUndefined())
})
it("does not clear a newer selection while the initial list was still loading", async () => {
  const dashboard = defer()
  useUiStore.setState({ selectedWorkspaceId: "w1", selectedSessionId: "old-reviewer" })
  fixture((request) => request.kind === "session/dashboard" ? dashboard.promise : undefined)
  act(() => captured.props!.onSelectSession("a"))
  await act(async () => { dashboard.resolve({ sessions: [] }); await dashboard.promise })
  expect(captured.props?.selectedSessionId).toBe("a")
})
it("does not reconcile a later user selection when retrying an unavailable initial listing", async () => {
  let reads = 0
  useUiStore.setState({ selectedWorkspaceId: "w1", selectedSessionId: "old-reviewer" })
  fixture((request) => request.kind === "session/dashboard" ? Promise.resolve(++reads === 1 ? { sessions: [], listingUnavailable: true } : { sessions: [] }) : undefined)
  await waitFor(() => expect(captured.props?.connection).toBe("online"))
  act(() => captured.props!.onSelectSession("a"))
  act(() => captured.props!.onRetry!())
  await waitFor(() => expect(reads).toBe(2))
  await waitFor(() => expect(captured.props?.connection).toBe("online"))
  expect(captured.props?.selectedSessionId).toBe("a")
})
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

it("hides an earlier snapshot while revisiting a session until its fresh read resolves", async () => {
  const returning = defer()
  const other = defer()
  let aReads = 0
  let bReads = 0
  fixture((request) => request.kind === "desktop/capabilities" ? Promise.resolve({ "desktop-work-state": ["1"] })
    : request.kind === "desktop/session/work-state" ? request.sessionId === "a"
      ? ++aReads === 1 ? Promise.resolve({ todos: [{ content: "Earlier A", status: "pending" }], goal: null }) : returning.promise
      : (bReads += 1, other.promise) : undefined)
  await waitFor(() => expect(captured.props?.capabilities["desktop-work-state"]).toEqual(["1"]))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(captured.props!.conversation?.workState?.todos?.[0]?.content).toBe("Earlier A"))
  act(() => captured.props!.onSelectSession("b"))
  await waitFor(() => expect(bReads).toBe(1))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(aReads).toBe(2))
  expect(captured.props!.conversation?.workState).toBeUndefined()
  await act(async () => { returning.resolve({ todos: [{ content: "Current A", status: "completed" }], goal: null }); await returning.promise })
  await waitFor(() => expect(captured.props!.conversation?.workState?.todos?.[0]?.content).toBe("Current A"))
  await act(async () => { other.resolve({ todos: [{ content: "B", status: "pending" }], goal: null }); await other.promise })
  expect(captured.props!.conversation?.workState?.todos?.[0]?.content).toBe("Current A")
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

it("removes a stale Goal when refreshing it fails after a Goal event", async () => {
  let reads = 0
  let emit!: Parameters<DesktopBridge["onEvent"]>[0]
  fixture((request) => request.kind === "desktop/capabilities" ? Promise.resolve({ "desktop-work-state": ["1"] })
    : request.kind === "desktop/session/work-state" ? ++reads === 1
      ? Promise.resolve({ todos: null, goal: { id: "g", revision: 1, objective: "Outdated goal", phase: "active" } })
      : Promise.reject(new Error("fresh goal unavailable")) : undefined,
  (listener) => { emit = listener; return () => {} })
  await waitFor(() => expect(captured.props?.capabilities["desktop-work-state"]).toEqual(["1"]))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(captured.props!.conversation?.workState?.goal?.objective).toBe("Outdated goal"))
  act(() => emit({ kind: "sdk/notification", workspaceId: "w1", method: "session/event", params: { sessionId: "a", event: { type: "goal/change", version: 1, operation: "edit" } } }))
  await waitFor(() => expect(captured.props!.conversation?.workStateError).toContain("fresh goal unavailable"))
  expect(captured.props!.conversation?.workState).toBeUndefined()
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
function fixture(override: (request: DesktopRequest) => Promise<unknown> | undefined, onEvent: DesktopBridge["onEvent"] = () => () => {}, strict = false) {
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
  render(strict ? <StrictMode><App bridge={bridge} /></StrictMode> : <App bridge={bridge} />)
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

it("validates historical targets and keeps historical page reads separate from the live rows", async () => {
  fixture(request => request.kind === "desktop/notifications/target" ? Promise.resolve({ workspaceId: request.workspaceId, sessionId: request.sessionId })
    : request.kind === "session/dashboard" ? Promise.resolve({ sessions: [{ id: "a", live: false }] })
    : request.kind === "session/history" ? Promise.resolve({ events: [{ type: "user/message", seq: 900, text: "Live latest" }], nextSeq: 901 }) : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => captured.props!.onSelectSession("a"))
  await waitFor(() => expect(captured.props?.conversation?.rows.length).toBeGreaterThan(0))
  const rows = captured.props!.conversation!.rows
  act(() => captured.props!.onSelectHistory!({ workspaceId: "w1", sessionId: "a", seq: 300 }))
  await waitFor(() => expect(captured.props?.historicalView?.selection).toEqual({ workspaceId: "w1", sessionId: "a", seq: 300 }))
  await act(async () => { await captured.props!.historicalView!.request({ kind: "session/history", workspaceId: "w1", sessionId: "a", afterSeq: 200, limit: 200 }) })
  expect(captured.props!.conversation!.rows).toEqual(rows)
  act(() => captured.props!.historicalView!.onLatest())
  expect(captured.props!.historicalView).toBeUndefined()
  expect(captured.props!.selectedSessionId).toBe("a")
})

it("ignores a delayed historical target validation after a newer conversation selection", async () => {
  const target = defer()
  fixture(request => request.kind === "desktop/notifications/target" ? target.promise : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => captured.props!.onSelectHistory!({ workspaceId: "w1", sessionId: "a", seq: 300 }))
  act(() => captured.props!.onSelectSession("b"))
  await act(async () => { target.resolve({ workspaceId: "w1", sessionId: "a" }); await target.promise })
  expect(captured.props!.selectedSessionId).toBe("b")
  expect(captured.props!.historicalView).toBeUndefined()
})

it("moves the selected conversation grouping while retaining its execution workspace", async () => {
  const projects = [{ id: "original", name: "Original", workspaceIds: ["w1"], createdAt: "now", updatedAt: "now" }, { id: "destination", name: "Destination", workspaceIds: ["w2"], createdAt: "now", updatedAt: "now" }]
  const request = fixture(request => request.kind === "projects/list" ? Promise.resolve(projects)
    : request.kind === "session/dashboard" ? Promise.resolve({ sessions: [{ id: "a", live: false }] })
    : request.kind === "desktop/session/batch" ? Promise.resolve({ results: [{ sessionId: "a", ok: true, projectId: "destination", executionWorkspace: "D:/agent-complete/playground" }, { sessionId: "b", ok: false, error: "Busy" }] }) : undefined)
  await waitFor(() => expect(captured.props?.selectedWorkspaceId).toBe("w1"))
  act(() => captured.props!.onSelectSessionInWorkspace!("w1", "a", "original"))
  await act(async () => { await captured.props!.onBatchSessions!("w1", { action: "move", sessionIds: ["a", "b"], projectId: "destination", expectedOwners: { a: "original", b: "original" } }) })
  expect(request).toHaveBeenCalledWith({ kind: "desktop/session/batch", workspaceId: "w1", confirmed: true, command: { action: "move", sessionIds: ["a", "b"], projectId: "destination", expectedOwners: { a: "original", b: "original" } } })
  expect(captured.props!.selectedProjectId).toBe("destination")
  expect(captured.props!.selectedWorkspaceId).toBe("w1")
  expect(captured.props!.selectedSessionId).toBe("a")
})
