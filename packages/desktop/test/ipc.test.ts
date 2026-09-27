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
  it("forwards images only when the gateway advertises prompt-image support", async () => {
    const f = fixture()
    const image = { mediaType: "image/png" as const, dataBase64: "aGVsbG8=" }
    const payload = { kind: "session/prompt" as const, workspaceId: ENTRY.id, sessionId: "s", prompt: "inspect", clientToken: "desktop-request-1", images: [image] }
    await expect(dispatchDesktopRequest(payload, f.dependencies)).rejects.toThrow("not supported")
    expect(f.request).not.toHaveBeenCalled()
    f.setRuntime({ client: { request: f.request }, info: { capabilities: { "prompt-images": ["1"] } }, sandbox: { wired: true, mode: "read-only", source: "settings" } })
    await dispatchDesktopRequest(payload, f.dependencies)
    expect(f.request).toHaveBeenCalledWith("session/prompt", { sessionId: "s", prompt: "inspect", clientToken: "desktop-request-1", images: [image] }, 24 * 60 * 60 * 1000)
  })
  it("accepts file references only from the native picker and checks them through review", async () => {
    const f = fixture()
    f.dependencies.pickFiles = vi.fn(async () => [`${ENTRY.path}/a.md`])
    f.request.mockResolvedValue({ kind: "text", text: "a", truncated: true, bytes: 1 } as never)
    expect(await dispatchDesktopRequest({ kind: "workspace/files/pick", workspaceId: ENTRY.id }, f.dependencies)).toEqual({ paths: ["a.md"] })
    expect(f.request).toHaveBeenCalledWith("desktop/review/file", { path: "a.md", maxBytes: 1 })
    f.dependencies.pickFiles = vi.fn(async () => ["D:/outside/secret.md"])
    await expect(dispatchDesktopRequest({ kind: "workspace/files/pick", workspaceId: ENTRY.id }, f.dependencies)).rejects.toThrow()
  })
  it("limits Agent settings patches to supported fields in a known workspace", async () => {
    const f = fixture()
    await dispatchDesktopRequest({ kind: "desktop/agent-settings/configure", workspaceId: ENTRY.id, patch: { autoCompaction: false } }, f.dependencies)
    expect(f.request).toHaveBeenCalledWith("desktop/agent-settings/configure", { autoCompaction: false }, 30000)
    await expect(dispatchDesktopRequest({ kind: "desktop/agent-settings/configure", workspaceId: ENTRY.id, patch: { sandboxMode: "anything" } }, f.dependencies)).rejects.toThrow()
    await expect(dispatchDesktopRequest({ kind: "desktop/agent-settings/configure", workspaceId: "unknown", patch: { autoCompaction: false } }, f.dependencies)).rejects.toThrow()
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it("keeps native browser operations outside the SDK and checks workspace identity", async () => {
    const f = fixture()
    const request = vi.fn(() => [])
    f.dependencies.browser = { request, dispose: vi.fn() }
    await dispatchDesktopRequest({ kind: "browser/list", workspaceId: ENTRY.id }, f.dependencies)
    expect(request).toHaveBeenCalledWith(ENTRY.id, { kind: "browser/list", workspaceId: ENTRY.id })
    expect(f.get).not.toHaveBeenCalled()
    await expect(dispatchDesktopRequest({ kind: "browser/list", workspaceId: "unknown" }, f.dependencies)).rejects.toThrow("Unknown browser workspace")
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("forwards a scoped provider command and refuses unknown operations", async () => {
    const f = fixture()
    const command = { action: "model/edit", id: "route", model: "model", fields: { contextWindow: 272000 } }
    await dispatchDesktopRequest({ kind: "desktop/provider/mutate", workspaceId: ENTRY.id, command }, f.dependencies)
    expect(f.request).toHaveBeenCalledWith("desktop/provider/mutate", command)
    await expect(dispatchDesktopRequest({ kind: "desktop/provider/mutate", workspaceId: ENTRY.id, command: { action: "exec" } }, f.dependencies)).rejects.toThrow("invalid provider command")
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it("routes provider reads only through a registered workspace", async () => {
    const f = fixture()
    await dispatchDesktopRequest({ kind: "desktop/provider/directory", workspaceId: ENTRY.id }, f.dependencies)
    expect(f.request).toHaveBeenCalledWith("desktop/provider/directory", {})
    await expect(dispatchDesktopRequest({ kind: "desktop/provider/directory", workspaceId: "unknown" }, f.dependencies)).rejects.toThrow()
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it("validates native window preferences and never forwards them to the SDK", async () => {
    const f = fixture()
    const configure = vi.fn(() => ({ notifications: true }))
    const control = vi.fn(() => ({ maximized: false }))
    f.dependencies.native = { configure, control } as unknown as NonNullable<DesktopIpcDependencies["native"]>
    await expect(dispatchDesktopRequest({ kind: "window/control", action: "exec" }, f.dependencies)).rejects.toThrow("invalid window action")
    await expect(dispatchDesktopRequest({ kind: "desktop/local/configure", notifications: "yes" }, f.dependencies)).rejects.toThrow("invalid notifications")
    await dispatchDesktopRequest({ kind: "desktop/local/configure", notifications: true, path: "ignored" }, f.dependencies)
    expect(configure).toHaveBeenCalledWith({ notifications: true })
    await dispatchDesktopRequest({ kind: "window/control", action: "minimize" }, f.dependencies)
    expect(control).toHaveBeenCalledWith("minimize")
    expect(f.get).not.toHaveBeenCalled()
  })
  it("uses the saved local shell for new terminals and ignores renderer executable fields", async () => {
    const f = fixture()
    const state = vi.fn(() => ({ terminalShell: "git-bash" }))
    const configure = vi.fn(() => ({ terminalShell: "git-bash" }))
    f.dependencies.native = { state, configure } as unknown as NonNullable<DesktopIpcDependencies["native"]>
    await expect(dispatchDesktopRequest({ kind: "desktop/local/configure", terminalShell: "other" }, f.dependencies)).rejects.toThrow(/terminal shell/)
    await dispatchDesktopRequest({ kind: "desktop/local/configure", terminalShell: "git-bash" }, f.dependencies)
    expect(configure).toHaveBeenCalledWith({ terminalShell: "git-bash" })
    await dispatchDesktopRequest({ kind: "desktop/terminal/open", workspaceId: ENTRY.id, command: "C:/untrusted.exe", shell: "cmd" }, f.dependencies)
    expect(f.request).toHaveBeenLastCalledWith("desktop/terminal/open", { shell: "git-bash" })
    await dispatchDesktopRequest({ kind: "desktop/terminal/options", workspaceId: ENTRY.id }, f.dependencies)
    expect(f.request).toHaveBeenLastCalledWith("desktop/terminal/options", {})
  })
  it("validates and stores only a bounded local terminal font override", async () => {
    const f = fixture()
    const configure = vi.fn(() => ({ terminalFontFamily: "Cascadia Code, monospace" }))
    f.dependencies.native = { configure } as unknown as NonNullable<DesktopIpcDependencies["native"]>
    await expect(dispatchDesktopRequest({ kind: "desktop/local/configure", terminalFontFamily: "x".repeat(129) }, f.dependencies)).rejects.toThrow(/terminal font/i)
    await expect(dispatchDesktopRequest({ kind: "desktop/local/configure", terminalFontFamily: "bad\nfont" }, f.dependencies)).rejects.toThrow(/terminal font/i)
    await dispatchDesktopRequest({ kind: "desktop/local/configure", terminalFontFamily: "  Cascadia Code, monospace  " }, f.dependencies)
    expect(configure).toHaveBeenCalledWith({ terminalFontFamily: "Cascadia Code, monospace" })
    expect(f.get).not.toHaveBeenCalled()
  })
  it("scopes reminder requests to a known workspace and removes extra renderer fields", async () => {
    const f = fixture()
    f.setRuntime({ client: { request: f.request }, info: { capabilities: { "desktop-schedule": ["1"] } }, sandbox: { wired: true, mode: "workspace-write", source: "settings" } })
    await expect(dispatchDesktopRequest({ kind: "desktop/schedule/create", workspaceId: "unknown", sessionId: "s", command: { prompt: "later", after_seconds: 600 } }, f.dependencies)).rejects.toThrow(/workspace/i)
    await expect(dispatchDesktopRequest({ kind: "desktop/schedule/create", workspaceId: ENTRY.id, sessionId: "s", command: { prompt: "later", after_seconds: 600, command: "pwsh" } }, f.dependencies)).rejects.toThrow(/schedule/i)
    expect(f.request).not.toHaveBeenCalled()
    await dispatchDesktopRequest({ kind: "desktop/schedule/create", workspaceId: ENTRY.id, sessionId: "s", command: { prompt: "later", after_seconds: 600 } }, f.dependencies)
    expect(f.request).toHaveBeenCalledWith("desktop/schedule/create", { sessionId: "s", command: { prompt: "later", after_seconds: 600 } })
    await dispatchDesktopRequest({ kind: "desktop/schedule/list", workspaceId: ENTRY.id, sessionId: "s" }, f.dependencies)
    expect(f.request).toHaveBeenLastCalledWith("desktop/schedule/list", { sessionId: "s" })
    await dispatchDesktopRequest({ kind: "desktop/schedule/delete", workspaceId: ENTRY.id, sessionId: "s", id: "schedule-1" }, f.dependencies)
    expect(f.request).toHaveBeenLastCalledWith("desktop/schedule/delete", { sessionId: "s", id: "schedule-1" })
  })
  it("reads work state only for a known workspace and advertised capability", async () => {
    const f = fixture()
    await expect(dispatchDesktopRequest({ kind: "desktop/session/work-state", workspaceId: "unknown", sessionId: "s" }, f.dependencies)).rejects.toThrow(/workspace/i)
    await expect(dispatchDesktopRequest({ kind: "desktop/session/work-state", workspaceId: ENTRY.id, sessionId: "s" }, f.dependencies)).rejects.toThrow(/work state/i)
    f.setRuntime({ client: { request: f.request }, info: { capabilities: { "desktop-work-state": ["1"] } }, sandbox: { wired: true, mode: "workspace-write", source: "settings" } })
    await dispatchDesktopRequest({ kind: "desktop/session/work-state", workspaceId: ENTRY.id, sessionId: "s", command: "ignored" }, f.dependencies)
    expect(f.request).toHaveBeenCalledWith("desktop/session/work-state", { sessionId: "s" })
    expect(f.request).toHaveBeenCalledTimes(1)
  })
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
