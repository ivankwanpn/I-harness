import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow } from "electron"
import { expect, it, vi } from "vitest"
import { attachCloseLifecycle } from "../src/main/close-lifecycle.ts"
import { createLocalPreferences } from "../src/main/local-preferences.ts"
import { attachNativeWindow } from "../src/main/native-window.ts"

const gate = vi.hoisted(() => ({ file: "", started: false, release: Promise.withResolvers<void>() }))
vi.mock("electron", () => ({ Notification: {}, screen: {} }))
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>()
  return { ...fs, async rename(from: string, to: string) {
    if (to === gate.file) { gate.started = true; await gate.release.promise }
    return fs.rename(from, to)
  } }
})

it("dismisses before a held preference write, and flushes the pre-dismissal geometry", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-pref-close-"))
  gate.file = join(root, "preferences.json")
  const prefs = createLocalPreferences(gate.file)
  const events = new EventEmitter(), bounds = { x: 150, y: 30, width: 900, height: 640 }
  let hidden = false, destroyed = false
  const window = Object.assign(events, {
    isDestroyed: () => destroyed, isVisible: () => !hidden, isMinimized: () => false,
    isMaximized: () => false, getNormalBounds: () => bounds, hide() { hidden = true },
    close() {
      let intercepted = false
      events.emit("close", { preventDefault() { intercepted = true } })
      if (!intercepted) { destroyed = true; events.emit("closed") }
    },
  }) as unknown as BrowserWindow
  attachNativeWindow(window, prefs)
  attachCloseLifecycle(window, { hasActiveWork: async () => false, trayAvailable: () => true, quitState: () => "running" })
  try {
    window.close()
    expect(hidden).toBe(true)
    await vi.waitFor(() => expect(gate.started).toBe(true))
    expect(destroyed).toBe(true)
    const pending = prefs.flush()
    expect(prefs.get().bounds).toBeUndefined()
    gate.release.resolve()
    await pending
    expect(JSON.parse(await readFile(gate.file, "utf8")).bounds).toEqual(bounds)
  } finally { gate.release.resolve(); await prefs.flush(); await rm(root, { recursive: true, force: true }) }
})
