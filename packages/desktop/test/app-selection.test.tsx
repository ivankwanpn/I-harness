// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { WorkbenchProps } from "../src/renderer/shell/Workbench.tsx"
import type { DesktopBridge, DesktopRequest } from "../src/shared/bridge.ts"
const captured = vi.hoisted(() => ({ props: undefined as WorkbenchProps | undefined }))
vi.mock("../src/renderer/shell/Workbench.tsx", () => ({ Workbench: (props: WorkbenchProps) => { captured.props = props; return null } }))
import { App } from "../src/renderer/app.tsx"
afterEach(cleanup)

function defer() { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>((done) => { resolve = done }); return { promise, resolve } }
function fixture(override: (request: DesktopRequest) => Promise<unknown> | undefined) {
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
  const bridge: DesktopBridge = { request, onEvent: () => () => {} }
  render(<App bridge={bridge} />)
  return request
}

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
