import { describe, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import type { HarnessClient } from "@i-harness/sdk"
import { dispatchDesktopRequest, registerDesktopIpc } from "../src/main/ipc.ts"
import type { DesktopIpcDependencies, IpcMainLike } from "../src/main/ipc.ts"
import { DESKTOP_EVENT_CHANNEL, DESKTOP_REQUEST_CHANNEL, type DesktopEvent, type DesktopRequest } from "../src/shared/bridge.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"

const ENTRY: WorkspaceEntry = { id: "ws-1", path: "C:/workspace", label: "workspace" }

function fixture() {
  const listSessions = vi.fn(async () => ({ sessions: [] }))
  const history = vi.fn(async (sessionId: string, options: unknown) => ({ sessionId, options, events: [], nextSeq: 0 }))
  const request = vi.fn(async () => ({ ok: true }))
  const cancelQueueItem = vi.fn(async () => ({ cancelled: true }))
  const cancelTask = vi.fn(async () => "cancellation-requested")
  const client = { listSessions, history, request, cancelQueueItem, cancelTask } as unknown as HarnessClient
  const workspaceRuntime = {
    client,
    info: { name: "test", version: "0.1.0", protocolVersion: 3, capabilities: {} },
    sandbox: { mode: "read-only", source: "settings", wired: true } as const,
  }
  let runtimeFor: unknown = workspaceRuntime
  const get = vi.fn(async () => runtimeFor)
  let eventListener: ((event: DesktopEvent) => void) | undefined
  const offEvent = vi.fn()
  const runtimes = {
    get,
    onEvent: vi.fn((listener: (event: DesktopEvent) => void) => { eventListener = listener; return offEvent }),
    close: vi.fn(async () => {}),
  }
  const catalog = {
    list: vi.fn(async () => [ENTRY]),
    open: vi.fn(async () => ENTRY),
    get: vi.fn((id: string) => id === ENTRY.id ? ENTRY : undefined),
  }
  return {
    dependencies: { catalog, runtimes } as unknown as DesktopIpcDependencies,
    catalog,
    runtimes,
    listSessions,
    history,
    request,
    cancelQueueItem,
    cancelTask,
    get,
    setRuntime(value: unknown) { runtimeFor = value },
    emitEvent(event: DesktopEvent) { eventListener?.(event) },
    offEvent,
  }
}

describe("Desktop scoped IPC", () => {
  it("routes memory and compaction only to known workspaces after validating arguments", async () => {
    const f = fixture()
    await expect(dispatchDesktopRequest({ kind: "desktop/memory/search", workspaceId: "ws-1", query: "pnpm", limit: -1 }, f.dependencies)).rejects.toThrow(/limit/)
    expect(f.get).not.toHaveBeenCalled()
    await expect(dispatchDesktopRequest({ kind: "desktop/memory/read", workspaceId: "unknown", id: "note" }, f.dependencies)).rejects.toThrow(/workspace/)
    await dispatchDesktopRequest({ kind: "desktop/memory/note", workspaceId: "ws-1", title: "decision", text: "pnpm", path: "outside" }, f.dependencies)
    expect(f.request).toHaveBeenLastCalledWith("desktop/memory/note", { title: "decision", text: "pnpm" }, 30000)
    await dispatchDesktopRequest({ kind: "desktop/session/compact", workspaceId: "ws-1", sessionId: "s1" }, f.dependencies)
    expect(f.request).toHaveBeenLastCalledWith("desktop/session/compact", { sessionId: "s1" }, 600000)
  })
  it("rejects malformed, unknown, and out-of-range requests before touching the runtime", async () => {
    const f = fixture()

    await expect(dispatchDesktopRequest("not-an-object", f.dependencies)).rejects.toThrow(/object/i)
    await expect(dispatchDesktopRequest({ kind: "sdk/request" }, f.dependencies)).rejects.toThrow(/unknown/i)
    await expect(dispatchDesktopRequest({ kind: "session/list" }, f.dependencies)).rejects.toThrow(/workspaceId/i)
    await expect(dispatchDesktopRequest({ kind: "session/list", workspaceId: "nope" }, f.dependencies)).rejects.toThrow(/unknown workspace/i)
    await expect(dispatchDesktopRequest({
      kind: "session/history", workspaceId: "ws-1", sessionId: "s1", afterSeq: -1, limit: 10,
    }, f.dependencies)).rejects.toThrow(/afterSeq/i)
    await expect(dispatchDesktopRequest({
      kind: "session/history", workspaceId: "ws-1", sessionId: "s1", afterSeq: 0, limit: 1001,
    }, f.dependencies)).rejects.toThrow(/limit/i)

    expect(f.listSessions).not.toHaveBeenCalled()
    expect(f.get).not.toHaveBeenCalled()
  })

  it("dispatches session/list once through the known workspace runtime", async () => {
    const f = fixture()

    await expect(dispatchDesktopRequest({ kind: "session/list", workspaceId: "ws-1" }, f.dependencies))
      .resolves.toEqual({ sessions: [] })

    expect(f.get).toHaveBeenCalledWith(ENTRY)
    expect(f.listSessions).toHaveBeenCalledTimes(1)
  })

  it("passes a validated history cursor and limit through to the SDK", async () => {
    const f = fixture()

    await dispatchDesktopRequest({
      kind: "session/history", workspaceId: "ws-1", sessionId: "s1", afterSeq: 7, limit: 50,
    }, f.dependencies)

    expect(f.history).toHaveBeenCalledWith("s1", { afterSeq: 7, limit: 50 })
  })

  it("answers desktop/capabilities from the initialized host info", async () => {
    const f = fixture()

    await expect(dispatchDesktopRequest({ kind: "desktop/capabilities", workspaceId: "ws-1" }, f.dependencies))
      .resolves.toEqual({})
  })

  it("opens the folder the picker returns and reports a cancelled picker", async () => {
    const f = fixture()
    const pickFolder = vi.fn(async () => "D:/chosen")
    const withPicker = { ...f.dependencies, pickFolder }

    await expect(dispatchDesktopRequest({ kind: "workspace/pick" }, withPicker))
      .resolves.toEqual(ENTRY)
    expect(pickFolder).toHaveBeenCalledTimes(1)
    expect(f.catalog.open).toHaveBeenCalledWith("D:/chosen")

    const cancelled = { ...f.dependencies, pickFolder: vi.fn(async () => undefined) }
    await expect(dispatchDesktopRequest({ kind: "workspace/pick" }, cancelled)).resolves.toBeUndefined()
  })

  it("cancels a queued prompt row or a task row by exact id", async () => {
    const f = fixture()

    await expect(dispatchDesktopRequest({
      kind: "session/queue/cancel", workspaceId: "ws-1", sessionId: "s1", id: "q1",
    }, f.dependencies)).resolves.toEqual({ cancelled: true })
    expect(f.cancelQueueItem).toHaveBeenCalledWith("s1", "q1")

    await expect(dispatchDesktopRequest({
      kind: "session/tasks/cancel", workspaceId: "ws-1", sessionId: "s1", id: "t1",
    }, f.dependencies)).resolves.toBe("cancellation-requested")
    expect(f.cancelTask).toHaveBeenCalledWith("s1", "t1")

    await expect(dispatchDesktopRequest({
      kind: "session/tasks/cancel", workspaceId: "ws-1", sessionId: "s1", id: "",
    }, f.dependencies)).rejects.toThrow(/id/i)
  })

  it("gates session/prompt on the wired sandbox claim", async () => {
    const allowed = fixture()
    await dispatchDesktopRequest({
      kind: "session/prompt", workspaceId: "ws-1", sessionId: "s1", prompt: "hi",
    }, allowed.dependencies)
    expect(allowed.request).toHaveBeenCalledWith("session/prompt", { sessionId: "s1", prompt: "hi" }, 24 * 60 * 60 * 1000)

    // A runtime whose host never claimed the sandbox must not run tools.
    const gated = fixture()
    gated.setRuntime({
      client: { request: gated.request, listSessions: gated.listSessions },
      info: { name: "test", version: "0.1.0", protocolVersion: 3, capabilities: {} },
      sandbox: undefined,
    })
    await expect(dispatchDesktopRequest({
      kind: "session/prompt", workspaceId: "ws-1", sessionId: "s1", prompt: "hi",
    }, gated.dependencies)).rejects.toThrow(/sandbox-not-enabled/)
    expect(gated.request).not.toHaveBeenCalled()
  })

  it("rejects a request from any other webContents and unregisters cleanly", async () => {
    const f = fixture()
    const send = vi.fn()
    const window = {
      webContents: { id: 1, send },
      isDestroyed: () => false,
    }
    let handler: ((event: { sender: unknown }, request: unknown) => Promise<unknown>) | undefined
    const ipc: IpcMainLike = {
      handle: vi.fn((_channel, listener) => { handler = listener as typeof handler }),
      removeHandler: vi.fn(),
    }
    const unregister = registerDesktopIpc(window as unknown as BrowserWindow, f.dependencies, ipc)

    await expect(handler?.({ sender: { id: 2 } }, { kind: "workspace/list" }))
      .rejects.toThrow(/untrusted/i)
    await expect(handler?.({ sender: window.webContents }, { kind: "workspace/list" } satisfies DesktopRequest))
      .resolves.toEqual([ENTRY])

    f.emitEvent({ kind: "sdk/disconnected", workspaceId: "ws-1", message: "gone" })
    expect(send).toHaveBeenCalledWith(DESKTOP_EVENT_CHANNEL, { kind: "sdk/disconnected", workspaceId: "ws-1", message: "gone" })

    unregister()
    expect(ipc.removeHandler).toHaveBeenCalledWith(DESKTOP_REQUEST_CHANNEL)
    expect(f.offEvent).toHaveBeenCalledTimes(1)
  })
})
