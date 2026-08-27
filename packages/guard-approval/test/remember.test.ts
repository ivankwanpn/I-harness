import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { createRememberStore, BANNED_PREFIX_PATTERNS } from "../src/remember.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "i-harness-remember-"))
  file = join(dir, "rules.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("createRememberStore", () => {
  it("prefix rule matches command argv", () => {
    const store = createRememberStore(file)
    store.add({ prefix: ["git", "commit"], createdAt: new Date().toISOString() })
    expect(store.matches(["git", "commit", "-m"])).toBe(true)
    expect(store.matches(["git", "pull"])).toBe(false)
  })
  it("persists to JSON across instances", () => {
    const store = createRememberStore(file)
    store.add({ prefix: ["git", "push"], createdAt: new Date().toISOString() })
    const store2 = createRememberStore(file)
    expect(store2.matches(["git", "push", "--force"])).toBe(true)
  })
  it("rejects banned shell prefixes", () => {
    const store = createRememberStore(file)
    const r = store.add({ prefix: ["bash", "-c"], createdAt: new Date().toISOString() })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/shell|interpret/)
  })
  it("banned list has bash/cmd/pwsh", () => {
    expect(BANNED_PREFIX_PATTERNS.some((b) => b[0] === "bash")).toBe(true)
    expect(BANNED_PREFIX_PATTERNS.some((b) => b[0] === "cmd")).toBe(true)
    expect(BANNED_PREFIX_PATTERNS.some((b) => b[0] === "pwsh")).toBe(true)
  })
})
