/**
 * Error types for the session ownership lease. Kept in their own module so
 * `win32.ts` can import them WITHOUT importing `index.ts` at runtime — index
 * dynamically imports win32 (platform dispatch), so a runtime index→win32→index
 * cycle would be circular. index.ts re-exports these for the public surface.
 * @module @i-harness/fs-lock/errors
 */

/** A conflicting holder owns the lease and did not release within the deadline — fail-closed. */
export class SessionLockConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionLockConflictError"
  }
}

/** Session ownership locks are not supported on this platform (M23: Windows-only). */
export class SessionLockUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionLockUnsupportedError"
  }
}
