import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createLocalPreferences, restoreBounds } from "../src/main/local-preferences.ts"
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
it("restores disconnected-monitor bounds onto the current display", () => {
  const result = restoreBounds({ x: 3000, y: 500, width: 1400, height: 1000 }, [{ x: 0, y: 0, width: 1280, height: 720 }])
  expect(result).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
})
it("preserves a valid secondary display with negative coordinates", () => {
  const bounds = { x: -1100, y: 50, width: 800, height: 600 }
  expect(restoreBounds(bounds, [{ x: 0, y: 0, width: 1280, height: 720 }, { x: -1280, y: 0, width: 1280, height: 720 }])).toEqual(bounds)
})
it("persists UI-only preferences and tolerates a damaged file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ih-window-test-")); directories.push(dir)
  const file = join(dir, "prefs.json")
  writeFileSync(file, "not json")
  const prefs = createLocalPreferences(file)
  expect(prefs.get().notifications).toBe(false)
  await prefs.update({ notifications: true, locale: "en", terminalShell: "git-bash", terminalFontFamily: "Cascadia Code, monospace", bounds: { x: 10, y: 20, width: 900, height: 700 } })
  expect(createLocalPreferences(file).get()).toMatchObject({ notifications: true, locale: "en", terminalShell: "git-bash", terminalFontFamily: "Cascadia Code, monospace", bounds: { x: 10 } })
  expect(JSON.parse(readFileSync(file, "utf8")).notifications).toBe(true)
})

it.each(["queue", "steer"] as const)("persists follow-up delivery %s across a preference reload", async (followupDelivery) => {
  const dir = mkdtempSync(join(tmpdir(), "ih-followup-pref-")); directories.push(dir)
  const file = join(dir, "prefs.json")
  const prefs = createLocalPreferences(file)
  expect(prefs.get().followupDelivery).toBe("queue")
  await prefs.update({ followupDelivery })
  expect(createLocalPreferences(file).get().followupDelivery).toBe(followupDelivery)
})

it("defaults legacy or invalid saved follow-up settings to queue and rejects invalid updates without persisting them", () => {
  const dir = mkdtempSync(join(tmpdir(), "ih-followup-invalid-")); directories.push(dir)
  const file = join(dir, "prefs.json")
  writeFileSync(file, JSON.stringify({ notifications: true, followupDelivery: "other" }))
  const prefs = createLocalPreferences(file)
  expect(prefs.get()).toMatchObject({ notifications: true, followupDelivery: "queue" })
  expect(() => prefs.update({ followupDelivery: "other" } as never)).toThrow(/follow.*delivery/i)
  expect(JSON.parse(readFileSync(file, "utf8")).followupDelivery).toBe("other")
  writeFileSync(file, JSON.stringify({ locale: "en" }))
  expect(createLocalPreferences(file).get()).toMatchObject({ locale: "en", followupDelivery: "queue" })
})

it("merges queued geometry and setting writes and preserves the captured bounds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ih-pref-order-")); directories.push(dir)
  const file = join(dir, "prefs.json"), prefs = createLocalPreferences(file)
  const bounds = { x: 11, y: 22, width: 900, height: 600 }
  const first = prefs.update({ bounds, maximized: true })
  bounds.x = 55
  const second = prefs.update({ locale: "en" })
  await prefs.flush()
  expect(await first).toMatchObject({ locale: "zh-TW", bounds: { x: 11 } })
  expect(await second).toMatchObject({ locale: "en", bounds: { x: 11 } })
  expect(createLocalPreferences(file).get()).toEqual(prefs.get())
})

it("a failed write does not commit its patch or block later writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ih-pref-failure-")); directories.push(dir)
  const parent = join(dir, "profile"), file = join(parent, "prefs.json")
  writeFileSync(parent, "occupied")
  const prefs = createLocalPreferences(file)
  await expect(prefs.update({ notifications: true })).rejects.toThrow()
  expect(prefs.get().notifications).toBe(false)
  rmSync(parent)
  await prefs.update({ locale: "en" })
  expect(createLocalPreferences(file).get()).toMatchObject({ notifications: false, locale: "en" })
})

it("keeps legacy opt-in limited to approvals and questions and merges simultaneous event preference changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ih-pref-notification-")); directories.push(dir)
  const file = join(dir, "prefs.json")
  writeFileSync(file, JSON.stringify({ notifications: true }))
  const prefs = createLocalPreferences(file)
  expect(prefs.get().notificationRules).toEqual({
    approval: { enabled: true, sound: "system" }, question: { enabled: true, sound: "system" },
    completed: { enabled: false, sound: "off" }, attention: { enabled: false, sound: "off" }, error: { enabled: false, sound: "off" },
  })
  await Promise.all([prefs.update({ notificationRule: { event: "completed", enabled: true } }),
    prefs.update({ notificationRule: { event: "completed", sound: "system" } }), prefs.update({ notificationRule: { event: "error", enabled: true } })])
  const restored = createLocalPreferences(file)
  expect(restored.get().notificationRules).toMatchObject({ completed: { enabled: true, sound: "system" }, error: { enabled: true, sound: "off" } })
  expect(() => restored.update({ notificationRule: { event: "other", sound: "off" } } as never)).toThrow("Invalid notification preference")
})
