/**
 * The session header is line 0 and is read through a single 64 KiB window
 * (profile/cold reads never touch the event body). The write side must enforce
 * the same bound: a header that can be written but not read back would make the
 * session unloadable after a metadata update.
 */
export const HEADER_READ_MAX_BYTES = 64 * 1024

export function headerLineBytes(line: string): number {
  return Buffer.byteLength(line, "utf8") + 1 // trailing newline
}

export function assertHeaderLineReadable(line: string): void {
  const bytes = headerLineBytes(line)
  if (bytes > HEADER_READ_MAX_BYTES) {
    throw Object.assign(new Error(`Session header is ${bytes} bytes, above the ${HEADER_READ_MAX_BYTES}-byte readable limit`), {
      code: "SESSION_HEADER_TOO_LARGE",
      bytes,
      limit: HEADER_READ_MAX_BYTES,
    })
  }
}
