import { readFile, writeFile, readdir } from "node:fs/promises"
import { resolve, relative, isAbsolute } from "node:path"
import type { Tool } from "@i-harness/core-tools"
import { FsToolError } from "./error.ts"
import { writeFileAtomic } from "./atomic.ts"
import { normalizeLineEndings, detectLineEndings, restoreLineEndings, assertTextData, applyLiteralEdit } from "./text.ts"

export { FsToolError, type FsToolErrorCode } from "./error.ts"
export { writeFileAtomic } from "./atomic.ts"
export {
  normalizeLineEndings,
  detectLineEndings,
  restoreLineEndings,
  assertTextData,
  applyLiteralEdit,
  type LiteralEditResult,
} from "./text.ts"

// 既有行為：絕對輸入原樣（讀取 workspace 外檔案——read 保留）；`..` 逃逸 → 現在拒
export function resolvePath(workspace: string, path: string): string {
  const isAbsoluteInput = path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)
  const resolved = isAbsoluteInput ? resolve(path) : resolve(workspace, path)
  if (!isAbsoluteInput) {
    const rel = relative(workspace, resolved)
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new FsToolError("FS_NOT_FOUND", `path escapes workspace: ${path}`)
    }
  }
  return resolved
}

export interface FsToolDeps {
  workspace: string
}

export function createFsTools(deps: FsToolDeps): Tool[] {
  const read: Tool<{ path: string }, { content: string }> = {
    name: "read",
    description: "read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async ({ path }) => ({ content: await readFile(resolvePath(deps.workspace, path), "utf-8") }),
  }
  const write: Tool<{ path: string; text: string }, { ok: boolean }> = {
    name: "write",
    description: "write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"] },
    isReadOnly: false,
    execute: async ({ path, text }) => {
      await writeFile(resolvePath(deps.workspace, path), text, "utf-8")
      return { ok: true }
    },
  }
  const list_dir: Tool<{ path: string }, { entries: string[] }> = {
    name: "list_dir",
    description: "list a directory",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async ({ path }) => ({ entries: await readdir(resolvePath(deps.workspace, path)) }),
  }
  const edit: Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean; observedMtimeMs?: number }, { ok: boolean; path: string; replacements: number }> = {
    name: "edit",
    description: "edit a file by literal string replacement (single occurrence unless replace_all)",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
        observedMtimeMs: { type: "number", description: "optional mtime observed from read; mismatch → reject (stale)" },
      },
      required: ["path", "old_string", "new_string"],
    },
    isReadOnly: false,
    execute: async ({ path, old_string, new_string, replace_all = false, observedMtimeMs }) => {
      const target = resolvePath(deps.workspace, path)
      const { stat, readFile } = await import("node:fs/promises")
      let st
      try {
        st = await stat(target)
      } catch {
        throw new FsToolError("FS_NOT_FOUND", `file not found: ${path}`)
      }
      if (!st.isFile()) throw new FsToolError("FS_NOT_REGULAR_FILE", `not a regular file: ${path}`)
      if (observedMtimeMs !== undefined && Math.floor(st.mtimeMs) !== observedMtimeMs) {
        throw new FsToolError("FS_STALE_VERSION", `file changed since it was read (observed ${observedMtimeMs}, now ${Math.floor(st.mtimeMs)}) — re-read then retry`)
      }
      if (old_string === new_string) throw new FsToolError("FS_AMBIGUOUS_EDIT", "ambiguous: old_string must differ from new_string (no-op)")
      const raw = await readFile(target)
      const text = assertTextData(raw) // throws FS_NOT_REGULAR_FILE on binary/UTF-8
      const style = detectLineEndings(text)
      const normalized = normalizeLineEndings(text)
      const result = applyLiteralEdit(normalized, normalizeLineEndings(old_string), normalizeLineEndings(new_string), replace_all)
      if ("error" in result) {
        if (result.error === "not_found") throw new FsToolError("FS_EDIT_NOT_FOUND", `old_string not found in ${path}`)
        throw new FsToolError("FS_AMBIGUOUS_EDIT", `ambiguous: matched ${result.count} times in ${path}; provide more specific old_string or set replace_all`)
      }
      const finalText = restoreLineEndings(result.text, style)
      await writeFileAtomic(target, finalText)
      return { ok: true, path, replacements: result.replacements }
    },
  }
  return [read, edit, write, list_dir]
}
