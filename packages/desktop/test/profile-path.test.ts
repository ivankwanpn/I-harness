import { join } from "node:path"
import { expect, it } from "vitest"
import { resolveDesktopProfilePath } from "../src/main/profile-path.ts"

it("reuses legacy conversation data when the renamed default has only local preferences", () => {
  const root = "C:/owned/app-data", current = join(root, "I-harness"), legacy = join(root, "I-harness Desktop")
  const files = new Set([join(current, "desktop-preferences.json"), join(legacy, "workspaces.json"), join(legacy, "sessions")])
  expect(resolveDesktopProfilePath(root, current, path => files.has(path))).toBe(legacy)
})
it("keeps established current history and explicitly selected data paths", () => {
  const root = "C:/owned/app-data", current = join(root, "I-harness"), custom = "D:/owned/profile"
  expect(resolveDesktopProfilePath(root, current, () => true)).toBe(current)
  expect(resolveDesktopProfilePath(root, custom, () => true)).toBe(custom)
})
it("uses the renamed default on a fresh installation", () => {
  const root = "C:/owned/app-data", current = join(root, "I-harness")
  expect(resolveDesktopProfilePath(root, current, () => false)).toBe(current)
})

it("respects an explicit user-data-dir even when it selects the empty renamed default", () => {
  const root = "C:/owned/app-data", current = join(root, "I-harness"), legacy = join(root, "I-harness Desktop")
  const files = new Set([join(legacy, "workspaces.json"), join(legacy, "sessions")])
  expect(resolveDesktopProfilePath(root, current, path => files.has(path), true)).toBe(current)
})
