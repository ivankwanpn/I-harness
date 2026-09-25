import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkspaceReview } from "../src/review.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function workspace(git = true) {
  const root = mkdtempSync(join(tmpdir(), "ih-desktop-review-"))
  roots.push(root)
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: root })
    execFileSync("git", ["config", "user.email", "review@example.test"], { cwd: root })
    execFileSync("git", ["config", "user.name", "Review Test"], { cwd: root })
    writeFileSync(join(root, "tracked.txt"), "before\n", "utf8")
    execFileSync("git", ["add", "tracked.txt"], { cwd: root })
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: root })
  }
  return root
}

describe("workspace review remains read-only and honest", () => {
  it("lists workspace changes and shows staged plus unstaged edits from HEAD", async () => {
    const root = workspace()
    writeFileSync(join(root, "tracked.txt"), "staged\n", "utf8")
    execFileSync("git", ["add", "tracked.txt"], { cwd: root })
    writeFileSync(join(root, "tracked.txt"), "latest\n", "utf8")
    const beforeStatus = execFileSync("git", ["status", "--porcelain=v1"], { cwd: root }).toString("utf8")
    const beforeContent = readFileSync(join(root, "tracked.txt"), "utf8")
    const review = createWorkspaceReview(root)
    const changes = await review.changes()
    expect(changes).toMatchObject({ kind: "ok", truncated: false })
    if (changes.kind !== "ok") throw new Error("changes unavailable")
    expect(changes.files).toContainEqual(expect.objectContaining({ path: "tracked.txt", status: "modified", canDiff: true }))
    const diff = await review.diff("tracked.txt")
    expect(diff.kind).toBe("text")
    if (diff.kind !== "text") throw new Error("diff unavailable")
    expect(diff.text).toContain("+latest")
    expect(diff.text).toContain("-before")
    expect(execFileSync("git", ["status", "--porcelain=v1"], { cwd: root }).toString("utf8")).toBe(beforeStatus)
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe(beforeContent)
  })

  it("distinguishes untracked files and a directory without Git from no changes", async () => {
    const root = workspace()
    writeFileSync(join(root, "new.txt"), "new\n", "utf8")
    const review = createWorkspaceReview(root)
    const changes = await review.changes()
    expect(changes.kind).toBe("ok")
    if (changes.kind !== "ok") throw new Error("changes unavailable")
    expect(changes.files).toContainEqual(expect.objectContaining({ path: "new.txt", status: "untracked", canDiff: false }))
    expect(await review.diff("new.txt")).toEqual({ kind: "unavailable", reason: "untracked" })
    expect(await createWorkspaceReview(workspace(false)).changes()).toEqual({ kind: "unavailable", reason: "not-git-repo" })
  })

  it("reports paths relative to a workspace nested inside a Git repository", async () => {
    const repo = workspace()
    const nested = join(repo, "subproject")
    mkdirSync(nested)
    writeFileSync(join(nested, "note.txt"), "old\n", "utf8")
    execFileSync("git", ["add", "subproject/note.txt"], { cwd: repo })
    execFileSync("git", ["commit", "-qm", "nested seed"], { cwd: repo })
    writeFileSync(join(nested, "note.txt"), "new\n", "utf8")
    writeFileSync(join(repo, "tracked.txt"), "changed outside workspace\n", "utf8")
    const review = createWorkspaceReview(nested)
    const changes = await review.changes()
    expect(changes).toMatchObject({ kind: "ok", truncated: false })
    if (changes.kind !== "ok") throw new Error("changes unavailable")
    expect(changes.files.map((row) => row.path)).toEqual(["note.txt"])
    const diff = await review.diff("note.txt")
    expect(diff.kind).toBe("text")
    if (diff.kind !== "text") throw new Error("diff unavailable")
    expect(diff.text).toContain("+new")
  })

  it("caps file lists and previews without reading outside the workspace", async () => {
    const root = workspace()
    for (let i = 0; i < 501; i++) writeFileSync(join(root, `new-${String(i).padStart(3, "0")}.txt`), "x")
    const review = createWorkspaceReview(root)
    const changes = await review.changes()
    expect(changes.kind).toBe("ok")
    if (changes.kind !== "ok") throw new Error("changes unavailable")
    expect(changes.files).toHaveLength(500)
    expect(changes.truncated).toBe(true)
    writeFileSync(join(root, "large.txt"), "z".repeat(2 * 1024 * 1024), "utf8")
    const preview = await review.file("large.txt")
    expect(preview.kind).toBe("text")
    if (preview.kind !== "text") throw new Error("preview unavailable")
    expect(Buffer.byteLength(preview.text, "utf8")).toBeLessThanOrEqual(256 * 1024)
    expect(preview.truncated).toBe(true)
    await expect(review.file("../outside.txt")).rejects.toThrow()
    await expect(review.file(join(root, "large.txt"))).rejects.toThrow()
  })

  it("bounds a multi-megabyte diff without splitting UTF-8 text", async () => {
    const root = workspace()
    writeFileSync(join(root, "tracked.txt"), "🙂".repeat(800_000), "utf8")
    const diff = await createWorkspaceReview(root).diff("tracked.txt", 2 * 1024 * 1024)
    expect(diff.kind).toBe("text")
    if (diff.kind !== "text") throw new Error("diff unavailable")
    expect(Buffer.byteLength(diff.text, "utf8")).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(diff.text).not.toContain("�")
    expect(diff.truncated).toBe(true)
  })

  it("reports binary and deleted files as distinct unavailable states", async () => {
    const root = workspace()
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]))
    execFileSync("git", ["add", "binary.dat"], { cwd: root })
    execFileSync("git", ["commit", "-qm", "binary seed"], { cwd: root })
    writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2, 4]))
    rmSync(join(root, "tracked.txt"))
    const review = createWorkspaceReview(root)
    expect(await review.diff("binary.dat")).toEqual({ kind: "unavailable", reason: "binary" })
    expect(await review.file("binary.dat")).toEqual({ kind: "unavailable", reason: "binary" })
    expect(await review.diff("tracked.txt")).toEqual({ kind: "unavailable", reason: "deleted" })
    expect(await review.file("tracked.txt")).toEqual({ kind: "unavailable", reason: "deleted" })
  })

  it("does not render invalid UTF-8 bytes as text", async () => {
    const root = workspace()
    writeFileSync(join(root, "invalid.dat"), Buffer.from([0xff, 0xfe, 0xfd]))
    expect(await createWorkspaceReview(root).file("invalid.dat")).toEqual({ kind: "unavailable", reason: "binary" })
  })

  it("does not confuse a repository without HEAD with a clean repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "ih-desktop-review-no-head-"))
    roots.push(root)
    execFileSync("git", ["init", "-q"], { cwd: root })
    expect(await createWorkspaceReview(root).changes()).toEqual({ kind: "unavailable", reason: "no-head" })
  })

  it("refuses a symlink escape even when a directory changes between validation and open", async () => {
    const root = workspace()
    const outside = mkdtempSync(join(tmpdir(), "ih-desktop-review-outside-"))
    roots.push(outside)
    writeFileSync(join(outside, "secret.txt"), "outside-secret", "utf8")
    const folder = join(root, "folder")
    mkdirSync(folder)
    writeFileSync(join(folder, "secret.txt"), "inside", "utf8")
    let swapped = false
    const review = createWorkspaceReview(root, {
      openFile: async (path) => {
        if (!swapped) {
          renameSync(folder, join(root, "old-folder"))
          symlinkSync(outside, folder, "junction")
          swapped = true
        }
        return open(path, "r")
      },
    })
    await expect(review.file("folder/secret.txt")).rejects.toThrow()
    expect(swapped).toBe(true)
    expect(existsSync(join(outside, "secret.txt"))).toBe(true)
  })
})
