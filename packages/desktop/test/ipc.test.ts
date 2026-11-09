import { describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow } from "electron"
import type { HarnessClient } from "@i-harness/sdk"
import { dispatchDesktopRequest, registerDesktopIpc } from "../src/main/ipc.ts"
import type { DesktopIpcDependencies, IpcMainLike } from "../src/main/ipc.ts"
import { DESKTOP_EVENT_CHANNEL, DESKTOP_REQUEST_CHANNEL, type DesktopEvent, type DesktopRequest } from "../src/shared/bridge.ts"
import type { WorkspaceEntry } from "../src/main/workspaces.ts"
import { RpcError } from '@i-harness/sdk'
import { createForkOperation } from '@i-harness/sdk/fork'
import { preparedFork, readyFork } from './helpers/fork-contract.ts'

const ENTRY: WorkspaceEntry = { id: "ws-1", path: "C:/workspace", label: "workspace" }

function fixture() {
  const listSessions = vi.fn(async () => ({ sessions: [] }))
  const history = vi.fn(async (sessionId: string, options: unknown) => ({ sessionId, options, events: [], nextSeq: 0 }))
  const request = vi.fn(async (): Promise<unknown> => ({ ok: true }))
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
  it('validates new fork commands before runtime work and forwards only a known capable workspace', async () => {
    const f = fixture(), request = { kind: 'desktop/session/fork/prepare', workspaceId: ENTRY.id, request: { version: 1, sourceSessionId: 'a' } }
    for (const invalid of [{ ...request, extra: true }, { ...request, request: { ...request.request, signal: {} } }, { ...request, request: { version: 1, sourceSessionId: '' } }]) await expect(dispatchDesktopRequest(invalid, f.dependencies)).rejects.toThrow()
    expect(f.get).not.toHaveBeenCalled()
    await expect(dispatchDesktopRequest({ ...request, workspaceId: 'unknown' }, f.dependencies)).rejects.toThrow()
    expect(f.get).not.toHaveBeenCalled()
    await expect(dispatchDesktopRequest(request, f.dependencies)).rejects.toThrow(/unavailable/i)
    expect(f.request).not.toHaveBeenCalled()
    f.setRuntime({ client: { request: f.request }, info: { capabilities: { 'session-fork-bootstrap': '1' } } })
    await expect(dispatchDesktopRequest(request, f.dependencies)).rejects.toThrow(/unavailable/i)
    expect(f.request).not.toHaveBeenCalled()
    f.setRuntime({ client: { request: f.request }, info: { capabilities: { 'session-fork-bootstrap': ['1'] } } })
    f.request.mockResolvedValueOnce(preparedFork('a'))
    expect(await dispatchDesktopRequest(request, f.dependencies)).toEqual(preparedFork('a'))
    expect(f.request).toHaveBeenLastCalledWith('session/fork/prepare', request.request)
    const operation = createForkOperation(preparedFork('a').prepared, { operationId: 'ipc-original', targetSessionId: 'child', createdAt: '2026-10-27T00:00:00.000Z' })
    f.request.mockResolvedValueOnce(readyFork(operation))
    expect(await dispatchDesktopRequest({ kind: 'desktop/session/fork/begin', workspaceId: ENTRY.id, operation }, f.dependencies)).toEqual(readyFork(operation))
    expect(f.request).toHaveBeenLastCalledWith('session/fork/begin', { operation })
    const before = f.request.mock.calls.length
    await expect(dispatchDesktopRequest({ kind: 'desktop/session/manage', workspaceId: ENTRY.id, sessionId: 'a', action: 'fork' }, f.dependencies)).rejects.toThrow()
    expect(f.request).toHaveBeenCalledTimes(before)
  })
  it('preserves validated existing fork error data across Electron serialization without exposing arbitrary RPC data', async () => {
    const f = fixture(), operation = createForkOperation(preparedFork('a').prepared, { operationId: 'ipc-cleanup', targetSessionId: 'child', createdAt: '2026-10-27T00:00:00.000Z' })
    const data = { version: 1, kind: 'session-fork-error', operation, capture: 'captured', reason: 'cleanup-incomplete', lastOutcome: readyFork(operation) }
    f.setRuntime({ client: { request: f.request }, info: { capabilities: { 'session-fork-bootstrap': ['1'] } } })
    f.request.mockRejectedValueOnce(new RpcError(-32603, 'Session fork unavailable', data))
    expect(await dispatchDesktopRequest({ kind: 'desktop/session/fork/retry', workspaceId: ENTRY.id, operation }, f.dependencies)).toEqual(data)
    f.request.mockRejectedValueOnce(new RpcError(-32603, 'private raw error', { ...data, privatePayload: 'must not cross IPC' }))
    const malformed = await dispatchDesktopRequest({ kind: 'desktop/session/fork/retry', workspaceId: ENTRY.id, operation }, f.dependencies).catch(error => error)
    if (!(malformed instanceof Error)) throw new Error('Expected a safe IPC rejection')
    expect(malformed.message).toBe('Invalid session fork response'); expect(malformed.message).not.toContain('private')
    const other = createForkOperation(operation.prepared, { operationId: operation.invocation.operationId, createdAt: operation.invocation.createdAt, targetSessionId: 'other' })
    f.request.mockRejectedValueOnce(new RpcError(-32603, 'Session fork unavailable', { ...data, operation: other, lastOutcome: readyFork(other) }))
    await expect(dispatchDesktopRequest({ kind: 'desktop/session/fork/retry', workspaceId: ENTRY.id, operation }, f.dependencies)).rejects.toThrow('Invalid session fork response')
  })
  it("preflights result queries before Gateway startup and forwards only capable known scopes", async () => {
    const f = fixture()
    const ref = {version:1,id:"ctxv1_"+"a".repeat(64),revision:"b".repeat(64),codec:"text-utf8-v1",encodedBytes:100,contentDigest:"c".repeat(64),completeness:"complete"}
    const valid = {kind:"session/result/read",workspaceId:ENTRY.id,sessionId:"conversation",ref,maxBytes:16384}
    for (const invalid of [{...valid,maxBytes:64000},{...valid,offset:-1},{...valid,cursor:{recordOffset:9,sliceOffset:0}},{...valid,ref:{...ref,revision:"forged"}},{...valid,sessionId:""},{...valid,extra:"path"}]) {
      await expect(dispatchDesktopRequest(invalid,f.dependencies)).rejects.toThrow()
    }
    expect(f.get).not.toHaveBeenCalled()
    await expect(dispatchDesktopRequest({...valid,workspaceId:"unknown"},f.dependencies)).rejects.toThrow()
    expect(f.get).not.toHaveBeenCalled()
    await expect(dispatchDesktopRequest(valid,f.dependencies)).rejects.toThrow(/unavailable/i)
    expect(f.request).not.toHaveBeenCalled()
    const page = {ref,offset:0,nextOffset:null,eof:true,data:{kind:"text",text:"saved"}}
    const request = vi.fn(async () => page)
    f.setRuntime({client:{request},info:{capabilities:{"session-result-read":["1"]}}})
    expect(await dispatchDesktopRequest(valid,f.dependencies)).toBe(page)
    expect(request).toHaveBeenCalledExactlyOnceWith("session/result/read",{sessionId:"conversation",ref,maxBytes:16384})
    const native={...ref,codec:"exec-frames-v1"},catalog={...ref,id:"ctxv1_"+"d".repeat(64),codec:"json-utf8-v1"}
    await expect(dispatchDesktopRequest({...valid,ref:native,viaCatalog:catalog},f.dependencies)).rejects.toThrow(/unavailable/i)
    expect(request).toHaveBeenCalledTimes(1)
    f.setRuntime({client:{request},info:{capabilities:{"session-result-read":["1","2"]}}})
    await dispatchDesktopRequest({...valid,ref:native,viaCatalog:catalog},f.dependencies)
    expect(request).toHaveBeenLastCalledWith("session/result/read",{sessionId:"conversation",ref:native,viaCatalog:catalog,maxBytes:16384})
  })
  it("rejects unsupported subagent catalog hosts and validates lineage/paging arguments before routing", async () => {
    const f = fixture()
    await expect(dispatchDesktopRequest({ kind: "desktop/session/subagents/list", workspaceId: ENTRY.id, sessionId: "parent" }, f.dependencies)).rejects.toThrow(/Subagent catalog/i)
    f.setRuntime({ client: { request: f.request }, info: { capabilities: { "desktop-subagent-catalog": ["1"] } } })
    await dispatchDesktopRequest({ kind: "desktop/session/subagents/history", workspaceId: ENTRY.id, sessionId: "parent", childSessionId: "child", afterSeq: 4, limit: 200 }, f.dependencies)
    expect(f.request).toHaveBeenCalledWith("desktop/session/subagents/history", { sessionId: "parent", childSessionId: "child", afterSeq: 4, limit: 200 }, 30000)
    await expect(dispatchDesktopRequest({ kind: "desktop/session/subagents/history", workspaceId: ENTRY.id, sessionId: "parent", childSessionId: "child", limit: 1001 }, f.dependencies)).rejects.toThrow(/limit/)
    await expect(dispatchDesktopRequest({ kind: "desktop/session/subagents/control", workspaceId: ENTRY.id, sessionId: "parent", childSessionId: "child", action: "followup", text: "" }, f.dependencies)).rejects.toThrow(/text/)
    expect(f.request).toHaveBeenCalledTimes(1)
  })
  it("routes project metadata locally, preserves revision checks and rejects unknown folder reveals", async () => {
    const f = fixture()
    const save = vi.fn(async (input: import("../src/main/projects.ts").ProjectInput) => ({ id: input.id ?? "p", name: input.name, workspaceIds: input.workspaceIds, primaryWorkspaceId: input.primaryWorkspaceId, pinned: input.pinned, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }))
    const revealWorkspace = vi.fn(async () => {})
    f.dependencies.projects = { list: async () => [], save, remove: async () => {}, unassigned: async () => [] }
    f.dependencies.revealWorkspace = revealWorkspace
    await dispatchDesktopRequest({ kind: "projects/save", input: { name: "App", workspaceIds: [ENTRY.id], primaryWorkspaceId: ENTRY.id, expectedUpdatedAt: "2026-10-01T00:00:00.000Z" } }, f.dependencies)
    expect(save).toHaveBeenCalledWith({ name: "App", workspaceIds: [ENTRY.id], primaryWorkspaceId: ENTRY.id, expectedUpdatedAt: "2026-10-01T00:00:00.000Z" })
    expect(f.runtimes.get).not.toHaveBeenCalled()
    await expect(dispatchDesktopRequest({ kind: "workspace/reveal", workspaceId: "unknown" }, f.dependencies)).rejects.toThrow("Unknown workspace")
    expect(revealWorkspace).not.toHaveBeenCalled()
    await dispatchDesktopRequest({ kind: "workspace/reveal", workspaceId: ENTRY.id }, f.dependencies)
    expect(revealWorkspace).toHaveBeenCalledWith(ENTRY.path)
    await expect(dispatchDesktopRequest({ kind: "projects/save", input: { name: "", workspaceIds: [ENTRY.id] } }, f.dependencies)).rejects.toThrow("Invalid project")
  })
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
  it("reads the current sandbox from the gateway after a live settings change", async () => {
    const f = fixture()
    const request = vi.fn(async () => ({ wired: true, source: "settings", mode: "danger-full-access" }))
    f.setRuntime({
      client: { request },
      info: { capabilities: { "desktop-sandbox": ["1"] } },
      sandbox: { wired: true, source: "settings", mode: "read-only" },
    })
    await expect(dispatchDesktopRequest({ kind: "workspace/sandbox/state", workspaceId: ENTRY.id }, f.dependencies)).resolves.toMatchObject({ mode: "danger-full-access" })
    expect(request).toHaveBeenCalledWith("desktop/sandbox/state", {})
  })
  it("passes only a named approval mode to the known workspace gateway", async () => {
    const f = fixture()
    await expect(dispatchDesktopRequest({ kind: "desktop/agent-settings/configure", workspaceId: ENTRY.id, patch: { approvalMode: "unrestricted" } }, f.dependencies)).rejects.toThrow(/approval mode/i)
    await dispatchDesktopRequest({ kind: "desktop/agent-settings/configure", workspaceId: ENTRY.id, patch: { approvalMode: "delegate" } }, f.dependencies)
    expect(f.request).toHaveBeenLastCalledWith("desktop/agent-settings/configure", { approvalMode: "delegate" }, 30000)
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
  it("lists detected terminal shells without starting a workspace runtime", async () => {
    const f = fixture()
    const shellOptions = vi.fn(() => [{ id: "auto", label: "自動選擇", command: "C:\\Git\\bash.exe" }])
    f.dependencies.shellOptions = shellOptions
    await expect(dispatchDesktopRequest({ kind: "desktop/terminal/options" }, f.dependencies)).resolves.toEqual(shellOptions())
    expect(f.get).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
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

  it("unregisters after Electron destroys the window without accessing its native webContents getter", async () => {
    const f = fixture()
    let destroyed = false
    const sender = { id: 1, send: vi.fn() }
    const window = {
      get webContents() { if (destroyed) throw new TypeError("Object has been destroyed"); return sender },
      isDestroyed: () => destroyed,
    }
    const ipc: IpcMainLike = { handle: vi.fn(), removeHandler: vi.fn() }
    const unregister = registerDesktopIpc(window as unknown as BrowserWindow, f.dependencies, ipc)
    destroyed = true
    await expect(unregister()).resolves.toBeUndefined()
    await expect(unregister()).resolves.toBeUndefined()
    expect(ipc.removeHandler).toHaveBeenCalledTimes(1)
    expect(f.offEvent).toHaveBeenCalledTimes(1)
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
    await expect(handler?.({ sender: { id: 2 } }, { kind: "session/result/read", workspaceId: ENTRY.id, sessionId: "s" }))
      .rejects.toThrow(/untrusted/i)
    expect(f.get).not.toHaveBeenCalled()
    await expect(handler?.({ sender: window.webContents }, { kind: "workspace/list" } satisfies DesktopRequest))
      .resolves.toEqual([ENTRY])

    f.emitEvent({ kind: "sdk/disconnected", workspaceId: "ws-1", message: "gone" })
    expect(send).toHaveBeenCalledWith(DESKTOP_EVENT_CHANNEL, { kind: "sdk/disconnected", workspaceId: "ws-1", message: "gone" })

    unregister()
    expect(ipc.removeHandler).toHaveBeenCalledWith(DESKTOP_REQUEST_CHANNEL)
    expect(f.offEvent).toHaveBeenCalledTimes(1)
  })
})
it("repairs a workspace by restarting its runtime and parking the native execution state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-ws-repair-"))
  await mkdir(join(root, ".i-harness"))
  const invalidate = vi.fn(async () => {})
  const dependencies = {
    catalog: { get: (id: string) => id === "ws-r" ? { id: "ws-r", path: root, label: "repair" } : undefined },
    runtimes: { invalidate },
  } as unknown as DesktopIpcDependencies
  const result = await dispatchDesktopRequest({ kind: "desktop/workspace/repair", workspaceId: "ws-r" }, dependencies) as { repaired?: boolean; backup?: string }
  expect(result.repaired).toBe(true)
  expect(invalidate).toHaveBeenCalledWith("ws-r")
  await expect(stat(join(root, ".i-harness"))).rejects.toThrow()
  expect((await readdir(root)).some(name => name.startsWith(".i-harness.bak-"))).toBe(true)
})
it("force-stops a session by restarting only its workspace runtime", async () => {
  const invalidate = vi.fn(async () => {})
  const dependencies = { catalog: { get: (id: string) => id === "ws-1" ? ENTRY : undefined }, runtimes: { invalidate } } as unknown as DesktopIpcDependencies
  const result = await dispatchDesktopRequest({ kind: "desktop/session/force-stop", workspaceId: "ws-1", sessionId: "s-1" }, dependencies) as { restarted?: boolean }
  expect(result.restarted).toBe(true)
  expect(invalidate).toHaveBeenCalledWith("ws-1")
})
