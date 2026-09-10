export type FsToolErrorCode =
  | "FS_NOT_FOUND" | "FS_NOT_REGULAR_FILE" | "FS_ALREADY_EXISTS"
  | "FS_EDIT_NOT_FOUND" | "FS_AMBIGUOUS_EDIT" | "FS_STALE_VERSION"
  | "FS_TOO_LARGE" | "FS_IO_ERROR"

export class FsToolError extends Error {
  readonly code: FsToolErrorCode
  constructor(code: FsToolErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = "FsToolError"
  }
}

/**
 * M61: the RETURNED failure shape of an fs tool.
 *
 * An fs failure is an expected outcome — a missing file, an ambiguous edit, a
 * stale version, unreadable bytes — and the model must SEE it to retry. A
 * THROWING tool body fails the whole turn (core-agent M13/M25: the results of
 * the batch are discarded, no tool/result and no turn/end are appended), so
 * the call just sat in the scrollback with no answer and read as "hung".
 *
 * `error` is the model-visible message; `code` is the machine-readable reason
 * (an FsToolErrorCode, or the Node errno for raw I/O failures).
 */
export interface FsToolFailure {
  error: string
  code: string
}

/** Node errno codes that mean "the request could not be served" — converted to
 * a returned failure like FsToolError. Anything else (a TypeError, a bug in
 * the tool body) still throws and fails the turn loudly. */
const SOFT_ERRNO: ReadonlySet<string> = new Set([
  "ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "EEXIST", "EMFILE", "ENOSPC", "EROFS", "EBUSY",
])

/** Run a tool body, converting EXPECTED fs failures into a returned result.
 * Use for every fs-shaped tool: the model reads the failure and adapts. */
export async function softFail<T>(run: () => Promise<T>): Promise<T | FsToolFailure> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof FsToolError) return { error: err.message, code: err.code }
    const errno = (err as NodeJS.ErrnoException | undefined)?.code
    if (typeof errno === "string" && SOFT_ERRNO.has(errno)) {
      return { error: err instanceof Error ? err.message : String(err), code: errno }
    }
    throw err
  }
}
