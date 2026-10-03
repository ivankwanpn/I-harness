import type { ProjectFileRef } from "../../../../desktop-gateway/src/project-files.ts"
import type { SearchQuery } from "../../../../fs-search/src/search-types.ts"
/** Line numbers are one based; columns are zero based UTF16 code units in the
 * BOM-stripped, CRLF-normalized displayed text. The end is exclusive. */
export interface ProjectFileNavigation {
  line: number
  column?: number
  endLine?: number
  endColumn?: number
  nonce: string
  revision?: string
  encoding?: SearchQuery["encoding"]
  readonly?: boolean
  external?: boolean
}
export type ProjectFileTarget = ProjectFileRef & { navigation?: ProjectFileNavigation }
export interface ExternalFileTarget { reference: { path: string; readonly: true }; navigation?: ProjectFileNavigation }
export type FileOpenTarget = ProjectFileTarget | ExternalFileTarget
export interface FileNavigation { workspacePath: string; workspaceId?: string; onOpenFile(path: string): void; projectRoots?: { workspaceId: string; path: string }[]; onOpenProjectFile?(ref: ProjectFileTarget): void; onOpenExternalFile?(target: ExternalFileTarget): void }
export const absoluteReferencePath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value) && (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value))

/** Explicit file arguments may be viewed as read-only references. Shell text and
 * URLs never produce a target; the native read route checks the actual file. */
export function toolExternalFileTarget(name: string, args: unknown): ExternalFileTarget | undefined {
  if (!["read", "read_file", "write", "write_file", "edit"].includes(name) || !args || typeof args !== "object" || Array.isArray(args)) return undefined
  const input = args as Record<string, unknown>, path = input.path ?? input.file_path ?? input.filePath
  return absoluteReferencePath(path) ? { reference: { path, readonly: true } } : undefined
}

export function displayedNavigationRange(text: string, target: Pick<ProjectFileNavigation, "line" | "column" | "endLine" | "endColumn">, startLine = 1) {
  const lines = text.split("\n")
  const integer = (value: number | undefined, fallback: number) => value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback
  const first = Math.max(0, Math.min(lines.length - 1, integer(target.line, startLine) - startLine))
  const last = Math.max(first, Math.min(lines.length - 1, integer(target.endLine, target.line) - startLine))
  const offset = (line: number) => lines.slice(0, line).reduce((sum, value) => sum + value.length + 1, 0)
  const column = Math.max(0, Math.min(lines[first]!.length, integer(target.column, 0)))
  const endColumn = Math.max(0, Math.min(lines[last]!.length, integer(target.endColumn, target.column === undefined ? lines[last]!.length : column)))
  const start = offset(first) + column
  return { start, end: Math.max(start, offset(last) + endColumn), line: first + startLine }
}

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
