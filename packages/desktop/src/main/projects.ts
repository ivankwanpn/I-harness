import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import type { WorkspaceCatalog, WorkspaceEntry } from "./workspaces.ts"

export interface ProjectEntry {
  id: string
  name: string
  workspaceIds: string[]
  primaryWorkspaceId?: string
  pinned?: boolean
  createdAt: string
  updatedAt: string
}
export type Project = ProjectEntry
export interface ProjectInput {
  id?: string
  name: string
  workspaceIds: string[]
  primaryWorkspaceId?: string
  pinned?: boolean
  expectedUpdatedAt?: string
}
export type ProjectSaveInput = ProjectInput
export interface ProjectCatalog {
  list(): Promise<ProjectEntry[]>
  save(input: ProjectInput): Promise<ProjectEntry>
  remove(id: string): Promise<void>
  unassigned(): Promise<WorkspaceEntry[]>
}

export class ProjectCatalogError extends Error {
  constructor(message: string, public readonly code: "invalid-project-input" | "unknown-project" | "corrupt-project-catalog" | "project-storage-error" | "project-conflict", cause?: unknown) {
    super(message, { cause })
    this.name = "ProjectCatalogError"
  }
}

const copyProject = (row: ProjectEntry): ProjectEntry => ({ ...row, workspaceIds: [...row.workspaceIds] })
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const controls = /[\u0000-\u001f\u007f]/

