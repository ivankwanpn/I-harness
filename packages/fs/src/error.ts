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
