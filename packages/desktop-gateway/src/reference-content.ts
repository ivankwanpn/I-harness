import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { createHash } from "node:crypto"
import { openPinnedFileForReview } from "./review-handle.ts"
import type { ProjectContentReaderOptions } from "./project-content-reader.ts"
import type { FileResult } from "./review.ts"

export function referenceAbsolutePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || !isAbsolute(value) || /[\0\r\n]/.test(value) || /^\\\\[?.]\\/.test(value) || process.platform === "win32" && value.slice(/^[a-z]:/i.test(value) ? 2 : 0).includes(":")) throw new Error("Reference location must be an absolute file or folder path")
  return resolve(value)
}
export async function readPinnedReference(path: string, maxBytes: number, signal: AbortSignal, options: ProjectContentReaderOptions = {}) {
  signal.throwIfAborted()
  const expected = await realpath(referenceAbsolutePath(path)), handle = await (options.openFile ?? openPinnedFileForReview)(expected)
  try {
    if (relative(expected, handle.finalPath) !== "") throw new Error("Reference file handle identity changed during open")
    signal.throwIfAborted()
    const result = await handle.read(maxBytes)
    if (!Number.isSafeInteger(result.count) || result.count < 0 || result.count > maxBytes || result.bytes.byteLength !== result.count) throw new Error("Reference reader exceeded its reservation")
    signal.throwIfAborted()
    return { path: expected, bytes: Buffer.from(result.bytes), revision: createHash("sha256").update(result.bytes).digest("hex"), eof: result.count < maxBytes, readonly: true as const, external: true as const }
  } finally { await handle.close() }
}
export function externalUtf8Result(snapshot: Awaited<ReturnType<typeof readPinnedReference>>): FileResult {
  if (snapshot.bytes.includes(0)) return { kind: "unavailable", reason: "binary" }
  try {
    const text = new TextDecoder("utf8", { fatal: true }).decode(snapshot.bytes).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
    return { kind: "text", text, bytes: snapshot.bytes.byteLength, truncated: !snapshot.eof, readonly: true, external: true, ...(snapshot.eof ? { revision: snapshot.revision } : {}) }
  } catch { return { kind: "unavailable", reason: "binary" } }
}