function checkedInput(value: unknown, workspaces: WorkspaceCatalog): ProjectInput {
  if (!isRecord(value)) throw new ProjectCatalogError("Project input must be an object", "invalid-project-input")
  const name = typeof value.name === "string" ? value.name.trim() : ""
  if (name === "" || Array.from(name).length > 256 || controls.test(name)) {
    throw new ProjectCatalogError("Project name must contain 1 to 256 characters on one line", "invalid-project-input")
  }
  if (value.id !== undefined && (typeof value.id !== "string" || value.id === "")) {
    throw new ProjectCatalogError("Project ID must identify an existing project", "invalid-project-input")
  }
  if (!Array.isArray(value.workspaceIds) || value.workspaceIds.some((id) => typeof id !== "string" || !workspaces.get(id))) {
    throw new ProjectCatalogError("Project workspace IDs must refer to known folder workspaces", "invalid-project-input")
  }
  const workspaceIds = value.workspaceIds as string[]
  if (new Set(workspaceIds).size !== workspaceIds.length) {
    throw new ProjectCatalogError("Project contains duplicate workspace IDs", "invalid-project-input")
  }
  if (value.primaryWorkspaceId !== undefined && (typeof value.primaryWorkspaceId !== "string" || !workspaceIds.includes(value.primaryWorkspaceId))) {
    throw new ProjectCatalogError("Primary workspace must be a project member", "invalid-project-input")
  }
  if (value.pinned !== undefined && typeof value.pinned !== "boolean") {
    throw new ProjectCatalogError("Project pinned state must be a boolean", "invalid-project-input")
  }
  if (value.expectedUpdatedAt !== undefined && !isTimestamp(value.expectedUpdatedAt)) {
    throw new ProjectCatalogError("Project revision must be an ISO timestamp", "invalid-project-input")
  }
  return {
    name, workspaceIds: [...workspaceIds],
    ...(value.id === undefined ? {} : { id: value.id as string }),
    ...(value.primaryWorkspaceId === undefined ? {} : { primaryWorkspaceId: value.primaryWorkspaceId as string }),
    ...(value.pinned === undefined ? {} : { pinned: value.pinned as boolean }),
    ...(value.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: value.expectedUpdatedAt as string }),
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function parseProjects(raw: string, workspaces: WorkspaceCatalog): ProjectEntry[] {
  const document: unknown = JSON.parse(raw)
  if (!isRecord(document) || document.version !== 1 || !Array.isArray(document.projects)) throw new Error("unsupported project document")
  const ids = new Set<string>()
  return document.projects.map((value) => {
    const input = checkedInput(value, workspaces)
    if (!isRecord(value) || input.id === undefined || ids.has(input.id) || input.name !== value.name
      || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.createdAt) {
      throw new Error("invalid or duplicate project row")
    }
    ids.add(input.id)
    const { expectedUpdatedAt: _expected, ...fields } = input
    return { ...fields, id: input.id, createdAt: value.createdAt, updatedAt: value.updatedAt }
  })
}

/** Desktop-local project metadata references existing folder IDs. Opening the
 * catalog never reads storage or throws, so a damaged document can be shown as
 * a navigation error without preventing Desktop startup. */
export function createProjectCatalog(filePath: string, workspaces: WorkspaceCatalog): ProjectCatalog {
  let rows: ProjectEntry[] | undefined
  let corrupt: ProjectCatalogError | undefined
  let tail: Promise<unknown> = Promise.resolve()

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  async function writeRows(next: ProjectEntry[]): Promise<void> {
    const temp = `${filePath}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(filePath), { recursive: true })
      const file = await open(temp, "wx", 0o600)
      try {
        await file.writeFile(`${JSON.stringify({ version: 1, projects: next }, null, 2)}\n`, "utf8")
        await file.sync()
      } finally { await file.close() }
      await rename(temp, filePath)
    } catch (cause) {
      throw new ProjectCatalogError("Could not save the Desktop project catalog", "project-storage-error", cause)
    } finally { await rm(temp, { force: true }) }
  }

  async function load(): Promise<ProjectEntry[]> {
    if (corrupt) throw corrupt
    if (rows !== undefined) return rows
    let raw: string
    try { raw = await readFile(filePath, "utf8") }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ProjectCatalogError("Could not read the Desktop project catalog", "project-storage-error", cause)
      }
      const known = await workspaces.list()
      const at = new Date().toISOString()
      const migrated = known.map((workspace): ProjectEntry => ({
        id: randomUUID(),
        name: Array.from(workspace.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim()).slice(0, 256).join("") || "Workspace",
        workspaceIds: [workspace.id], primaryWorkspaceId: workspace.id, pinned: false,
        createdAt: at, updatedAt: at,
      }))
      // Persist even an empty migration. A later folder is then unassigned,
      // and removing every project cannot trigger migration again on restart.
      await writeRows(migrated)
      rows = migrated
      return rows
    }
    try { rows = parseProjects(raw, workspaces); return rows }
    catch (cause) {
      corrupt = new ProjectCatalogError("Desktop project catalog is corrupt; the existing document has been preserved", "corrupt-project-catalog", cause)
      throw corrupt
    }
  }

  return {
    list() { return serial(async () => (await load()).map(copyProject)) },
    save(input) {
      // Capture caller-owned arrays before waiting for a previous write.
      const snapshot = isRecord(input) ? { ...input, workspaceIds: Array.isArray(input.workspaceIds) ? [...input.workspaceIds] : input.workspaceIds } : input
      return serial(async () => {
        const current = await load()
        const checked = checkedInput(snapshot, workspaces)
        const existing = checked.id === undefined ? undefined : current.find((row) => row.id === checked.id)
        if (checked.id !== undefined && existing === undefined) throw new ProjectCatalogError("Project no longer exists", "unknown-project")
        if (checked.expectedUpdatedAt !== undefined && checked.expectedUpdatedAt !== existing?.updatedAt) {
          throw new ProjectCatalogError("Project changed while it was being edited; reload the project before saving", "project-conflict")
        }
        const at = new Date(Math.max(Date.now(), existing ? Date.parse(existing.updatedAt) + 1 : 0)).toISOString()
        const { expectedUpdatedAt: _expected, ...fields } = checked
        const saved: ProjectEntry = { ...fields, id: existing?.id ?? randomUUID(), pinned: checked.pinned ?? existing?.pinned ?? false,
          createdAt: existing?.createdAt ?? at, updatedAt: at }
        const next = existing ? current.map((row) => row.id === existing.id ? saved : row) : [...current, saved]
        await writeRows(next)
        rows = next
        return copyProject(saved)
      })
    },
    remove(id) {
      return serial(async () => {
        const current = await load()
        if (typeof id !== "string" || !current.some((row) => row.id === id)) throw new ProjectCatalogError("Project no longer exists", "unknown-project")
        const next = current.filter((row) => row.id !== id)
        await writeRows(next)
        rows = next
      })
    },
    unassigned() {
      return serial(async () => {
        const assigned = new Set((await load()).flatMap((row) => row.workspaceIds))
        return (await workspaces.list()).filter((row) => !assigned.has(row.id))
      })
    },
  }
}
