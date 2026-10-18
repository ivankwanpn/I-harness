import { createHash } from "node:crypto"
import { FsToolError } from "./error.ts"

export interface FileReadPolicy { maxOutputBytes: number }
export interface FileReadArgs { path: string; offset_bytes?: number; max_output_bytes?: number; digest?: string }
export interface FileReadPage { content: string; digest?: string; offset_bytes?: number; next_offset_bytes?: number; total_bytes?: number; truncated?: boolean }

/** Source-backed pages: a digest protects against mixing changed file generations. */
export function fileReadPage(content: string, args: FileReadArgs, policy: FileReadPolicy): FileReadPage {
  if (!Number.isSafeInteger(policy.maxOutputBytes) || policy.maxOutputBytes < 1024) throw new Error("Invalid file read policy")
  if (args.max_output_bytes !== undefined && (!Number.isSafeInteger(args.max_output_bytes) || args.max_output_bytes < 1024)) throw new FsToolError("FS_AMBIGUOUS_EDIT", "max_output_bytes must be an integer >= 1024")
  const cap = Math.min(args.max_output_bytes ?? policy.maxOutputBytes, policy.maxOutputBytes)
  const source = Buffer.from(content, "utf8"), digest = createHash("sha256").update(source).digest("hex")
  if (args.digest !== undefined && args.digest !== digest) throw new FsToolError("FS_STALE_VERSION", "Source digest changed; restart read at offset_bytes 0")
  const offset = args.offset_bytes ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length || (offset < source.length && (source[offset]! & 0xc0) === 0x80)) throw new FsToolError("FS_AMBIGUOUS_EDIT", "offset_bytes must be a UTF8 boundary within the file")
  if (args.offset_bytes === undefined && args.digest === undefined && args.max_output_bytes === undefined && Buffer.byteLength(JSON.stringify({ content }), "utf8") <= cap) return { content }
  const assemble = (end: number): FileReadPage => ({ content: source.subarray(offset, end).toString("utf8"), digest, offset_bytes: offset, next_offset_bytes: end, total_bytes: source.length, truncated: end < source.length })
  let low = offset, high = source.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify(assemble(mid)), "utf8") <= cap) low = mid
    else high = mid - 1
  }
  while (low > offset && low < source.length && (source[low]! & 0xc0) === 0x80) low--
  if (low === offset && offset < source.length) throw new Error("File page metadata leaves no room for content")
  return assemble(low)
}
