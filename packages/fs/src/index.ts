import { readFile, writeFile, readdir } from "node:fs/promises"
import { resolve, relative, isAbsolute } from "node:path"
import type { Tool } from "@i-harness/core-tools"
import { FsToolError } from "./error.ts"

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
  return [read, write, list_dir]
}
