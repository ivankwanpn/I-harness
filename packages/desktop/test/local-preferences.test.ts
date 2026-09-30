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
it("persists UI-only preferences and tolerates a damaged file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ih-window-test-")); directories.push(dir)
  const file = join(dir, "prefs.json")
  writeFileSync(file, "not json")
  const prefs = createLocalPreferences(file)
  expect(prefs.get().notifications).toBe(false)
  prefs.update({ notifications: true, locale: "en", terminalShell: "git-bash", terminalFontFamily: "Cascadia Code, monospace", bounds: { x: 10, y: 20, width: 900, height: 700 } })
  expect(createLocalPreferences(file).get()).toMatchObject({ notifications: true, locale: "en", terminalShell: "git-bash", terminalFontFamily: "Cascadia Code, monospace", bounds: { x: 10 } })
  expect(JSON.parse(readFileSync(file, "utf8")).notifications).toBe(true)
})

it.each(["queue", "steer"] as const)("persists follow-up delivery %s across a preference reload", (followupDelivery) => {
  const dir = mkdtempSync(join(tmpdir(), "ih-followup-pref-")); directories.push(dir)
  const file = join(dir, "prefs.json")
  const prefs = createLocalPreferences(file)
  expect(prefs.get().followupDelivery).toBe("queue")
  prefs.update({ followupDelivery })
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
