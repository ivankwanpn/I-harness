// packages/rewind/src/path.ts — the engine's single path-discipline seam.
// The rewind journal stores paths RELATIVE to the workspace root only (spec
// §1: "需要 workspace 根下的相對路徑"). Both the recorder (take side) and the
// service (plan/execute disk side) go through these two functions; a violation
// throws REWIND_PATH_REFUSED (fail-loud — it means a caller fed garbage).
import { isAbsolute, relative, resolve } from "node:path"
import { RewindError } from "./error.ts"

/**
 * Normalize a caller-supplied workspace-relative path: backslashes → `/`,
 * drop `.`/empty segments. Refuses (REWIND_PATH_REFUSED): absolute paths
 * (POSIX `/` or a Windows drive prefix `C:`), a `..` segment (traversal) and
 * empty results. The normalized form is the journal key — identical file
 * addressed from `a.txt`, `./a.txt` or `sub/../a.txt` (refused) can never
 * alias twice.
 */
export function normalizeRelPath(raw: string): string {
  const normalized = raw.replaceAll("\\", "/")
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    throw new RewindError("REWIND_PATH_REFUSED", `absolute path refused: ${raw}`)
  }
  const parts = normalized.split("/")
  if (parts.includes("..")) {
    throw new RewindError("REWIND_PATH_REFUSED", `path traversal refused: ${raw}`)
  }
  const rel = parts.filter((p) => p !== "" && p !== ".").join("/")
  if (rel === "") {
    throw new RewindError("REWIND_PATH_REFUSED", `empty path refused: ${raw}`)
  }
  return rel
}

/**
 * Resolve a normalized workspace-relative path against the workspace root with
 * a defense-in-depth containment check (the same escape refusal resolves
 * against a DIFFERENT starting root than the caller intended). This is the
 * boundary between journal paths and real disk paths.
 */
export function workspaceAbsPath(workspaceRoot: string, relPath: string): string {
  const normalized = normalizeRelPath(relPath)
  const abs = resolve(workspaceRoot, ...normalized.split("/"))
  const rel = relative(workspaceRoot, abs)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new RewindError("REWIND_PATH_REFUSED", `path escapes workspace: ${relPath}`)
  }
  return abs
}
