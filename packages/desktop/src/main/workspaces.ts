import { readFileSync } from "node:fs"
import { mkdir, realpath, rename, stat, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { basename, dirname } from "node:path"

export interface WorkspaceEntry {
  id: string
  path: string
  label: string
  worktree?: WorkspaceWorktree
}

export interface WorkspaceWorktree {
  sourceWorkspaceId: string
  projectId: string
  gitCommonDir: string
  gitDir: string
  kind: "managed" | "imported"
  operationId?: string
  offered?: boolean
}

export interface WorkspaceCatalog {
  /** Canonicalize `path`, then persist and return its stable entry. */
  open(path: string): Promise<WorkspaceEntry>
  registerWorktree?(path: string, worktree: WorkspaceWorktree): Promise<WorkspaceEntry>
  setWorktreeOffered?(id: string, offered: boolean): Promise<void>
  relocateWorktree?(id: string, path: string): Promise<WorkspaceEntry>
  list(): Promise<WorkspaceEntry[]>
  /** Read-only lookup for already-known working sets. */
  get(id: string): WorkspaceEntry | undefined
}

function isEntry(value: unknown): value is WorkspaceEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.id === "string" && row.id !== ""
    && typeof row.path === "string" && row.path !== ""
    && typeof row.label === "string" && (row.worktree === undefined || isWorktree(row.worktree))
}

function isWorktree(value: unknown): value is WorkspaceWorktree {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Partial<WorkspaceWorktree>
  return typeof row.sourceWorkspaceId === "string" && !!row.sourceWorkspaceId
    && typeof row.projectId === "string" && !!row.projectId
    && typeof row.gitCommonDir === "string" && !!row.gitCommonDir
    && typeof row.gitDir === "string" && !!row.gitDir
    && (row.offered === undefined || typeof row.offered === "boolean")
    && (row.kind === "managed" && typeof row.operationId === "string" && /^[0-9a-f]{64}$/.test(row.operationId)
      || row.kind === "imported" && row.operationId === undefined)
}

const copy = (row: WorkspaceEntry): WorkspaceEntry => ({
  id: row.id, path: row.path, label: row.label, ...(row.worktree ? { worktree: { ...row.worktree } } : {}),
})

const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path

/**
 * This file holds Desktop-local navigation metadata only. A damaged catalog is
 * treated as empty because it is regenerable and never session truth.
 */
function readRowsSync(file: string): WorkspaceEntry[] {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const rows: WorkspaceEntry[] = []
    const seen = new Set<string>()
    for (const value of parsed) {
      if (!isEntry(value) || seen.has(pathKey(value.path))) continue
      seen.add(pathKey(value.path))
      rows.push(copy(value))
    }
    return rows
  } catch {
    return []
  }
}

export function createWorkspaceCatalog(filePath: string): WorkspaceCatalog {
  let rows = readRowsSync(filePath)
  /** One read-modify-write at a time: concurrent open() calls must not lose a row. */
  let tail: Promise<unknown> = Promise.resolve()

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  async function writeRows(next: WorkspaceEntry[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const temp = `${filePath}.tmp`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8")
    await rename(temp, filePath)
  }

  async function openWorkspace(requested: string, worktree?: WorkspaceWorktree) {
    const canonical = await realpath(requested)
    if (!(await stat(canonical)).isDirectory()) throw new Error("workspace is not a directory")
    return serial(async () => {
      const existing = rows.find(row => pathKey(row.path) === pathKey(canonical))
      if (existing) {
        if (worktree && (!existing.worktree || existing.worktree.projectId !== worktree.projectId
          || pathKey(existing.worktree.gitCommonDir) !== pathKey(worktree.gitCommonDir)
          || pathKey(existing.worktree.gitDir) !== pathKey(worktree.gitDir))) {
          throw new Error("Worktree is already registered in a different workspace")
        }
        return copy(existing)
      }
      const added: WorkspaceEntry = { id: randomUUID(), path: canonical, label: basename(canonical), ...(worktree ? { worktree: { ...worktree } } : {}) }
      const next = [...rows, added]
      await writeRows(next)
      rows = next
      return copy(added)
    })
  }

  return {
    open: requested => openWorkspace(requested),
    registerWorktree: (requested, worktree) => openWorkspace(requested, worktree),
    setWorktreeOffered(id, offered) {
      return serial(async () => {
        const current = rows.find(row => row.id === id)
        if (!current?.worktree) throw new Error("Worktree is not registered")
        if ((current.worktree.offered ?? true) === offered) return
        const next = rows.map(row => row === current ? { ...row, worktree: { ...current.worktree!, offered } } : row)
        await writeRows(next)
        rows = next
      })
    },
    relocateWorktree(id, path) {
      return serial(async () => {
        const current = rows.find(row => row.id === id)
        if (!current?.worktree) throw new Error("Worktree is not registered")
        if (pathKey(current.path) === pathKey(path)) return copy(current)
        if (rows.some(row => row !== current && pathKey(row.path) === pathKey(path))) {
          throw new Error("The worktree's new path is already registered")
        }
        const entry = { ...current, path, label: basename(path) }
        const next = rows.map(row => row === current ? entry : row)
        await writeRows(next)
        rows = next
        return copy(entry)
      })
    },
    async list() {
      await tail
      return rows.map(copy)
    },
    get(id) {
      const row = rows.find((candidate) => candidate.id === id)
      return row && copy(row)
    },
  }
}
