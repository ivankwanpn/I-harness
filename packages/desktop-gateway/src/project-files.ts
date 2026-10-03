import { lstat, opendir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, win32 } from "node:path"
import { ReviewPathError, type WorkspaceReview } from "./review.ts"
import { openPinnedProjectDirectory, type PinnedProjectDirectory } from "./project-directory-handle.ts"

/** Wire contracts shared by the native dispatcher and renderer. Paths are
 * always relative to the exact workspaceId, never relative to the host root. */
export interface ProjectFileRef { workspaceId: string; path: string }
export interface ProjectFileRoot { workspaceId: string; label: string }
export interface ProjectFileSelection { workspaceId: string; sessionId?: string; projectId?: string }
export interface ProjectFileEntry { path: string; name: string; kind: "file" | "directory" }
export interface ProjectFilePage { entries: ProjectFileEntry[]; nextOffset: number | null; truncated: boolean }
export type ProjectFilesRequest = ProjectFileSelection & (
  | { kind: "desktop/project-files/roots" }
  | { kind: "desktop/project-files/list"; ref: ProjectFileRef; offset: number }
  | { kind: "desktop/project-files/search"; ref: ProjectFileRef; query: string; offset: number }
  | { kind: "desktop/project-files/read"; ref: ProjectFileRef }
  | { kind: "desktop/project-files/save"; ref: ProjectFileRef; text: string; expectedRevision: string }
)
export type ProjectFilesRequester = (request: ProjectFilesRequest) => Promise<unknown>

const PAGE = 100, SCAN = 3000, MAX_DEPTH = 32
export function projectRelativePath(value: unknown, allowRoot = false): string {
  if (allowRoot && value === "") return ""
  if (typeof value !== "string" || !value || value.length > 4096 || isAbsolute(value) || win32.isAbsolute(value) || /[\0\r\n:]/.test(value)) throw new ReviewPathError("Invalid project file path")
  const parts = value.replaceAll("\\", "/").split("/")
  if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new ReviewPathError("Project file path escapes workspace")
  return parts.join("/")
}
function inside(root: string, target: string) {
  const suffix = relative(root, target)
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..\\`) && !suffix.startsWith("../") && !isAbsolute(suffix))
}
function offsetOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > SCAN) throw new Error("Invalid project file offset")
  return value
}

/** Directory traversal never follows links. Both scan count and returned rows
 * are capped; opendir avoids allocating an arbitrarily large readdir array. */
export function createProjectFiles(workspace: string, review: WorkspaceReview) {
  const configuredRoot = resolve(workspace)
  async function checkedDirectory(root: string, path: string) {
    let target = root
    for (const part of path.split("/").filter(Boolean)) {
      target = join(target, part)
      const stat = await lstat(target)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ReviewPathError("Project directory is not a real directory")
      if (!inside(root, await realpath(target))) throw new ReviewPathError("Project directory escapes workspace")
    }
    return target
  }
  async function scan(path: string, query?: string): Promise<{ entries: ProjectFileEntry[]; truncated: boolean }> {
    const root = await realpath(configuredRoot)
    let visited = 0, truncated = false
    const entries: ProjectFileEntry[] = []
    async function walk(folder: string, depth: number): Promise<void> {
      if (visited >= SCAN || depth > MAX_DEPTH) { truncated = true; return }
      await checkedDirectory(root, folder)
      const pins: PinnedProjectDirectory[] = []
      let dir: Awaited<ReturnType<typeof opendir>> | undefined
      try {
        const rootPin = await openPinnedProjectDirectory(root)
        pins.push(rootPin)
        if (relative(root, rootPin.finalPath) !== "") throw new ReviewPathError("Project root handle changed")
        let parent = rootPin
        for (const part of folder.split("/").filter(Boolean)) {
          const childPin = await openPinnedProjectDirectory(join(parent.scanPath, part))
          pins.push(childPin)
          if (!inside(root, childPin.finalPath)) throw new ReviewPathError("Project directory handle escapes workspace")
          parent = childPin
        }
        const target = parent.scanPath
        dir = await opendir(target)
        for await (const row of dir) {
          if (++visited > SCAN) { truncated = true; break }
          if (row.isSymbolicLink() || [".git", "node_modules"].includes(row.name)) continue
          const childPath = folder ? `${folder}/${row.name}` : row.name
          // Revalidate each name: directory entries can change after enumeration.
          const child = join(target, row.name), stat = await lstat(child).catch(() => undefined)
          if (!stat || stat.isSymbolicLink() || !inside(root, await realpath(child))) continue
          if (stat.isDirectory()) {
            if (query === undefined) entries.push({ path: childPath, name: row.name, kind: "directory" })
            else await walk(childPath, depth + 1)
          } else if (stat.isFile() && (query === undefined || childPath.toLocaleLowerCase().includes(query))) entries.push({ path: childPath, name: row.name, kind: "file" })
          if (visited >= SCAN) { truncated = true; break }
        }
        await checkedDirectory(root, folder)
        if (await realpath(configuredRoot) !== root) throw new ReviewPathError("Project root changed during scan")
      } finally {
        await dir?.close().catch(() => {})
        for (const pin of pins.reverse()) await pin.close()
      }
    }
    await walk(path, 0)
    entries.sort((a, b) => a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === "directory" ? -1 : 1)
    return { entries, truncated }
  }
  return {
    async list(path: unknown, offset: unknown = 0): Promise<ProjectFilePage> {
      const checked = projectRelativePath(path, true), start = offsetOf(offset), result = await scan(checked)
      return { entries: result.entries.slice(start, start + PAGE), nextOffset: start + PAGE < result.entries.length ? start + PAGE : null, truncated: result.truncated }
    },
    async search(query: unknown, offset: unknown = 0): Promise<ProjectFilePage> {
      if (typeof query !== "string" || query.length > 512 || /[\0\r\n]/.test(query)) throw new Error("Invalid project filename query")
      const start = offsetOf(offset), result = await scan("", query.toLocaleLowerCase())
      return { entries: result.entries.slice(start, start + PAGE), nextOffset: start + PAGE < result.entries.length ? start + PAGE : null, truncated: result.truncated }
    },
    read(path: unknown) { return review.file(projectRelativePath(path)) },
    save(path: unknown, text: string, expectedRevision: string) { return review.saveFile(projectRelativePath(path), text, expectedRevision) },
  }
}
export type ProjectFiles = ReturnType<typeof createProjectFiles>

/** Router integration calls this only for recognized project-files methods. */
export async function dispatchGatewayProjectFiles(method: string, params: unknown, files: ProjectFiles): Promise<unknown> {
  const p = params as Record<string, unknown> | null
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("Invalid project files parameters")
  if (method === "desktop/project-files/list") return files.list(p.path, p.offset)
  if (method === "desktop/project-files/search") return files.search(p.query, p.offset)
  if (method === "desktop/project-files/read") return files.read(p.path)
  if (method === "desktop/project-files/save" && typeof p.text === "string" && typeof p.expectedRevision === "string") return files.save(p.path, p.text, p.expectedRevision)
  throw new Error("Invalid project files request")
}
