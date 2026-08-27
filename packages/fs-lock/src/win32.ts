/**
 * Win32 binding for the session ownership lease: koffi-bound CreateFileW +
 * LockFileEx/UnlockFileEx in NON-BLOCKING mode
 * (LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY) with the retry/backoff
 * loop in JS, so the event loop is never blocked by a synchronous FFI wait.
 *
 * Attribution: the binding-table shape and call pattern are absorbed from
 * `@i-harness/sandbox-windows-acl` (`ffi.ts` win32Bindings — CreateFileW /
 * LockFileEx / UnlockFileEx / CloseHandle signatures verified against the
 * MinGW Windows headers there; `acl.ts:75-110` withPathLock). CRITICAL gotcha
 * carried over: koffi 3.1.x CRASHES on a NULL lpOverlapped, so every
 * LockFileEx/UnlockFileEx call passes a zeroed 32-byte OVERLAPPED (offset 0,
 * hEvent NULL — the documented equivalent on a synchronous file handle).
 * Fail-closed conflict semantics follow codex `thread-store/src/local/
 * writer_lock.rs` (try_lock + WouldBlock→Conflict). MIT attribution in
 * THIRD_PARTY_NOTICES (OpenAI codex-rs + huoyaoyuan windows-acl-restrict-poc).
 * @module @i-harness/fs-lock/win32
 */
import { createRequire } from "node:module"

import { SessionLockConflictError, SessionLockUnsupportedError } from "./errors.ts"
import type { AcquireOptions, SessionLock } from "./index.ts" // type-only: index dynamically imports THIS file; type-only imports never form a runtime cycle

/** koffi 3 native pointer (a BigInt address). */
type NativePtr = bigint
type Koffi = typeof import("koffi")
type Ptr = ReturnType<Koffi["pointer"]>
type KoffiLib = ReturnType<Koffi["load"]>

/** The only Win32 calls the lease needs; signature shapes absorbed from sandbox-windows-acl/ffi.ts. */
interface FsLockBindings {
  createFileW(
    fileName: string, desiredAccess: number, shareMode: number, attributes: null,
    creationDisposition: number, flagsAndAttributes: number, templateFile: null,
  ): NativePtr
  lockFileEx(file: NativePtr, flags: number, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr): number
  unlockFileEx(file: NativePtr, reserved: number, bytesLow: number, bytesHigh: number, overlapped: NativePtr): number
  closeHandle(handle: NativePtr): number
  getLastError(): number
}

// ---- winnt.h / fileapi.h / winerror.h constants (values pinned in sandbox-windows-acl/win32-abi.ts) ----
/** GENERIC_READ (winnt.h). */
const GENERIC_READ = 0x80000000
/** GENERIC_WRITE (winnt.h). */
const GENERIC_WRITE = 0x40000000
/** FILE_SHARE_READ: other opens may read (winnt.h). */
const FILE_SHARE_READ = 0x00000001
/** FILE_SHARE_WRITE: other opens may write (winnt.h). */
const FILE_SHARE_WRITE = 0x00000002
/** OPEN_ALWAYS: create the lock file if absent, open it otherwise (fileapi.h). */
const OPEN_ALWAYS = 4
/** LOCKFILE_FAIL_IMMEDIATELY: fail instead of waiting (winbase.h). */
const LOCKFILE_FAIL_IMMEDIATELY = 0x1
/** LOCKFILE_EXCLUSIVE_LOCK: request an exclusive byte-range lock (winbase.h). */
const LOCKFILE_EXCLUSIVE_LOCK = 0x2
/** ERROR_ACCESS_DENIED (winerror.h) — treated as a conflict signal per the fail-closed brief. */
const ERROR_ACCESS_DENIED = 5
/** ERROR_LOCK_VIOLATION: the byte-range lock conflicts with an existing lock (winerror.h). */
const ERROR_LOCK_VIOLATION = 33

