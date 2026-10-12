import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow } from "electron"
import { createRuntimeDiagnostics } from "../src/main/runtime-diagnostics.ts"
import { createGlobalProviderSettings } from "../src/main/global-provider-settings.ts"
import { dispatchDesktopRequest, registerDesktopIpc, type DesktopIpcDependencies, type IpcMainLike } from "../src/main/ipc.ts"
import type { DesktopEvent } from "../src/shared/bridge.ts"
import { createSessionCoordinator } from "../../session-persistence/src/index.ts"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createSessionService } from "../../session-executor/src/index.ts"
import { createDesktopInput } from "../../desktop-gateway/src/input.ts"
import { createDesktopRouter } from "../../desktop-gateway/src/router.ts"
import { createSdkServer } from "@i-harness/sdk/server"
import { RpcError, encodeFrame, makeRequest, isRpcFailure, type RpcMessage } from "@i-harness/sdk"
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "ih-diagnostic-ipc-")); roots.push(root)
 const diagnostics = createRuntimeDiagnostics(root)
 const request = vi.fn(async (_method: string, _params: unknown): Promise<unknown> => ({ maxRetries: 5 }))
 const globalProviders = createGlobalProviderSettings(async () => ({ request }))
 const dependencies = { diagnostics, globalProviders, catalog: { get: (id: string) => id === "ws" ? { id, path: root } : undefined }, runtimes: { get: async () => { throw new Error("Startup failed: raw body") }, onEvent: () => () => {} } } as unknown as DesktopIpcDependencies
 return { dependencies, diagnostics, request }
}
describe("native diagnostic IPC", () => {
 it("proxies bounded global wait settings without a selected workspace", async () => {
   const f = await fixture()
   f.request.mockImplementation(async () => ({ firstResponseSeconds: 300, progressSeconds: 300 }))
   expect(await dispatchDesktopRequest({ kind: "desktop/global-model-wait/state" }, f.dependencies)).toEqual({ firstResponseSeconds: 300, progressSeconds: 300 })
   for (const seconds of [0, 30, 3600]) await dispatchDesktopRequest({ kind: "desktop/global-model-wait/configure", firstResponseSeconds: seconds, progressSeconds: seconds }, f.dependencies)
   expect(f.request.mock.calls).toEqual([["desktop/model-wait/state", {}], ...[0, 30, 3600].map(seconds => ["desktop/model-wait/configure", { firstResponseSeconds: seconds, progressSeconds: seconds }])])
   for (const seconds of [-1, 29, 3601, 30.5, "30", null, NaN]) {
     await expect(dispatchDesktopRequest({ kind: "desktop/global-model-wait/configure", firstResponseSeconds: seconds, progressSeconds: 300 }, f.dependencies)).rejects.toThrow(/wait/i)
     await expect(f.dependencies.globalProviders!.request({ kind: "desktop/global-model-wait/configure", firstResponseSeconds: 300, progressSeconds: seconds })).rejects.toThrow(/wait/i)
   }
   expect(f.request).toHaveBeenCalledTimes(4)
 })
 it("forwards only safe live activity and records bounded quiet lifecycle facts", async () => {
   const f = await fixture(); const live: unknown[] = []
   f.diagnostics.onActivity(activity => live.push(activity))
   const activity = (phase: string, requestId = "physical-1") => f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/event", params: { sessionId: "s", event: { type: "model/activity", version: 1, activity: { requestId, phase, startedAt: 1000, waitingFor: "first-response", ...(phase === "settled" ? { outcome: "failed" } : {}), prompt: "SECRET" } } } })
   activity("connecting"); activity("quiet"); activity("streaming"); activity("settled")
   expect(live).toHaveLength(4)
   expect(JSON.stringify(live)).not.toContain("SECRET")
   expect((await f.diagnostics.list()).entries).toMatchObject([
     { kind: "model/settled", outcome: "failed" }, { kind: "model/quiet", waitingFor: "first-response" }, { kind: "model/connecting", waitingFor: "first-response" },
   ])
 })
 it("redacts hostile scope identifiers before live forwarding and keeps retry identity separate", async () => {
   const f = await fixture(); const live: unknown[] = []
   f.diagnostics.onActivity(value => live.push(value))
   f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "secret workspace", method: "session/event", params: { sessionId: "s", event: { type: "model/activity", version: 1, activity: { requestId: "physical", phase: "connecting", startedAt: 1000, waitingFor: "first-response" } } } })
   expect(live).toEqual([])
   f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/event", params: { sessionId: "s", event: { type: "model/retry", version: 1, retry: { requestId: "logical", phase: "waiting", attempt: 1, delayMs: 500, code: "TIMEOUT" } } } })
   f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/event", params: { sessionId: "s", event: { type: "model/activity", version: 1, activity: { requestId: "physical", phase: "connecting", startedAt: 1000, waitingFor: "first-response" } } } })
   f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/status", params: { sessionId: "s", status: "failed", error: "Model request timed out waiting for first response" } })
   expect((await f.diagnostics.list()).entries[0]).toMatchObject({ kind: "session/error", requestId: "logical", code: "TIMEOUT" })
   expect(live).toMatchObject([{ workspaceId: "ws", sessionId: "s", activity: { requestId: "physical" } }])
 })
 it("ignores stale logical recovery after another retry owns terminal attribution", async () => {
   const f = await fixture()
   const retry = (requestId: string, phase: "waiting" | "recovered") => f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/event", params: { sessionId: "s", event: { type: "model/retry", version: 1, retry: { requestId, phase, attempt: 1, delayMs: 500, code: "TIMEOUT" } } } })
   retry("old-logical", "waiting")
   retry("new-logical", "waiting")
   retry("old-logical", "recovered")
   f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/status", params: { sessionId: "s", status: "failed", error: "Model request timed out waiting for progress" } })
   expect((await f.diagnostics.list()).entries[0]).toMatchObject({ kind: "session/error", requestId: "new-logical", code: "TIMEOUT" })
 })
 it("classifies owned message-only timeout and abort statuses without exposing raw text", async () => {
   const f = await fixture()
   for (const [index, [message, code, kind]] of ([
     ["Model request timed out waiting for first response", "TIMEOUT", "session/error"],
     ["Model request timed out waiting for progress", "TIMEOUT", "session/error"],
     ["Model request aborted", "cancelled", "session/cancelled"],
   ] as const).entries()) {
     f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/event", params: { sessionId: "s", event: { type: "turn/start", seq: index + 1 } } })
     f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/status", params: { sessionId: "s", status: "failed", error: message } })
     expect((await f.diagnostics.list()).entries[0]).toMatchObject({ code, kind })
   }
 })
 it.each(["session/prompt", "desktop/session/input/submit"])("records runtime readiness rejection for %s before provider dispatch", async kind => {
   for (const sandbox of [false, true]) {
     const f = await fixture(), request = vi.fn()
     f.dependencies.runtimes.get = async () => ({ sandbox: { wired: sandbox }, info: { capabilities: {} }, client: { request } }) as never
     const input = { kind, workspaceId: "ws", sessionId: "s", prompt: "hello", text: "hello", delivery: "queue", context: "PRIVATE_CONTEXT" }
     await expect(dispatchDesktopRequest(input, f.dependencies)).rejects.toThrow(sandbox ? "Prompt context is not supported" : "sandbox-not-enabled")
     expect(request).not.toHaveBeenCalled()
     const { entries } = await f.diagnostics.list()
     expect(entries).toHaveLength(1)
     expect(entries[0]).toMatchObject({ level: "error", workspaceId: "ws", sessionId: "s" })
     expect(JSON.stringify(entries)).not.toContain("PRIVATE_CONTEXT")
   }
 })
 it("records manual compaction failure without replacing an active retry identity", async () => {
   const f = await fixture()
   f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/event", params: { sessionId: "s", event: { type: "model/retry", version: 1, retry: { requestId: "active-model", phase: "waiting", attempt: 1, delayMs: 500, code: "SERVER" } } } })
   f.dependencies.runtimes.get = async () => ({ info: { capabilities: {} }, client: { request: async () => { throw new Error("HTTP 503 PRIVATE_BODY") } } }) as never
   await expect(dispatchDesktopRequest({ kind: "desktop/session/compact", workspaceId: "ws", sessionId: "s" }, f.dependencies)).rejects.toThrow("HTTP 503")
   f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/status", params: { sessionId: "s", status: "failed", error: "HTTP 401" } })
   const { entries } = await f.diagnostics.list()
   expect(entries).toMatchObject([{ kind: "session/error", requestId: "active-model" }, { kind: "runtime/error", httpStatus: 503 }, { kind: "model/retry", requestId: "active-model" }])
   expect(entries[1]?.requestId).not.toBe("active-model")
   expect(JSON.stringify(entries)).not.toContain("PRIVATE_BODY")
 })
 it("routes bounded diagnostic actions and rejects paths, unsupported keys, malformed filters and IDs before callbacks", async () => {
   const f = await fixture()
   f.diagnostics.observe({ kind: "sdk/disconnected", workspaceId: "ws", message: "raw private stderr" })
   expect(await dispatchDesktopRequest({ kind: "desktop/diagnostics/list", workspaceId: "ws", level: "error", query: "gateway" }, f.dependencies)).toMatchObject({ entries: [{ kind: "gateway/disconnected" }] })
   for (const input of [{ kind: "desktop/diagnostics/export", path: "C:/secret" }, { kind: "desktop/diagnostics/reveal", path: "C:/secret" }, { kind: "desktop/diagnostics/copy", id: "../other" }, { kind: "desktop/diagnostics/list", level: "fatal" }, { kind: "desktop/diagnostics/list", workspaceId: "" }, { kind: "desktop/diagnostics/list", query: "x".repeat(257) }]) await expect(dispatchDesktopRequest(input, f.dependencies)).rejects.toThrow(/diagnostic/i)
 })
 it("proxies global retry settings without a workspace and rejects noninteger or out-of-range limits", async () => {
   const f = await fixture()
   expect(await dispatchDesktopRequest({ kind: "desktop/global-retry/state" }, f.dependencies)).toEqual({ maxRetries: 5 })
   for (const maxRetries of [0, 100]) await dispatchDesktopRequest({ kind: "desktop/global-retry/configure", maxRetries }, f.dependencies)
   expect(f.request.mock.calls).toEqual([["desktop/model-retry/state", {}], ["desktop/model-retry/configure", { maxRetries: 0 }], ["desktop/model-retry/configure", { maxRetries: 100 }]])
   for (const maxRetries of [-1, 101, 1.1, "5", null, NaN]) {
     await expect(dispatchDesktopRequest({ kind: "desktop/global-retry/configure", maxRetries }, f.dependencies)).rejects.toThrow(/retry/i)
     await expect(f.dependencies.globalProviders!.request({ kind: "desktop/global-retry/configure", maxRetries })).rejects.toThrow(/retry/i)
   }
   expect(f.request).toHaveBeenCalledTimes(3)
 })
 it("forwards sanitized live diagnostics across window lifetimes without recording twice", async () => {
   const f = await fixture(); const send = vi.fn(); const runtimeListeners = new Set<(event: DesktopEvent) => void>()
   f.dependencies.runtimes.onEvent = listener => { runtimeListeners.add(listener); return () => { runtimeListeners.delete(listener) } }
   // Application owns the sole observer; window registration owns delivery only.
   const offObserver = f.dependencies.runtimes.onEvent(f.diagnostics.observe)
   const window = { webContents: { send }, isDestroyed: () => false } as unknown as BrowserWindow
   const ipc = { handle() {}, removeHandler() {} } as IpcMainLike
   let offWindow = registerDesktopIpc(window, f.dependencies, ipc)
   for (const listener of runtimeListeners) listener({ kind: "sdk/disconnected", workspaceId: "ws", message: "private stderr" })
   expect(send.mock.calls.filter(call => call[1].kind === "runtime/diagnostic")).toHaveLength(1)
   offWindow(); offWindow = registerDesktopIpc(window, f.dependencies, ipc)
   for (const listener of runtimeListeners) listener({ kind: "sdk/disconnected", workspaceId: "ws", message: "private stderr" })
   expect((await f.diagnostics.list()).entries).toHaveLength(1)
   offWindow(); offObserver()
 })
 it("does not forward raw activity through the window event channel or revive it after terminal status", async () => {
   const f = await fixture(); const send = vi.fn(); const runtimeListeners = new Set<(event: DesktopEvent) => void>()
   f.dependencies.runtimes.onEvent = listener => { runtimeListeners.add(listener); return () => { runtimeListeners.delete(listener) } }
   const offObserver = f.dependencies.runtimes.onEvent(f.diagnostics.observe)
   const window = { webContents: { send }, isDestroyed: () => false } as unknown as BrowserWindow
   const offWindow = registerDesktopIpc(window, f.dependencies, { handle() {}, removeHandler() {} } as IpcMainLike)
   const emit = (event: DesktopEvent) => { for (const listener of runtimeListeners) listener(event) }
   const activity = (phase: "connecting" | "quiet") => emit({ kind: "sdk/notification", workspaceId: "ws", method: "session/event", params: { sessionId: "s", event: { type: "model/activity", version: 1, activity: { requestId: "physical", phase, startedAt: 1000, waitingFor: "first-response", prompt: "PRIVATE_PROMPT" } } } })
   activity("connecting")
   expect(send.mock.calls.filter(call => call[1].kind === "runtime/activity")).toHaveLength(1)
   expect(JSON.stringify(send.mock.calls)).not.toContain("PRIVATE_PROMPT")
   emit({ kind: "sdk/notification", workspaceId: "ws", method: "session/status", params: { sessionId: "s", status: "failed", error: "Model request timed out waiting for first response" } })
   activity("quiet")
   expect(send.mock.calls.filter(call => call[1].kind === "runtime/activity")).toHaveLength(1)
   offWindow(); offObserver()
 })
 it("captures runtime startup failure while preserving its original rejection and keeps validation inline", async () => {
   const f = await fixture()
   await expect(dispatchDesktopRequest({ kind: "session/prompt", workspaceId: "ws", sessionId: "s", prompt: "hello" }, f.dependencies)).rejects.toThrow("Startup failed")
   expect((await f.diagnostics.list()).entries).toMatchObject([{ kind: "runtime/error", workspaceId: "ws" }])
   await expect(dispatchDesktopRequest({ kind: "session/prompt", workspaceId: "ws", sessionId: "s", prompt: "" }, f.dependencies)).rejects.toThrow("prompt")
   expect((await f.diagnostics.list()).entries).toHaveLength(1)
 })
 it("records each rejected fresh prompt once even when its terminal status arrives before rejection", async () => {
   const f = await fixture()
   f.dependencies.runtimes.get = async () => ({ sandbox: { wired: true }, info: { capabilities: {} }, client: { request: async () => {
     f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/status", params: { sessionId: "s", status: "failed", error: "request failed: 401" } })
     throw new Error("request failed: 401")
   } } }) as never
   for (const clientToken of ["token-0001", "token-0001", "token-0002"]) await expect(dispatchDesktopRequest({ kind: "session/prompt", workspaceId: "ws", sessionId: "s", prompt: "hello", clientToken }, f.dependencies)).rejects.toThrow("request failed")
   expect((await f.diagnostics.list()).entries).toMatchObject([{ kind: "session/error", requestId: "token-0002" }, { kind: "session/error", requestId: "token-0001" }])
 })
 it("keeps local malformed admission validation inline before submitting any backend request", async () => {
   const f = await fixture()
   const request = vi.fn(async () => { throw new Error("invalid admission token") })
   f.dependencies.runtimes.get = async () => ({ sandbox: { wired: true }, info: { capabilities: {} }, client: { request } }) as never
   const valid = { kind: "desktop/session/input/submit", workspaceId: "ws", sessionId: "s", text: "hello", delivery: "queue" }
   for (const patch of [{ text: "" }, { delivery: "bad" }, { clientToken: "tiny" }, { context: 123 }]) await expect(dispatchDesktopRequest({ ...valid, ...patch }, f.dependencies)).rejects.toThrow()
   expect((await f.diagnostics.list()).entries).toEqual([])
   expect(request).not.toHaveBeenCalled()
 })
 it("records actual assemblyFor rejection before onStatus with fresh admission identity and repeated-token dedupe", async () => {
   const f = await fixture()
   const root = await mkdtemp(join(tmpdir(), "ih-admission-startup-")); roots.push(root)
   const coordinator = createSessionCoordinator(createJsonlBackend(root))
   await coordinator.create({ sessionId: "s" })
   const service = createSessionService({ workspace: root, coordinator, modelBindingFor: async () => ({ status: "invalid", reason: "model binding unavailable: private startup payload" }) })
   const statuses: unknown[] = []
   const input = createDesktopInput(coordinator, service, { onStatus: (...args) => statuses.push(args) })
   const frames: RpcMessage[] = []
   const sdk = createSdkServer(service, { onWrite: frame => frames.push(frame) })
   const router = createDesktopRouter(sdk, frame => frames.push(frame), { input })
   let requestId = 1
   const live: unknown[] = []
   f.diagnostics.onEntry(entry => live.push(entry))
   f.dependencies.runtimes.get = async () => ({ sandbox: { wired: true }, info: { capabilities: {} }, client: { request: async (method: string, params: object) => {
     const id = requestId++
     await router.handleLine(encodeFrame(makeRequest(id, method, params)))
     const frame = frames.find(row => "id" in row && row.id === id)
     if (isRpcFailure(frame)) throw new RpcError(frame.error.code, frame.error.message, frame.error.data)
     if (frame && "result" in frame) return frame.result
     throw new Error("Missing gateway response")
   } } }) as never
   try {
     await router.handleLine(encodeFrame(makeRequest(0, "initialize", {})))
     for (const clientToken of ["token-0001", "token-0001", "token-0002"]) await expect(dispatchDesktopRequest({ kind: "desktop/session/input/submit", workspaceId: "ws", sessionId: "s", text: "hello", delivery: "queue", clientToken }, f.dependencies)).rejects.toThrow("model binding unavailable")
     expect(statuses).toEqual([])
     const result = await f.diagnostics.list()
     expect(result.entries).toMatchObject([{ kind: "runtime/error", level: "error", workspaceId: "ws", sessionId: "s", requestId: "token-0002" }, { kind: "runtime/error", requestId: "token-0001" }])
     expect(live).toHaveLength(2)
     expect(JSON.stringify(result)).not.toContain("private startup payload")
     expect(JSON.stringify(live)).not.toContain("private startup payload")
   } finally { await router.close(); await input.close(); await service.close(); await coordinator.close() }
 })
 it("records submitted backend admission rejection without changing the running turn's failure attribution", async () => {
   const f = await fixture()
   f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/event", params: { sessionId: "s", event: { type: "turn/start", seq: 1 } } })
   f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/event", params: { sessionId: "s", event: { type: "model/retry", version: 1, retry: { requestId: "active-model", phase: "waiting", attempt: 1, delayMs: 500, code: "SERVER" } } } })
   f.dependencies.runtimes.get = async () => ({ sandbox: { wired: true }, info: { capabilities: {} }, client: { request: async () => { throw new RpcError(-32602, "invalid admission token") } } }) as never
   await expect(dispatchDesktopRequest({ kind: "desktop/session/input/submit", workspaceId: "ws", sessionId: "s", text: "hello", delivery: "queue", clientToken: "queued-token" }, f.dependencies)).rejects.toThrow("invalid admission token")
   f.diagnostics.observe({ kind: "sdk/notification", workspaceId: "ws", method: "session/status", params: { sessionId: "s", status: "failed", error: "HTTP 401" } })
   const result = await f.diagnostics.list()
   expect(result.entries).toMatchObject([{ kind: "session/error", requestId: "active-model" }, { kind: "runtime/error", requestId: "queued-token" }, { kind: "model/retry", requestId: "active-model" }])
   expect(JSON.stringify(result)).not.toContain("invalid admission token")
 })
})
