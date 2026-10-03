import type { ProjectFileRef } from "../../../../desktop-gateway/src/project-files.ts"
export interface FileNavigation { workspacePath: string; workspaceId?: string; onOpenFile(path: string): void; projectRoots?: { workspaceId: string; path: string }[]; onOpenProjectFile?(ref: ProjectFileRef): void }

/** Tool paths retain the root which actually owns them. Relative tool paths use
 * the operation's owner, while absolute paths are matched against current roots. */
export function toolProjectFileRef(name: string, args: unknown, ownerWorkspaceId: string, roots: readonly { workspaceId: string; path: string }[]): ProjectFileRef | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined
  const input = args as Record<string, unknown>, raw = input.path ?? input.file_path ?? input.filePath
  if (typeof raw !== "string") return undefined
  const absolute = raw.startsWith("/") || raw.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(raw)
  const candidates = absolute ? [...roots].sort((a, b) => b.path.length - a.path.length) : roots.filter((root) => root.workspaceId === ownerWorkspaceId)
  for (const root of candidates) {
    const path = toolFilePath(name, args, root.path)
    if (path) return { workspaceId: root.workspaceId, path }
  }
  return undefined
}

/** Presentation routing only; the existing review backend remains the authority
 * for filesystem access, symlinks and workspace confinement. Never parse shells. */
export function toolFilePath(name: string, args: unknown, workspacePath: string): string | undefined {
  if (!workspacePath || !["read", "read_file", "write", "write_file", "edit"].includes(name) || !args || typeof args !== "object" || Array.isArray(args)) return undefined
  const input = args as Record<string, unknown>
  const raw = input.path ?? input.file_path ?? input.filePath
  if (typeof raw !== "string" || !raw || raw.length > 4096 || /[\0\r\n]/.test(raw)) return undefined
  const root = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "")
  let path = raw.replace(/\\/g, "/")
  const absolute = path.startsWith("/") || /^[a-zA-Z]:\//.test(path)
  if (absolute) {
    const windows = /^[a-zA-Z]:/.test(root) || root.startsWith("//")
    const candidate = windows ? path.toLowerCase() : path
    const prefix = `${windows ? root.toLowerCase() : root}/`
    if (!candidate.startsWith(prefix)) return undefined
    path = path.slice(root.length + 1)
  }
  while (path.startsWith("./")) path = path.slice(2)
  if (!path || path.includes(":") || path.split("/").some((part) => part === "..")) return undefined
  return path
}
