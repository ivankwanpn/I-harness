import { afterEach, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProjectFiles, dispatchGatewayProjectFiles } from "../src/project-files.ts"
import { createWorkspaceReview } from "../src/review.ts"
import { openPinnedProjectDirectory } from "../src/project-directory-handle.ts"

const homes: string[] = []
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), "ih-project-tree-")); homes.push(root); return root }

it("reads a replaced root as external readonly content and refuses saving through that alias", async () => {
  const root = await fixture(), outside = await fixture(), saved = `${root}-saved`; homes.push(saved)
  const review = createWorkspaceReview(root), files = createProjectFiles(root, review)
  await writeFile(join(outside, "secret.txt"), "outside secret")
  await rename(root, saved); await symlink(outside, root, process.platform === "win32" ? "junction" : "dir")
  try {
    const result = await files.read("secret.txt")
    expect(result).toMatchObject({ kind: "text", text: "outside secret", external: true, readonly: true })
    await expect(files.save("secret.txt", "should never be written", result.kind === "text" ? result.revision! : "a".repeat(64))).rejects.toThrow(/canonical|root/i)
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("outside secret")
  }
  finally { await review.close() }
})

it("pins directory identity while Windows rejects replacement and Linux scans through its descriptor", async () => {
  const root = await fixture(), directory = join(root, "folder"), renamed = join(root, "moved")
  await mkdir(directory); await writeFile(join(directory, "same.txt"), "old")
  const pinned = await openPinnedProjectDirectory(directory)
  try {
    if (process.platform === "win32") await expect(rename(directory, renamed)).rejects.toThrow()
    else { await rename(directory, renamed); await mkdir(directory); await writeFile(join(directory, "same.txt"), "replacement") }
    expect(await readFile(join(pinned.scanPath, "same.txt"), "utf8")).toBe("old")
  } finally { await pinned.close() }
})

it("serves real nested tree/search and CAS save through validated gateway wire requests", async () => {
  const root = await fixture(), review = createWorkspaceReview(root), files = createProjectFiles(root, review)
  await mkdir(join(root, "nested")); await writeFile(join(root, "nested", "source.txt"), "\uFEFFhello\r\n")
  expect(await dispatchGatewayProjectFiles("desktop/project-files/list", { path: "", offset: 0 }, files)).toMatchObject({ entries: [{ path: "nested", kind: "directory" }] })
  expect(await dispatchGatewayProjectFiles("desktop/project-files/list", { path: "nested", offset: 0 }, files)).toMatchObject({ entries: [{ path: "nested/source.txt", kind: "file" }] })
  expect(await dispatchGatewayProjectFiles("desktop/project-files/search", { query: "SOURCE", offset: 0 }, files)).toMatchObject({ entries: [{ path: "nested/source.txt" }] })
  const source = await files.read("nested/source.txt")
  if (source.kind !== "text" || !source.revision) throw new Error("Missing complete revision")
  expect(await dispatchGatewayProjectFiles("desktop/project-files/save", { path: "nested/source.txt", text: "\uFEFFsaved\r\n", expectedRevision: source.revision }, files)).toMatchObject({ kind: "saved" })
  expect(await readFile(join(root, "nested", "source.txt"), "utf8")).toBe("\uFEFFsaved\r\n")
  await review.close()
})

it("wire rejects traversal, metadata edits, invalid pagination and junctions before reading outside", async () => {
  const root = await fixture(), outside = await fixture(), files = createProjectFiles(root, createWorkspaceReview(root))
  await writeFile(join(outside, "private.txt"), "outside")
  await symlink(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir")
  expect((await files.list("", 0)).entries).toEqual([])
  await expect(files.list("link")).rejects.toThrow()
  for (const path of ["../private.txt", ".git/config", "nested//file.txt", "D:/private.txt", "a:stream"]) expect(() => files.read(path)).toThrow()
  await expect(files.list("", -1)).rejects.toThrow(/offset/i)
  await expect(files.search("x", 3001)).rejects.toThrow(/offset/i)
  await expect(dispatchGatewayProjectFiles("desktop/project-files/save", { path: "file.txt", text: 1 }, files)).rejects.toThrow(/request/i)
})
