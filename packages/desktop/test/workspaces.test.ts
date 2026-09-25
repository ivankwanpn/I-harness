import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createWorkspaceCatalog } from "../src/main/workspaces.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ih-desktop-catalog-"))
  roots.push(root)
  return root
}

describe("Desktop workspace catalog", () => {
  it("keeps one stable entry for a canonicalized folder and stays out of the workspace", async () => {
    const root = tempRoot()
    const project = join(root, "project")
    mkdirSync(project)
    const catalog = createWorkspaceCatalog(join(root, "userData", "workspaces.json"))

    const first = await catalog.open(project)
    const second = await catalog.open(join(project, "."))

    expect(second).toEqual(first)
    expect(first.label).toBe(basename(first.path))
    expect((await catalog.list()).map((row) => row.id)).toEqual([first.id])
    expect(existsSync(join(project, ".i-harness-desktop"))).toBe(false)
  })

  it("persists entries across catalog instances", async () => {
    const root = tempRoot()
    const project = join(root, "project")
    mkdirSync(project)
    const file = join(root, "userData", "workspaces.json")

    const first = await createWorkspaceCatalog(file).open(project)
    const reopened = createWorkspaceCatalog(file)

    expect(reopened.get(first.id)).toEqual(first)
    expect(await reopened.list()).toEqual([first])
  })

  it("rejects a missing folder and a file path", async () => {
    const root = tempRoot()
    const file = join(root, "plain.txt")
    writeFileSync(file, "not a folder", "utf8")
    const catalog = createWorkspaceCatalog(join(root, "userData", "workspaces.json"))

    await expect(catalog.open(join(root, "missing"))).rejects.toThrow()
    await expect(catalog.open(file)).rejects.toThrow(/directory/i)
    expect(await catalog.list()).toEqual([])
  })

  it("returns undefined for an unknown id and tolerates corrupt storage", async () => {
    const root = tempRoot()
    const project = join(root, "project")
    mkdirSync(project)
    const file = join(root, "userData", "workspaces.json")
    mkdirSync(join(root, "userData"))
    writeFileSync(file, "{ not json", "utf8")

    const catalog = createWorkspaceCatalog(file)
    expect(await catalog.list()).toEqual([])
    expect(catalog.get("missing")).toBeUndefined()

    const opened = await catalog.open(project)
    expect(catalog.get(opened.id)).toEqual(opened)
    expect(JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")))).toEqual([opened])
  })
})
