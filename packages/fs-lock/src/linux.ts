/**
 * Linux binding for the session ownership lease: koffi-bound flock(2) on a
 * node-core fd in NON-BLOCKING mode (LOCK_EX | LOCK_NB) with the retry/backoff
 * loop in JS, so the event loop is never blocked by a synchronous FFI wait.
 *
 * Structurally symmetric with ./win32.ts (same DEFAULT_* constants, same
 * sleep, same heldLock pattern, same close-best-effort-handle on a failed
 * acquire). The fd comes from node's fs.openSync — a plain JS number passed
 * straight to koffi's flock(int, int); there is NO koffi open() binding. flock
 * locks ride the OPEN FILE DESCRIPTION, so two independent opens of the same
 * lock file conflict even within one process (real OS arbitration — same
 * fail-closed shape as win32's second CreateFileW + LockFileEx).
 *
 * glibc and musl both export `flock` and `__errno_location` from libc.so.6
 * (musl's libc.so.6 is the same ELF loaded by its musl-gcc linker script);
 * the LOCK_* and EAGAIN constants are sys/file.h / errno.h values, stable
 * across both. errno is read via `koffi.errno()` (koffi saves it after each
 * native call); a koffi build without that API falls back to binding
 * `int *__errno_location(void)` and decoding the pointed-to int.
 *
 * Fail-closed conflict semantics follow codex `thread-store/src/local/
 * writer_lock.rs` (try_lock + WouldBlock→Conflict). MIT attribution in
 * THIRD_PARTY_NOTICES (OpenAI codex-rs).
 * @module @i-harness/fs-lock/linux
 */
import { closeSync, openSync } from "node:fs"
import { createRequire } from "node:module"

import { SessionLockConflictError, SessionLockUnsupportedError } from "./errors.ts"
import type { AcquireOptions, SessionLock } from "./index.ts" // type-only: index dynamically imports THIS file; type-only imports never form a runtime cycle

type Koffi = typeof import("koffi")

/** The only Linux calls the lease needs: flock(2) plus an errno reader. */
interface FsLockBindings {
  /** int flock(int fd, int operation) — 0 on success, -1 on failure. */
  flock(fd: number, operation: number): number
  /** errno of the most recent failed native call (captured per koffi call). */
  lastErrno(): number
}

// ---- sys/file.h / errno.h constants (stable across glibc and musl) ----
/** LOCK_EX: request an exclusive lock (sys/file.h). */
const LOCK_EX = 2
/** LOCK_NB: non-blocking — fail with EAGAIN instead of waiting (sys/file.h). */
const LOCK_NB = 4
/** LOCK_UN: release an existing lock (sys/file.h). */
const LOCK_UN = 8
/** EAGAIN: flock(LOCK_NB) conflict — EWOULDBLOCK === EAGAIN on Linux, so one check covers both (errno.h). */
const EAGAIN = 11

/** Acquire-backoff defaults (see AcquireOptions) — identical to win32. */
const DEFAULT_RETRY_MS = 20
const DEFAULT_RETRY_MAX_MS = 200
const DEFAULT_DEADLINE_MS = 2000

