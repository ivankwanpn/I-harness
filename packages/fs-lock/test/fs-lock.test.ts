import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, toNamespacedPath } from "node:path"
import { acquireSessionLock, lockPathFor, SessionLockConflictError, SessionLockUnsupportedError, type SessionLock } from "../src/index.ts"

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
  it("keeps the same native exclusion through a long logical path and its namespace form", async () => {
    const longRoot = join(root, ...Array.from({ length: 3 }, () => "nested-owned-path-".repeat(5)))
    mkdirSync(longRoot, { recursive: true })
    const path = lockPathFor(longRoot, "long-path-session")
    expect(path.length).toBeGreaterThan(300)
    let first: SessionLock | undefined, second: SessionLock | undefined
    const unexpected: SessionLock[] = []
    let primary: { cause: unknown } | undefined
    try {
      first = await acquireSessionLock({ lockPath: path })
      expect(first.held).toBe(true)
      const conflict = await acquireSessionLock({ lockPath: path, retryMs: 5, retryMaxMs: 5, deadlineMs: 50 })
        .then(lease => { unexpected.push(lease); return undefined }, cause => cause)
      expect(conflict).toBeInstanceOf(SessionLockConflictError)
      expect(conflict.message).toContain(path)
      const aliasConflict = await acquireSessionLock({ lockPath: toNamespacedPath(path), retryMs: 5, deadlineMs: 50 })
        .then(lease => { unexpected.push(lease); return undefined }, cause => cause)
      expect(aliasConflict).toBeInstanceOf(SessionLockConflictError)
      await first.release()
      expect(first.held).toBe(false)
      second = await acquireSessionLock({ lockPath: path })
      expect(second.held).toBe(true)
      await second.release()
      expect(second.held).toBe(false)
    } catch (cause) { primary = { cause } }
    finally {
      const failures: unknown[] = []
      for (const lease of [...unexpected, second, first]) {
        try { await lease?.release() } catch (cause) { if (!primary || cause !== primary.cause) failures.push(cause) }
      }
      if (primary && !failures.length) throw primary.cause
      if (failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], "Original long-path lease cleanup failed", { cause: primary?.cause })
    }
  })
  it("lockPathFor puts lock under store root .i-harness-locks", () => {
    expect(lockPathFor(root, "sess-x").startsWith(join(root, ".i-harness-locks"))).toBe(true)
  })
})

describe.skipIf(process.platform !== "linux")("acquireSessionLock (linux)", () => {
  let root: string
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "i-harness-fs-lock-")) })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("acquires, second acquire conflicts (fail-closed, real OS arbitration)", async () => {
    const path = lockPathFor(root, "sess-1")
    const a = await acquireSessionLock({ lockPath: path })
    try {
      expect(a.held).toBe(true)
      // Two independent opens = two open file descriptions → flock(LOCK_EX|LOCK_NB)
      // returns EAGAIN even in-process; the tight deadline proves the acquire is
      // non-blocking (a blocking flock would hang past 50ms instead of failing).
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

describe("acquireSessionLock (non-win32/non-linux) — included for skipIf complement", () => {
  // linux now HAS a binding, so the unsupported-platform complement only covers
  // the platforms that still fail closed (darwin, freebsd, ...).
  it.skipIf(process.platform === "win32" || process.platform === "linux")("throws SessionLockUnsupportedError", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-fs-lock-"))
    try {
      await expect(acquireSessionLock({ lockPath: join(root, "x.lock") })).rejects.toThrow(SessionLockUnsupportedError)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
