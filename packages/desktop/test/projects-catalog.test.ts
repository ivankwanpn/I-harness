import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkspaceCatalog } from "../src/main/workspaces.ts"
import { createProjectCatalog } from "../src/main/projects.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(count = 2) {
  const root = mkdtempSync(join(tmpdir(), "ih-desktop-projects-"))
  roots.push(root)
  const userData = join(root, "userData")
  const workspaceFile = join(userData, "workspaces.json")
  const projectsFile = join(userData, "projects.json")
  const workspaces = createWorkspaceCatalog(workspaceFile)
  const folders = []
  for (let index = 0; index < count; index++) {
    const path = join(root, `folder-${index}`)
    mkdirSync(path)
    folders.push(await workspaces.open(path))
  }
  return { root, userData, workspaceFile, projectsFile, workspaces, folders }
}

describe("Desktop local project catalog", () => {
  it("migrates existing folders once while preserving workspace IDs and files", async () => {
    const setup = await fixture()
    const before = readFileSync(setup.workspaceFile, "utf8")
    const sessionFile = join(setup.folders[0]!.path, ".i-harness", "sessions", "existing.jsonl")
    mkdirSync(join(setup.folders[0]!.path, ".i-harness", "sessions"), { recursive: true })
    writeFileSync(sessionFile, "existing-session\n", "utf8")
    const projects = createProjectCatalog(setup.projectsFile, setup.workspaces)
    const rows = await projects.list()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => ({ name: row.name, members: row.workspaceIds, primary: row.primaryWorkspaceId }))).toEqual([
      { name: "folder-0", members: [setup.folders[0]!.id], primary: setup.folders[0]!.id },
      { name: "folder-1", members: [setup.folders[1]!.id], primary: setup.folders[1]!.id },
    ])
    expect(readFileSync(setup.workspaceFile, "utf8")).toBe(before)
    expect(readFileSync(sessionFile, "utf8")).toBe("existing-session\n")
    expect(await createProjectCatalog(setup.projectsFile, setup.workspaces).list()).toEqual(rows)
    const later = join(setup.root, "later-folder")
    mkdirSync(later)
    const added = await setup.workspaces.open(later)
    expect(await projects.list()).toEqual(rows)
    expect((await projects.unassigned()).map((row) => row.id)).toEqual([added.id])
  })

  it("allows the same canonical folder in multiple projects with a primary member", async () => {
    const setup = await fixture()
    const catalog = createProjectCatalog(setup.projectsFile, setup.workspaces)
    await catalog.list()
    const created = await catalog.save({ name: "  Product  ", workspaceIds: setup.folders.map((row) => row.id), primaryWorkspaceId: setup.folders[1]!.id, pinned: true })
    expect(created).toMatchObject({ name: "Product", workspaceIds: [setup.folders[0]!.id, setup.folders[1]!.id], primaryWorkspaceId: setup.folders[1]!.id, pinned: true })
    expect((await catalog.list()).filter((row) => row.workspaceIds.includes(setup.folders[0]!.id))).toHaveLength(2)
    expect(await catalog.unassigned()).toEqual([])
    expect(await setup.workspaces.open(join(setup.folders[0]!.path, "."))).toEqual(setup.folders[0])
  })

  it("refuses a stale rename that would remove a folder added by a newer save", async () => {
    const setup = await fixture()
    const catalog = createProjectCatalog(setup.projectsFile, setup.workspaces)
    const original = (await catalog.list())[0]!
    const updated = await catalog.save({ ...original, workspaceIds: [setup.folders[0]!.id, setup.folders[1]!.id], expectedUpdatedAt: original.updatedAt })
    expect(updated.updatedAt > original.updatedAt).toBe(true)
    const before = readFileSync(setup.projectsFile, "utf8")
    await expect(catalog.save({ ...original, name: "Stale rename", expectedUpdatedAt: original.updatedAt })).rejects.toMatchObject({ name: "ProjectCatalogError", code: "project-conflict" })
    expect(readFileSync(setup.projectsFile, "utf8")).toBe(before)
    expect((await catalog.list()).find((row) => row.id === original.id)).toEqual(updated)
    const renamed = await catalog.save({ ...updated, name: "Fresh rename", expectedUpdatedAt: updated.updatedAt })
    expect(renamed).toMatchObject({ name: "Fresh rename", workspaceIds: [setup.folders[0]!.id, setup.folders[1]!.id] })
    expect("expectedUpdatedAt" in renamed).toBe(false)
  })

  it("serializes concurrent creates and updates and persists pins across restart", async () => {
    const setup = await fixture()
    const catalog = createProjectCatalog(setup.projectsFile, setup.workspaces)
    const migrated = await catalog.list()
    const [first, second] = await Promise.all([
      catalog.save({ name: "One", workspaceIds: [setup.folders[0]!.id] }),
      catalog.save({ name: "Two", workspaceIds: [setup.folders[1]!.id] }),
    ])
    await Promise.all([
      catalog.save({ ...first, name: "One renamed", pinned: true }),
      catalog.save({ ...second, name: "Two renamed", primaryWorkspaceId: setup.folders[1]!.id }),
    ])
    const saved = await catalog.list()
    expect(saved).toHaveLength(migrated.length + 2)
    expect(saved.find((row) => row.id === first.id)).toMatchObject({ name: "One renamed", pinned: true, createdAt: first.createdAt })
    expect(saved.find((row) => row.id === first.id)!.updatedAt > first.updatedAt).toBe(true)
    expect(await createProjectCatalog(setup.projectsFile, setup.workspaces).list()).toEqual(saved)
    expect(JSON.parse(readFileSync(setup.projectsFile, "utf8"))).toEqual({ version: 1, projects: saved })
  })

  it("removes only project metadata and exposes unassigned folders without recreating projects", async () => {
    const setup = await fixture(1)
    const folder = setup.folders[0]!
    const sessionFile = join(folder.path, "session.jsonl")
    writeFileSync(sessionFile, "durable session", "utf8")
    const workspaceBefore = readFileSync(setup.workspaceFile, "utf8")
    const catalog = createProjectCatalog(setup.projectsFile, setup.workspaces)
    const migrated = await catalog.list()
    await catalog.remove(migrated[0]!.id)
    expect(await catalog.list()).toEqual([])
    expect(await catalog.unassigned()).toEqual([folder])
    expect(setup.workspaces.get(folder.id)).toEqual(folder)
    expect(readFileSync(setup.workspaceFile, "utf8")).toBe(workspaceBefore)
    expect(readFileSync(sessionFile, "utf8")).toBe("durable session")
    expect(await createProjectCatalog(setup.projectsFile, setup.workspaces).list()).toEqual([])
  })

  it("can create an empty project and keeps returned member arrays detached", async () => {
    const setup = await fixture(0)
    const catalog = createProjectCatalog(setup.projectsFile, setup.workspaces)
    const input = { name: "Planning", workspaceIds: [] as string[] }
    const created = await catalog.save(input)
    input.workspaceIds.push("injected")
    created.workspaceIds.push("mutated")
    const rows = await catalog.list()
    expect(rows[0]).toMatchObject({ name: "Planning", workspaceIds: [] })
    rows[0]!.workspaceIds.push("changed-list")
    expect((await catalog.list())[0]!.workspaceIds).toEqual([])
  })

  it.each([
    { name: "   ", workspaceIds: [], error: /name/i },
    { name: "x".repeat(257), workspaceIds: [], error: /name/i },
    { name: "bad\nname", workspaceIds: [], error: /name/i },
    { name: "Wrong folder", workspaceIds: ["../outside"], error: /workspace/i },
    { name: "Absolute folder bypass", workspaceIds: ["D:\\outside"], error: /workspace/i },
  ])("refuses invalid names or unknown folder scope without changing saved metadata: $name", async (input) => {
    const setup = await fixture()
    const catalog = createProjectCatalog(setup.projectsFile, setup.workspaces)
    await catalog.list()
    const before = readFileSync(setup.projectsFile, "utf8")
    await expect(catalog.save({ name: input.name, workspaceIds: input.workspaceIds })).rejects.toThrow(input.error)
    expect(readFileSync(setup.projectsFile, "utf8")).toBe(before)
  })

  it("refuses duplicate memberships and a primary folder outside the project", async () => {
    const setup = await fixture()
    const catalog = createProjectCatalog(setup.projectsFile, setup.workspaces)
    await catalog.list()
    await expect(catalog.save({ name: "Duplicate", workspaceIds: [setup.folders[0]!.id, setup.folders[0]!.id] })).rejects.toThrow(/duplicate/i)
    await expect(catalog.save({ name: "Primary outside", workspaceIds: [setup.folders[0]!.id], primaryWorkspaceId: setup.folders[1]!.id })).rejects.toThrow(/primary/i)
    await expect(catalog.save({ name: "Bad update", id: "missing", workspaceIds: [] })).rejects.toThrow(/project/i)
    expect(await catalog.list()).toHaveLength(2)
    expect(await catalog.save({ name: "Valid after failures", workspaceIds: [] })).toMatchObject({ name: "Valid after failures" })
  })

  it.each(["{ invalid json", JSON.stringify({ version: 1, projects: [{ id: "broken" }] }), JSON.stringify({ version: 99, projects: [] })])("reports corrupted project storage and refuses every write", async (raw) => {
    const setup = await fixture()
    writeFileSync(setup.projectsFile, raw, "utf8")
    const catalog = createProjectCatalog(setup.projectsFile, setup.workspaces)
    await expect(catalog.list()).rejects.toMatchObject({ name: "ProjectCatalogError", code: "corrupt-project-catalog" })
    await expect(catalog.save({ name: "New", workspaceIds: [] })).rejects.toThrow()
    await expect(catalog.remove("anything")).rejects.toThrow()
    expect(readFileSync(setup.projectsFile, "utf8")).toBe(raw)
  })

  it("reports duplicate persisted IDs and unknown persisted folder references without rewriting them", async () => {
    const setup = await fixture()
    const original = await createProjectCatalog(setup.projectsFile, setup.workspaces).list()
    const duplicate = { version: 1, projects: [original[0], original[0]] }
    const unknown = { version: 1, projects: [{ ...original[0], workspaceIds: ["../outside"], primaryWorkspaceId: "../outside" }] }
    for (const document of [duplicate, unknown]) {
      const raw = JSON.stringify(document)
      writeFileSync(setup.projectsFile, raw, "utf8")
      const catalog = createProjectCatalog(setup.projectsFile, setup.workspaces)
      await expect(catalog.list()).rejects.toMatchObject({ name: "ProjectCatalogError", code: "corrupt-project-catalog" })
      await expect(catalog.save({ name: "Recovery", workspaceIds: [] })).rejects.toThrow()
      expect(readFileSync(setup.projectsFile, "utf8")).toBe(raw)
    }
  })

  it("preserves the last committed document and recovers the serial queue after a write fails", async () => {
    const setup = await fixture()
    const catalog = createProjectCatalog(setup.projectsFile, setup.workspaces)
    const before = await catalog.list()
    const data = readFileSync(setup.projectsFile, "utf8")
    rmSync(setup.projectsFile)
    mkdirSync(setup.projectsFile)
    await expect(catalog.save({ name: "Failed write", workspaceIds: [] })).rejects.toThrow()
    expect(await catalog.list()).toEqual(before)
    expect(readdirSync(setup.userData).sort()).toEqual(["projects.json", "workspaces.json"])
    rmSync(setup.projectsFile, { recursive: true })
    writeFileSync(setup.projectsFile, data, "utf8")
    expect(await catalog.save({ name: "Retry", workspaceIds: [] })).toMatchObject({ name: "Retry" })
    expect(await catalog.list()).toHaveLength(before.length + 1)
  })

})
