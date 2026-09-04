import { readFile, writeFile, readdir } from "node:fs/promises"
import { resolve, relative, isAbsolute } from "node:path"
import type { Tool } from "@i-harness/core-tools"
import { FsToolError } from "./error.ts"
import { writeFileAtomic } from "./atomic.ts"
import { assertSnapshotFresh } from "./version.ts"
import { normalizeLineEndings, detectLineEndings, restoreLineEndings, assertTextData, applyLiteralEdit } from "./text.ts"
import { parsePatch, applyPatch, type RewindCapture } from "./patch.ts"

export { FsToolError, type FsToolErrorCode } from "./error.ts"
export { writeFileAtomic } from "./atomic.ts"
export { assertSnapshotFresh, type FileSnapshot } from "./version.ts"
export type { RewindCapture } from "./patch.ts"
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
  /** M42 rewind (G1): optional pre-image sink at the write points — absent ⇒
   * byte-identical behavior (zero cost). Present ⇒ every write tool captures
   * the BEFORE content it is about to overwrite (write does ONE extra read —
   * only when wired; edit/apply_patch already hold the bytes from their
   * read-modify-write path) and the tool result carries preImageRef/isNewFile
   * (additive — the log is the rewind channel, spec §2). The sink's take
   * returns the restore-blob id the result reports; capture failure must never
   * change tool behavior (untracked, honest). */
  rewind?: RewindCapture
}

// M42: workspace-relative key for rewind capture — null when the target
// escapes the workspace (absolute inputs / `..`) — the recorder is
// workspace-scoped, so such writes proceed UNTRACKED (honest).
function relForRewind(workspace: string, target: string): string | null {
  const rel = relative(workspace, target)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null
  return rel.replaceAll("\\", "/")
}

async function capturePreimage(
  rewind: RewindCapture,
  workspace: string,
  target: string,
): Promise<{ preImageRef?: string; isNewFile?: boolean }> {
  const rel = relForRewind(workspace, target)
  if (rel === null) return {}
  let before: Uint8Array | null
  try {
    before = new Uint8Array(await readFile(target))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") before = null
    else return {} // unreadable pre-image → write proceeds untracked (honest)
  }
  const r = rewind.take(rel, before)
  const captured = r.blobId !== null || r.isNewFile
  return captured
    ? { preImageRef: r.blobId ?? undefined, isNewFile: r.isNewFile }
    : {}
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
  const write: Tool<{ path: string; text: string }, { ok: boolean; preImageRef?: string; isNewFile?: boolean }> = {
    name: "write",
    description: "write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"] },
    isReadOnly: false,
    execute: async ({ path, text }) => {
      // M42 rewind: writeFileAtomic OVERWRITES without reading — when rewind
      // is wired, do one extra read (ENOENT ⇒ new file); otherwise zero cost.
      const captured = deps.rewind !== undefined
        ? await capturePreimage(deps.rewind, deps.workspace, resolvePath(deps.workspace, path))
        : {}
      await writeFile(resolvePath(deps.workspace, path), text, "utf-8")
      return { ok: true, ...captured }
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
  const edit: Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean; observedMtimeMs?: number }, { ok: boolean; path: string; replacements: number; preImageRef?: string; isNewFile?: boolean }> = {
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
      if (old_string === "") throw new FsToolError("FS_AMBIGUOUS_EDIT", "ambiguous: old_string must not be empty")
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
      // TOCTOU re-check：read 後、rename 前 re-stat，比對 {mtimeMs,size} 快照（M21 §4.2）
      let stAfter
      try {
        stAfter = await stat(target)
      } catch {
        throw new FsToolError("FS_NOT_FOUND", `file disappeared during edit: ${path}`)
      }
      assertSnapshotFresh({ mtimeMs: st.mtimeMs, size: st.size }, { mtimeMs: stAfter.mtimeMs, size: stAfter.size })
      // M42 rewind: the loaded pre-image (raw, before mutation) captured here —
      // right after the TOCTOU check, right before the write.
      let preImageRef: string | undefined
      if (deps.rewind !== undefined) {
        const rel = relForRewind(deps.workspace, target)
        if (rel !== null) {
          const r = deps.rewind.take(rel, raw)
          if (r.blobId !== null) preImageRef = r.blobId
        }
      }
      await writeFileAtomic(target, finalText)
      return {
        ok: true,
        path,
        replacements: result.replacements,
        ...(preImageRef !== undefined ? { preImageRef } : {}),
        ...(deps.rewind !== undefined ? { isNewFile: false } : {}),
      }
    },
  }
  const apply_patch: Tool<{ patch_content: string }, { ok: boolean; applied: { path: string; action: string }[]; errors: { path: string; message: string }[] }> = {
    name: "apply_patch",
    description: "apply a multi-file structured patch (*** Begin/End Patch + Add/Delete/Update + @@ context)",
    inputSchema: { type: "object", properties: { patch_content: { type: "string" } }, required: ["patch_content"] },
    isReadOnly: false,
    execute: async ({ patch_content }) => {
      // CRLF 正規化：patch 內容若帶 \r，parsePatch 會把 \r 當行內容 → replace 誤報
      // FS_EDIT_NOT_FOUND、純 add 寫入字面 \r。先統一成 LF 再解析。
      const hunks = parsePatch(normalizeLineEndings(patch_content))
      // patch.ts 不 import index.ts（循環）——resolve 由這裡傳入；rewind sink 透傳
      const { applied, errors } = await applyPatch((path) => resolvePath(deps.workspace, path), hunks, deps.rewind)
      if (errors.length > 0) {
        // 回報已應用清單 + 錯誤（不 throw——讓模型看到進行到哪）
        return { ok: false, applied, errors }
      }
      return { ok: true, applied, errors: [] }
    },
  }
  return [read, edit, write, apply_patch, list_dir]
}
