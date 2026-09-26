import { expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import { createLocalPreferences } from "../src/main/local-preferences.ts"
const emitted = vi.hoisted(() => ({ values: [] as { title: string; body: string }[] }))
vi.mock("electron", () => ({
  Notification: class {
    static isSupported() { return true }
    constructor(value: { title: string; body: string }) { emitted.values.push(value) }
    on() {}
    show() {}
  },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}))
import { attachNativeWindow } from "../src/main/native-window.ts"
it("notifies only opted-in background requests, deduplicates, and excludes request content", () => {
  emitted.values.length = 0
  let focused = true
  const window = { on: vi.fn(), isDestroyed: () => false, isFocused: () => focused } as unknown as BrowserWindow
  const state = { notifications: false, locale: "en" as const }
  const prefs = { get: () => state, update: vi.fn() } as unknown as ReturnType<typeof createLocalPreferences>
  const native = attachNativeWindow(window, prefs)
  const event = { kind: "sdk/notification" as const, workspaceId: "w", method: "desktop/interaction/request" as const, params: { requestId: "r", payload: { secret: "private prompt" } } }
  native.onEvent(event)
  state.notifications = true
  native.onEvent(event)
  expect(emitted.values).toHaveLength(0)
  focused = false
  native.onEvent(event); native.onEvent(event)
  expect(emitted.values).toEqual([{ title: "I-harness Desktop", body: "A conversation needs your attention." }])
})
