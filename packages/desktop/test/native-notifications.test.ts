import { expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow } from "electron"
import { createLocalPreferences } from "../src/main/local-preferences.ts"
import { createNotificationHistory } from "../src/main/notification-history.ts"
import { DESKTOP_EVENT_CHANNEL } from "../src/shared/bridge.ts"
import { notificationTarget } from "../src/main/notification-event.ts"
import { readNotificationRules } from "../src/shared/notification-preferences.ts"
const emitted = vi.hoisted(() => ({ values: [] as { title: string; body: string }[], clicks: [] as (() => void)[], beep: vi.fn() }))
vi.mock("electron", () => ({
  Notification: class {
    static isSupported() { return true }
    constructor(value: { title: string; body: string }) { emitted.values.push(value) }
    on(name: string, listener: () => void) { if (name === "click") emitted.clicks.push(listener) }
    show() {}
  },
  shell: { beep: emitted.beep },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}))
import { attachNativeWindow } from "../src/main/native-window.ts"
it("notifies only opted-in background requests, deduplicates, and excludes request content", () => {
  emitted.values.length = 0
  let focused = true
  const window = { on: vi.fn(), isDestroyed: () => false, isFocused: () => focused } as unknown as BrowserWindow
  const state = { notifications: false, locale: "en" as const, notificationRules: readNotificationRules() }
  const prefs = { get: () => state, update: vi.fn() } as unknown as ReturnType<typeof createLocalPreferences>
  const native = attachNativeWindow(window, prefs)
  const event = { kind: "sdk/notification" as const, workspaceId: "w", method: "desktop/interaction/request" as const, params: { requestId: "r", payload: { secret: "private prompt" } } }
  native.onEvent(event)
  state.notifications = true
  native.onEvent(event)
  expect(emitted.values).toHaveLength(0)
  focused = false
  native.onEvent(event); native.onEvent(event)
  expect(emitted.values).toEqual([{ title: "I-harness", body: "A conversation needs your attention." }])
})

it("restores a hidden or minimized window and routes each private notification to its original workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-native-notify-"))
  try {
    emitted.clicks.length = 0
    emitted.values.length = 0
    emitted.beep.mockClear()
    const prefs = createLocalPreferences(join(root, "prefs.json"))
    const history = createNotificationHistory(join(root, "notifications.json"))
    await prefs.update({ notifications: true, locale: "en", notificationRule: { event: "question", sound: "off" } })
    await prefs.update({ notificationRule: { event: "completed", enabled: false, sound: "system" } })
    const send = vi.fn()
    const window = { on: vi.fn(), isDestroyed: () => false, isFocused: () => false, isMinimized: () => true,
      restore: vi.fn(), show: vi.fn(), focus: vi.fn(), webContents: { isDestroyed: () => false, send } }
    const native = attachNativeWindow(window as unknown as BrowserWindow, prefs, { notifications: history })
    for (const workspaceId of ["left", "right"]) native.onEvent({ kind: "sdk/notification", workspaceId, method: "desktop/interaction/request", params: {
      sessionId: "same", requestId: "same-request", kind: "question", payload: { question: "private content" },
    } })
    native.onEvent({ kind: "sdk/notification", workspaceId: "right", method: "session/status", params: { sessionId: "same", status: "completed" } })
    await history.flush()
    expect(emitted.values).toHaveLength(2)
    expect(emitted.values[0]).toMatchObject({ silent: true })
    expect(emitted.beep).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(DESKTOP_EVENT_CHANNEL, { kind: "notifications/changed" })
    emitted.clicks[1]!()
    expect(window.restore).toHaveBeenCalledOnce(); expect(window.show).toHaveBeenCalledOnce(); expect(window.focus).toHaveBeenCalledOnce()
    expect(send).toHaveBeenLastCalledWith(DESKTOP_EVENT_CHANNEL, { kind: "notifications/open", workspaceId: "right", sessionId: "same", id: "right:same-request" })
    const view = await history.list()
    expect(view.items.map(row => row.kind)).toEqual(["completed", "question", "question"])
    expect(JSON.stringify([emitted.values, view])).not.toContain("private content")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it("returns the accepted follow-up delivery in native state and restores it after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "ih-native-followup-"))
  try {
    const file = join(root, "prefs.json")
    const window = { on: vi.fn() } as unknown as BrowserWindow
    const native = attachNativeWindow(window, createLocalPreferences(file))
    expect(native.state().followupDelivery).toBe("queue")
    expect((await native.configure({ followupDelivery: "steer" })).followupDelivery).toBe("steer")
    const restored = attachNativeWindow(window, createLocalPreferences(file))
    expect(restored.state().followupDelivery).toBe("steer")
    await expect(restored.configure({ followupDelivery: "other" } as never)).rejects.toThrow(/follow.*delivery/i)
    expect(restored.state().followupDelivery).toBe("steer")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it("classifies session and child outcomes once per terminal event without exposing its payload", () => {
  const outcome = (outcome: string, workspaceId = "w") => notificationTarget({
    kind: "sdk/notification", method: "session/event", workspaceId,
    params: { sessionId: "s", event: { type: "subagent/end", taskId: "child", outcome, error: "private detail" } },
  })
  expect(outcome("completed")?.kind).toBe("completed")
  expect(outcome("error")?.kind).toBe("error")
  expect(outcome("recovery-required")).toEqual(outcome("recovery-required"))
  expect(outcome("recovery-required")).toMatchObject({ kind: "attention", workspaceId: "w", sessionId: "s" })
  expect(outcome("cancelled")).toBeUndefined()
  expect(outcome("error", "other")?.id).not.toBe(outcome("error")?.id)
  expect(JSON.stringify(outcome("error"))).not.toContain("private detail")
  const status = (state: string, errorCode?: string) => notificationTarget({ kind: "sdk/notification", method: "session/status", workspaceId: "w", params: { sessionId: "s", status: state, errorCode } })
  expect(status("queued")).toBeUndefined()
  expect(status("error", "FACT_RECOVERY_REQUIRED")?.kind).toBe("attention")
  expect(status("error")?.kind).toBe("error")
  expect(notificationTarget({ kind: "sdk/notification", method: "session/status", workspaceId: "w", params: { sessionId: "s", status: "completed" } }, () => true)).toBeUndefined()
  expect(notificationTarget({ kind: "sdk/notification", method: "session/status", workspaceId: "w", params: { sessionId: "s", status: "error", modelFailure: { code: "ABORTED" } } })).toBeUndefined()
})
