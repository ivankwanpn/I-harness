import { readFileSync } from "node:fs"
import { mkdir, realpath, rename, stat, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { basename, dirname } from "node:path"

export interface WorkspaceEntry {
  id: string
  path: string
  label: string
}

export interface WorkspaceCatalog {
  /** Canonicalize `path`, then persist and return its stable entry. */
  open(path: string): Promise<WorkspaceEntry>
  list(): Promise<WorkspaceEntry[]>
  /** Read-only lookup for already-known working sets. */
  get(id: string): WorkspaceEntry | undefined
}

function isEntry(value: unknown): value is WorkspaceEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.id === "string" && row.id !== ""
    && typeof row.path === "string" && row.path !== ""
    && typeof row.label === "string"
}

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
      if (!isEntry(value) || seen.has(value.path)) continue
      seen.add(value.path)
      rows.push({ id: value.id, path: value.path, label: value.label })
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

  return {
    async open(requested) {
      const canonical = await realpath(requested)
      const info = await stat(canonical)
      if (!info.isDirectory()) throw new Error("workspace is not a directory")
      return serial(async () => {
        const existing = rows.find((row) => row.path === canonical)
        if (existing !== undefined) return { ...existing }
        const added: WorkspaceEntry = { id: randomUUID(), path: canonical, label: basename(canonical) }
        const next = [...rows, added]
        await writeRows(next)
        rows = next
        return { ...added }
      })
    },
    async list() {
      await tail
      return rows.map((row) => ({ ...row }))
    },
    get(id) {
      const row = rows.find((candidate) => candidate.id === id)
      return row === undefined ? undefined : { ...row }
    },
  }
}
