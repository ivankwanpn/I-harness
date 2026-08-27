import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireSessionLock, lockPathFor, SessionLockConflictError, SessionLockUnsupportedError } from "../src/index.ts"

describe.skipIf(process.platform !== "win32")("acquireSessionLock (win32)", () => {
  let root: string
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "i-harness-fs-lock-")) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("acquires, second acquire conflicts (fail-closed)", async () => {
    const path = lockPathFor(root, "sess-1")
    const a = await acquireSessionLock({ lockPath: path })
    try {
      expect(a.held).toBe(true)
      await expect(acquireSessionLock({ lockPath: path, retryMs: 5, deadlineMs: 50 })).rejects.toThrow(SessionLockConflictError)
    } finally {
      await a.release()
    }
  })
  it("releases then re-acquires", async () => {
    const path = lockPathFor(root, "sess-2")
    const a = await acquireSessionLock({ lockPath: path })
    await a.release()
    expect(a.held).toBe(false)
    const b = await acquireSessionLock({ lockPath: path })
    await b.release()
  })
  it("release is idempotent", async () => {
    const path = lockPathFor(root, "sess-3")
    const a = await acquireSessionLock({ lockPath: path })
    await a.release()
    await a.release() // no throw
  })
  it("lockPathFor puts lock under store root .i-harness-locks", () => {
    expect(lockPathFor(root, "sess-x").startsWith(join(root, ".i-harness-locks"))).toBe(true)
  })
})

describe("acquireSessionLock (non-win32) — included for skipIf complement", () => {
  it.skipIf(process.platform === "win32")("throws SessionLockUnsupportedError", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-fs-lock-"))
    try {
      await expect(acquireSessionLock({ lockPath: join(root, "x.lock") })).rejects.toThrow(SessionLockUnsupportedError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