/** Acquire-backoff defaults (see AcquireOptions). */
const DEFAULT_RETRY_MS = 20
const DEFAULT_RETRY_MAX_MS = 200
const DEFAULT_DEADLINE_MS = 2000

/** True for NULL pointers however koffi returns them. */
function isNullPtr(value: NativePtr | null | undefined): value is null | undefined {
  return value === null || value === undefined || (value as bigint) === 0n
}

/** True for CreateFileW's INVALID_HANDLE_VALUE failure marker (-1, handed back as the all-ones pointer). */
function isInvalidHandle(handle: NativePtr | null | undefined): boolean {
  if (isNullPtr(handle)) return true
  return (handle as bigint) === 0xFFFFFFFFFFFFFFFFn || (handle as bigint) === -1n
}

/** Error codes that mean "someone else holds the lease" → retry until the deadline. */
function isConflictCode(code: number): boolean {
  return code === ERROR_LOCK_VIOLATION || code === ERROR_ACCESS_DENIED
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The one lock file's 32-byte zeroed OVERLAPPED (koffi 3.1.x crashes on NULL lpOverlapped — see module doc). */
function allocOverlapped(): NativePtr {
  const value: unknown = koffiModule().alloc("uint8", 32) // koffi.alloc memory is zeroed
  return value as NativePtr
}

let cachedBindings: FsLockBindings | undefined

/** The koffi module (lazy: loaded only when a win32 acquire actually runs). */
let koffiCache: Koffi | undefined

function koffiModule(): Koffi {
  if (koffiCache !== undefined) return koffiCache
  const require = createRequire(import.meta.url)
  koffiCache = require("koffi") as Koffi
  return koffiCache
}

/**
 * Resolve the lazy Win32 binding table (cached). Any load/binding failure —
 * koffi missing, kernel32 unavailable — becomes {@link SessionLockUnsupportedError}
 * (fail loud at the platform boundary).
 * @returns the cached binding table.
 */
function bindings(): FsLockBindings {
  if (cachedBindings !== undefined) return cachedBindings
  try {
    const koffi = koffiModule()
    const kernel32 = koffi.load("kernel32.dll")
    const bind = (lib: KoffiLib, name: string, result: Ptr | string, args: Array<Ptr | string>): unknown =>
      lib.func("__stdcall", name, result, args)
    const PVOID = koffi.pointer("void")
    cachedBindings = {
      // fileapi.h: HANDLE CreateFileW(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE)
      createFileW: bind(kernel32, "CreateFileW", PVOID, ["str16", "uint32", "uint32", PVOID, "uint32", "uint32", PVOID]),
      // fileapi.h: BOOL LockFileEx(HANDLE, DWORD, DWORD, DWORD, DWORD, LPOVERLAPPED) / UnlockFileEx(...)
      lockFileEx: bind(kernel32, "LockFileEx", "int", [PVOID, "uint32", "uint32", "uint32", "uint32", PVOID]),
      unlockFileEx: bind(kernel32, "UnlockFileEx", "int", [PVOID, "uint32", "uint32", "uint32", PVOID]),
      closeHandle: bind(kernel32, "CloseHandle", "int", [PVOID]),
      getLastError: bind(kernel32, "GetLastError", "uint32", []),
    } as unknown as FsLockBindings
  } catch (error) {
    throw new SessionLockUnsupportedError(
      `Windows session ownership locks need the koffi native module and kernel32.dll: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return cachedBindings
}

/**
 * Build the lease object for an ACQUIRED lock: UnlockFileEx + CloseHandle on
 * release (idempotent — the first call wins, later calls are no-ops). Closing
 * the handle alone would also drop the byte-range lock; the explicit unlock
 * precedes it so a locked-close never happens silently.
 * @param api - the binding table.
 * @param handle - the OPEN lock-file handle that HOLDS the byte-range lock.
 * @param lockPath - the lock file path (error reporting).
 * @param overlapped - the zeroed OVERLAPPED used for lock/unlock.
 * @returns the held lease.
 */
function heldLock(api: FsLockBindings, handle: NativePtr, lockPath: string, overlapped: NativePtr): SessionLock {
  let held = true
  return {
    get held(): boolean {
      return held
    },
    release(): void {
      if (!held) return // idempotent: already released → no-op
      held = false
      // Capture each error code IMMEDIATELY after its failing call so the next
      // Win32 call cannot clobber GetLastError.
      const unlockCode = api.unlockFileEx(handle, 0, 1, 0, overlapped) === 0 ? api.getLastError() : 0
      const closeCode = api.closeHandle(handle) === 0 ? api.getLastError() : 0
      if (unlockCode !== 0) throw new Error(`UnlockFileEx failed (Win32 ${unlockCode}) for ${lockPath}`)
      if (closeCode !== 0) throw new Error(`CloseHandle failed (Win32 ${closeCode}) for ${lockPath}`)
    },
  }
}

/**
 * Win32 acquire: non-blocking LockFileEx with a JS backoff retry loop.
 * Open once (OPEN_ALWAYS, shared read/write — a second opener must succeed so
 * the CONFLICT can surface at lock time), then LOCKFILE_EXCLUSIVE_LOCK |
 * LOCKFILE_FAIL_IMMEDIATELY on one byte from offset 0. Conflict-class failures
 * (ERROR_LOCK_VIOLATION, ERROR_ACCESS_DENIED) back off retryMs→retryMaxMs
 * (doubling) until deadlineMs, then throw {@link SessionLockConflictError};
 * every other Win32 failure throws immediately (fail loud, no lease taken).
 * @param opts - the acquire options (lockPath + backoff/deadline tuning).
 * @returns the held lease.
 */
export async function acquireWin32(opts: AcquireOptions): Promise<SessionLock> {
  const api = bindings()
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS
  const retryMaxMs = opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS
  const deadline = Date.now() + deadlineMs
  const overlapped = allocOverlapped()

  let handle: NativePtr | null = null
  try {
    let delay = retryMs
    for (;;) {
      if (handle === null) {
        const opened = api.createFileW(
          opts.lockPath,
          GENERIC_READ | GENERIC_WRITE,
          FILE_SHARE_READ | FILE_SHARE_WRITE,
          null, OPEN_ALWAYS, 0, null,
        )
        if (isInvalidHandle(opened)) {
          const code = api.getLastError()
          if (isConflictCode(code) && Date.now() < deadline) {
            await sleep(delay)
            delay = Math.min(retryMaxMs, delay * 2)
            continue
          }
          if (isConflictCode(code)) {
            throw new SessionLockConflictError(`another holder owns the session lock at ${opts.lockPath} (deadline ${deadlineMs}ms exceeded; last Win32 code ${code})`)
          }
          throw new Error(`CreateFileW failed (Win32 ${code}) for ${opts.lockPath}`)
        }
        handle = opened
      }

      if (api.lockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped) !== 0) {
        return heldLock(api, handle, opts.lockPath, overlapped)
      }
      const code = api.getLastError()
      if (!isConflictCode(code)) {
        throw new Error(`LockFileEx failed (Win32 ${code}) for ${opts.lockPath}`)
      }
      if (Date.now() >= deadline) {
        throw new SessionLockConflictError(`another holder owns the session lock at ${opts.lockPath} (deadline ${deadlineMs}ms exceeded)`)
      }
      await sleep(delay)
      delay = Math.min(retryMaxMs, delay * 2)
    }
  } catch (error) {
    // No lease was acquired (or the acquire failed mid-way) — close the
    // best-effort handle so a failed acquire never leaks it. A HELD lock's
    // handle intentionally stays open for the lease's lifetime (owned by the
    // returned SessionLock, not this scope).
    if (handle !== null && !isInvalidHandle(handle)) api.closeHandle(handle)
    throw error
  }
}
