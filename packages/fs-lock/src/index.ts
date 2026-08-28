/**
 * Session ownership lease primitive (M23). One process owns a session's write
 * lease: a process-level EXCLUSIVE OS byte-range lock held for the writer's
 * whole lifetime. The OS handle lock auto-releases on process death, so there
 * is NO stale-lock problem (unlike a lockfile+PID scheme, whose orphaned file
 * deadlocks every later writer).
 *
 * Attribution: absorbed codex `thread-store/src/local/writer_lock.rs`
 * (std File::try_lock + WouldBlock→Conflict fail-closed semantics) and the
 * LockFileEx pattern from `@i-harness/sandbox-windows-acl` (`acl.ts:75-110`
 * withPathLock + `ffi.ts` binding table, including the zeroed-OVERLAPPED
 * gotcha — koffi 3.1.x crashes on NULL lpOverlapped). Rewritten as the
 * I-harness lease: non-blocking acquire + JS backoff retry. MIT attribution
 * in THIRD_PARTY_NOTICES (OpenAI codex-rs + huoyaoyuan windows-acl-restrict-poc).
 *
 * Structure: errors live in ./errors.ts; this module re-exports them and
 * dynamically imports ./win32.ts or ./linux.ts (each imports ONLY errors.ts
 * at runtime) so every other platform never loads koffi and no runtime import
 * cycle forms.
 * @module @i-harness/fs-lock
 */
import { mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"

import { SessionLockConflictError, SessionLockUnsupportedError } from "./errors.ts"

export { SessionLockConflictError, SessionLockUnsupportedError }

/** Options for {@link acquireSessionLock}. */
export interface AcquireOptions {
  lockPath: string
  /** Initial backoff sleep between acquire attempts (default 20). */
  retryMs?: number
  /** Backoff ceiling (default 200). */
  retryMaxMs?: number
  /** Total time budget before declaring the lease conflicted (default 2000). */
  deadlineMs?: number
}

/** A held ownership lease. `release()` is idempotent (already-released → no-op). */
export interface SessionLock {
  release(): Promise<void> | void
  readonly held: boolean
}

/**
 * Deterministic lock path for a session, under the STORE root (not %TEMP%):
 * `<storeRoot>/.i-harness-locks/<sha256(sessionId).slice(0,24)>.lock`. The
 * hash keeps session ids filesystem-safe; the root rides the store's
 * lifecycle so locks die with their store.
 * @param storeRoot - the session store's root directory.
 * @param sessionId - raw session id (any string).
 * @returns the lock file path for that session.
 */
export function lockPathFor(storeRoot: string, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 24)
  return join(storeRoot, ".i-harness-locks", `${digest}.lock`)
}

/**
 * Acquire the session's exclusive ownership lease. Non-blocking at the OS
 * level (win32 LOCKFILE_FAIL_IMMEDIATELY / linux flock LOCK_NB) with a JS
 * backoff retry loop: retryMs →
 * retryMaxMs (doubling) until deadlineMs, then {@link SessionLockConflictError}
 * (fail-closed — a conflicting holder means another live writer owns the
 * session). The lease releases on `release()`, on process death, or on handle
 * close — whichever comes first.
 * @param opts - the lock path plus backoff/deadline tuning.
 * @returns the held lease.
 * @throws {SessionLockUnsupportedError} on platforms other than Windows/Linux
 * (darwin stays fail-closed in this build — no weaker lockfile+PID fallback is
 * shipped).
 * @throws {SessionLockConflictError} when another holder keeps the lease past deadlineMs.
 */
export async function acquireSessionLock(opts: AcquireOptions): Promise<SessionLock> {
  const platform = process.platform
  if (platform !== "win32" && platform !== "linux") {
    // Platform boundary: only Windows (LockFileEx) and Linux (flock) ship
    // bindings. Fail loud elsewhere rather than shipping a weaker
    // lockfile+PID fallback (orphan trap); darwin stays fail-closed.
    throw new SessionLockUnsupportedError(`session ownership locks are unsupported on ${platform} in this build (Windows/Linux only)`)
  }
  mkdirSync(dirname(opts.lockPath), { recursive: true })
  if (platform === "win32") {
    const { acquireWin32 } = await import("./win32.ts")
    return acquireWin32(opts)
  }
  const { acquireLinux } = await import("./linux.ts")
  return acquireLinux(opts)
}
