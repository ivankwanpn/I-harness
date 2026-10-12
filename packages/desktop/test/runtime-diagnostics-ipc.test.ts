import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow } from "electron"
import { createRuntimeDiagnostics } from "../src/main/runtime-diagnostics.ts"
import { createGlobalProviderSettings } from "../src/main/global-provider-settings.ts"
import { dispatchDesktopRequest, registerDesktopIpc, type DesktopIpcDependencies, type IpcMainLike } from "../src/main/ipc.ts"
import type { DesktopEvent } from "../src/shared/bridge.ts"
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "ih-diagnostic-ipc-")); roots.push(root)
 const diagnostics = createRuntimeDiagnostics(root)
 const request = vi.fn(async () => ({ maxRetries: 5 }))
 const globalProviders = createGlobalProviderSettings(async () => ({ request }))
 const dependencies = { diagnostics, globalProviders, catalog: { get: (id: string) => id === "ws" ? { id, path: root } : undefined }, runtimes: { get: async () => { throw new Error("Startup failed: raw body") }, onEvent: () => () => {} } } as unknown as DesktopIpcDependencies
 return { dependencies, diagnostics, request }
}
describe("native diagnostic IPC", () => {
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
 it("keeps an admission validation rejection from becoming a model error popup", async () => {
   const f = await fixture()
   f.dependencies.runtimes.get = async () => ({ sandbox: { wired: true }, info: { capabilities: {} }, client: { request: async () => { throw new Error("invalid admission token") } } }) as never
   await expect(dispatchDesktopRequest({ kind: "desktop/session/input/submit", workspaceId: "ws", sessionId: "s", text: "hello", delivery: "queue" }, f.dependencies)).rejects.toThrow("invalid admission")
   expect((await f.diagnostics.list()).entries).toEqual([])
 })
})
