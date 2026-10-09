import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import type { DesktopEvent } from "../src/shared/bridge.ts"
import { DESKTOP_EVENT_CHANNEL } from "../src/shared/bridge.ts"
import { dispatchDesktopRequest, registerDesktopIpc, type DesktopIpcDependencies, type IpcMainLike } from "../src/main/ipc.ts"
import type { createLocalPreferences } from "../src/main/local-preferences.ts"

vi.mock("electron", () => ({
  Notification: class { static isSupported() { return true } },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}))
import { attachNativeWindow } from "../src/main/native-window.ts"

afterEach(() => vi.useRealTimers())

function fixture(initialMaximized = false) {
  const events = new EventEmitter()
  let maximized = initialMaximized
  let destroyed = false
  const controls: string[] = []
  const deliveries: { channel: string; event: DesktopEvent }[] = []
  const preferences = { notifications: false, maximized: !initialMaximized, locale: "en" as const }
  const updates: unknown[] = []
  const window = {
    on: events.on.bind(events), removeListener: events.removeListener.bind(events),
    isMaximized: () => maximized, isDestroyed: () => destroyed,
    getNormalBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }),
    minimize: () => { controls.push("minimize") },
    maximize: () => { controls.push("maximize"); maximized = true; events.emit("maximize") },
    unmaximize: () => { controls.push("unmaximize"); maximized = false; events.emit("unmaximize") },
    close: () => { controls.push("close"); events.emit("close") },
    setBounds: () => { controls.push("setBounds") },
    webContents: { send: (channel: string, event: DesktopEvent) => { deliveries.push({ channel, event }) } },
  } as unknown as BrowserWindow
  const prefs = { get: () => preferences, update: (patch: unknown) => { updates.push(patch) } } as unknown as ReturnType<typeof createLocalPreferences>
  const native = attachNativeWindow(window, prefs)
  const catalogGet = vi.fn()
  const runtimeGet = vi.fn()
  const sdkEvents = new EventEmitter()
  const dependencies = {
    native,
    catalog: { get: catalogGet },
    runtimes: { get: runtimeGet, onEvent: (listener: (event: DesktopEvent) => void) => { sdkEvents.on("event", listener); return () => { sdkEvents.off("event", listener) } } },
  } as unknown as DesktopIpcDependencies
  let handler!: (event: { sender: unknown }, request: unknown) => Promise<unknown>
  const ipc: IpcMainLike = { handle: (_channel, listener) => { handler = listener as typeof handler }, removeHandler: () => {} }
  const unregister = registerDesktopIpc(window, dependencies, ipc)
  return {
    dependencies, events, deliveries, controls, preferences, updates, catalogGet, runtimeGet, sdkEvents, unregister,
    request: (request: unknown) => handler({ sender: window.webContents }, request),
    foreignRequest: (request: unknown) => handler({ sender: {} }, request),
    externalState(value: boolean) { maximized = value; events.emit(value ? "maximize" : "unmaximize") },
    destroy() { destroyed = true },
  }
}

it("reads the owned BrowserWindow state independently from saved preferences and caller workspace fields", async () => {
  const f = fixture(false)
  try {
    expect(f.preferences.maximized).toBe(true)
    expect(await f.request({ kind: "window/state", workspaceId: "foreign", maximized: true })).toEqual({ maximized: false })
    f.externalState(true)
    expect(await f.request({ kind: "window/state" })).toEqual({ maximized: true })
    expect(f.catalogGet).not.toHaveBeenCalled()
    expect(f.runtimeGet).not.toHaveBeenCalled()
    await expect(f.foreignRequest({ kind: "window/state" })).rejects.toThrow("untrusted IPC sender")
    await expect(f.foreignRequest({ kind: "window/control", action: "toggle-maximize" })).rejects.toThrow("untrusted IPC sender")
    expect(f.controls).toEqual([])
  } finally { f.unregister() }
})

it("delivers actual external maximize and restore events only while the window IPC owner is active", () => {
  const f = fixture()
  f.externalState(true)
  f.externalState(false)
  expect(f.deliveries).toEqual([
    { channel: DESKTOP_EVENT_CHANNEL, event: { kind: "window/state", maximized: true } },
    { channel: DESKTOP_EVENT_CHANNEL, event: { kind: "window/state", maximized: false } },
  ])
  f.destroy()
  f.externalState(true)
  expect(f.deliveries).toHaveLength(2)
  f.unregister(); f.unregister()
  expect(f.events.listenerCount("maximize")).toBe(0)
  expect(f.events.listenerCount("unmaximize")).toBe(0)
  expect(f.sdkEvents.listenerCount("event")).toBe(0)
  f.externalState(false)
  expect(f.deliveries).toHaveLength(2)
})

it("returns and publishes actual control results while retaining minimize, close and bounds reset behavior", async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    expect(await f.request({ kind: "window/control", action: "toggle-maximize" })).toEqual({ maximized: true })
    expect(await f.request({ kind: "window/control", action: "minimize" })).toEqual({ maximized: true })
    expect(await f.request({ kind: "window/reset-bounds" })).toEqual({ reset: true })
    expect(await f.request({ kind: "window/state" })).toEqual({ maximized: false })
    expect(f.deliveries.map(({ event }) => event)).toEqual([{ kind: "window/state", maximized: true }, { kind: "window/state", maximized: false }])
    expect(f.controls).toEqual(["maximize", "minimize", "unmaximize", "setBounds"])
    expect(await f.request({ kind: "window/control", action: "close" })).toEqual({ maximized: false })
    expect(f.controls).not.toContain("close")
    vi.runAllTimers()
    expect(f.controls.at(-1)).toBe("close")
    expect(f.updates.at(-1)).toEqual({ bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: false })
  } finally { f.unregister() }
})

it("rejects a state request when no native window exists", async () => {
  await expect(dispatchDesktopRequest({ kind: "window/state" }, {} as DesktopIpcDependencies)).rejects.toThrow("native window unavailable")
})