/** Error codes that mean "someone else holds the lease" → retry until the deadline. */
function isConflictCode(code: number): boolean {
  return code === EAGAIN
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

let cachedBindings: FsLockBindings | undefined

/** The koffi module (lazy: loaded only when a linux acquire actually runs). */
let koffiCache: Koffi | undefined

function koffiModule(): Koffi {
  if (koffiCache !== undefined) return koffiCache
  const require = createRequire(import.meta.url)
  koffiCache = require("koffi") as Koffi
  return koffiCache
}

/**
 * Resolve the lazy Linux binding table (cached). Any load/binding failure —
 * koffi missing, libc.so.6 unavailable, symbol absent — becomes
 * {@link SessionLockUnsupportedError} (fail loud at the platform boundary).
 * @returns the cached binding table.
 */
function bindings(): FsLockBindings {
  if (cachedBindings !== undefined) return cachedBindings
  try {
    const koffi = koffiModule()
    const libc = koffi.load("libc.so.6")
    // sys/file.h: int flock(int fd, int operation) — cdecl, so the plain 3-arg func() form.
    const flock = libc.func("flock", "int", ["int", "int"])
    let lastErrno: () => number
    if (typeof koffi.errno === "function") {
      // koffi ≥2.x saves errno after each native call; read it back verbatim.
      lastErrno = () => koffi.errno()
    } else {
      // Fallback for a koffi without the errno() API: `int *__errno_location(void)`
      // (exported by BOTH glibc and musl) returns the thread-local errno slot.
      const intPtr = koffi.pointer("int")
      const errnoLocation = libc.func("__errno_location", intPtr, [])
      lastErrno = () => koffi.decode(errnoLocation(), "int")
    }
    cachedBindings = { flock, lastErrno } as unknown as FsLockBindings
  } catch (error) {
    throw new SessionLockUnsupportedError(
      `Linux session ownership locks need the koffi native module and libc.so.6 (flock): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return cachedBindings
}

/**
 * Build the lease object for an ACQUIRED lock: flock(LOCK_UN) + close on
 * release (idempotent — the first call wins, later calls are no-ops). Closing
 * the fd alone would also drop the flock; the explicit unlock precedes it so
 * a locked-close never happens silently.
 * @param api - the binding table.
 * @param fd - the OPEN lock-file descriptor that HOLDS the flock.
 * @param lockPath - the lock file path (error reporting).
 * @returns the held lease.
 */
function heldLock(api: FsLockBindings, fd: number, lockPath: string): SessionLock {
  let held = true
  return {
    get held(): boolean {
      return held
    },
    release(): void {
      if (!held) return // idempotent: already released → no-op
      held = false
      // Capture errno IMMEDIATELY after the failing flock call so the next
      // native call cannot clobber it.
      const unlockErrno = api.flock(fd, LOCK_UN) !== 0 ? api.lastErrno() : 0
      let closeError: unknown = null
      try {
        closeSync(fd)
      } catch (error) {
        closeError = error
      }
      if (unlockErrno !== 0) throw new Error(`flock(LOCK_UN) failed (errno ${unlockErrno}) for ${lockPath}`)
      if (closeError !== null) {
        throw new Error(`close failed for ${lockPath}: ${closeError instanceof Error ? closeError.message : String(closeError)}`)
      }
    },
  }
}

/**
 * Linux acquire: non-blocking flock(LOCK_EX | LOCK_NB) with a JS backoff
 * retry loop. Open once (fs.openSync "a+" — a second opener must succeed so
 * the CONFLICT can surface at lock time; each open is its own open file
 * description, so two opens in the SAME process still conflict), then flock
 * the fd. Conflict-class failures (EAGAIN) back off retryMs→retryMaxMs
 * (doubling) until deadlineMs, then throw {@link SessionLockConflictError};
 * every other failure throws immediately (fail loud, no lease taken).
 * @param opts - the acquire options (lockPath + backoff/deadline tuning).
 * @returns the held lease.
 */
export async function acquireLinux(opts: AcquireOptions): Promise<SessionLock> {
  const api = bindings()
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS
  const retryMaxMs = opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
  const deadline = Date.now() + deadlineMs

  let fd: number | null = null
  try {
    let delay = retryMs
    for (;;) {
      if (fd === null) {
        // "a+" (O_RDWR|O_APPEND|O_CREAT): open or create the lock file with
        // shared access — the conflict must surface at flock() time.
        fd = openSync(opts.lockPath, "a+")
      }

      if (api.flock(fd, LOCK_EX | LOCK_NB) === 0) {
        return heldLock(api, fd, opts.lockPath)
      }
      const code = api.lastErrno()
      if (!isConflictCode(code)) {
        throw new Error(`flock failed (errno ${code}) for ${opts.lockPath}`)
      }
      if (Date.now() >= deadline) {
        throw new SessionLockConflictError(`another holder owns the session lock at ${opts.lockPath} (deadline ${deadlineMs}ms exceeded; last errno ${code})`)
      }
      await sleep(delay)
      delay = Math.min(retryMaxMs, delay * 2)
    }
  } catch (error) {
    // No lease was acquired (or the acquire failed mid-way) — close the
    // best-effort fd so a failed acquire never leaks it. A HELD lock's fd
    // intentionally stays open for the lease's lifetime (owned by the
    // returned SessionLock, not this scope).
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // best-effort: the original acquire error is what matters
      }
    }
    throw error
  }
}
