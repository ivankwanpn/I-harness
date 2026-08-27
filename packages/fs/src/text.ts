import { FsToolError } from "./error.ts"

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n")
}

export function detectLineEndings(text: string): "crlf" | "lf" {
  const sample = text.slice(0, 4096)
  const crlf = (sample.match(/\r\n/g) ?? []).length
  const lfOnly = (sample.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lfOnly ? "crlf" : "lf"
}

export function restoreLineEndings(text: string, style: "crlf" | "lf"): string {
  return style === "crlf" ? text.replace(/\n/g, "\r\n") : text
}

const NUL_RE = /\u0000/

export function assertTextData(data: Uint8Array, maxBytes?: number): string {
  if (maxBytes !== undefined && data.byteLength > maxBytes) {
    throw new FsToolError("FS_TOO_LARGE", `file too large: ${data.byteLength} bytes (limit ${maxBytes})`)
  }
  if (NUL_RE.test(Buffer.from(data).toString("latin1"))) {
    throw new FsToolError("FS_NOT_REGULAR_FILE", "binary file (contains NUL byte) — not text")
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data)
  } catch {
    throw new FsToolError("FS_NOT_REGULAR_FILE", "file is not valid UTF-8 text")
  }
}

export type LiteralEditResult =
  | { text: string; replacements: number }
  | { error: "not_found" }
  | { error: "ambiguous"; count: number }

export function applyLiteralEdit(content: string, oldString: string, newString: string, replaceAll: boolean): LiteralEditResult {
  if (oldString === newString) return { error: "ambiguous", count: 0 } // no-op prevented elsewhere too
  if (!replaceAll) {
    const idx = content.indexOf(oldString)
    if (idx === -1) return { error: "not_found" }
    const second = content.indexOf(oldString, idx + oldString.length)
    if (second !== -1) return { error: "ambiguous", count: (content.split(oldString).length - 1) }
    return { text: content.slice(0, idx) + newString + content.slice(idx + oldString.length), replacements: 1 }
  }
  const parts = content.split(oldString)
  if (parts.length === 1) return { error: "not_found" }
  return { text: parts.join(newString), replacements: parts.length - 1 }
}
