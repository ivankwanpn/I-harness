import { afterEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkspaceReview } from "../src/review.ts"
import { openPinnedFileForEdit } from "../src/review-edit-handle.ts"

const roots: string[] = []
const reviews: ReturnType<typeof createWorkspaceReview>[] = []
function trackedReview(root: string, options?: Parameters<typeof createWorkspaceReview>[1]) {
  const review = createWorkspaceReview(root, options)
  reviews.push(review)
  return review
}
async function cleanFixtures() {
  // Vitest's timeout does not cancel the test callback. Close its owned Git
  // children before removing a directory that may still be their cwd.
  await Promise.all(reviews.splice(0).map((review) => review.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}
afterEach(cleanFixtures)

function repo() {
  const root = mkdtempSync(join(tmpdir(), "ih-review-edit-"))
  roots.push(root)
  git(root, "init", "-q")
  git(root, "config", "user.email", "review@example.test")
  git(root, "config", "user.name", "Review Test")
  git(root, "config", "core.autocrlf", "false")
  writeFileSync(join(root, "source.txt"), "before\r\n", "utf8")
  git(root, "add", "source.txt")
  git(root, "commit", "-qm", "seed")
  return root
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: root }).toString("utf8")
}

async function revision(review: ReturnType<typeof createWorkspaceReview>, path = "source.txt") {
  const file = await review.file(path)
  expect(file.kind).toBe("text")
  if (file.kind !== "text") throw new Error("source unavailable")
  expect(file.revision).toMatch(/^[a-f0-9]{64}$/)
  return file.revision!
}

it("settles an active Git request before deleting its repository fixture", async () => {
  const root = repo()
  const ready = join(root, "git-ready")
  const wrapper = join(root, ".git", "waiting-git.cjs")
  writeFileSync(wrapper, "require('fs').writeFileSync('git-ready', 'ready'); setInterval(() => {}, 1000)", "utf8")
  const review = trackedReview(root, { gitCommand: { executable: process.execPath, prefixArgs: [wrapper] } })
  const outcome = review.changes().then(() => "resolved", (error: Error) => error.message)
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true))
    await cleanFixtures()
    expect(existsSync(root)).toBe(false)
    expect(await outcome).toMatch(/cancel|clos/i)
  } finally {
    await review.close()
    rmSync(root, { recursive: true, force: true })
  }
})

describe("workspace source saves", () => {
  it("preserves a UTF-8 BOM when loading and saving source", async () => {
    const root = repo()
    writeFileSync(join(root, "source.txt"), "\ufeffbefore\r\n", "utf8")
    const review = trackedReview(root)
    const file = await review.file("source.txt")
    expect(file).toMatchObject({ kind: "text", text: "\ufeffbefore\r\n" })
    if (file.kind !== "text") throw new Error("source unavailable")
    expect(await review.saveFile("source.txt", file.text.replace("before", "after"), file.revision!)).toMatchObject({ kind: "saved" })
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("\ufeffafter\r\n")
  })

  it("checks the writable handle after a junction swap and rejects hard links", async () => {
    const root = repo()
    const outside = repo()
    const folder = join(root, "folder")
    mkdirSync(folder)
    writeFileSync(join(folder, "source.txt"), "inside", "utf8")
    const reader = trackedReview(root)
    const loaded = await revision(reader, "folder/source.txt")
    const review = trackedReview(root, {
      openEditableFile: async (path) => {
        renameSync(folder, join(root, "old-folder"))
        symlinkSync(outside, folder, "junction")
        return openPinnedFileForEdit(path)
      },
    })
    await expect(review.saveFile("folder/source.txt", "escaped", loaded)).rejects.toThrow(/handle|workspace/i)
    expect(readFileSync(join(outside, "source.txt"), "utf8")).toBe("before\r\n")
    linkSync(join(outside, "source.txt"), join(root, "linked.txt"))
    await expect(reader.saveFile("linked.txt", "escaped", await revision(reader, "linked.txt"))).rejects.toThrow(/link/i)
    expect(readFileSync(join(outside, "source.txt"), "utf8")).toBe("before\r\n")
  })

  it("writes the edited UTF-8 file and returns the revision for the next save", async () => {
    const root = repo()
    const review = trackedReview(root)
    const result = await review.saveFile("source.txt", "edited 🙂\r\n", await revision(review))
    expect(result).toMatchObject({ kind: "saved", bytes: 13 })
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("edited 🙂\r\n")
    if (result.kind !== "saved") throw new Error("save failed")
    expect(await review.saveFile("source.txt", "next\n", result.revision)).toMatchObject({ kind: "saved" })
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("next\n")
  })

  it("retains external edits when the loaded revision is stale", async () => {
    const root = repo()
    const review = trackedReview(root)
    const loaded = await revision(review)
    writeFileSync(join(root, "source.txt"), "external edit\n", "utf8")
    expect(await review.saveFile("source.txt", "my edit\n", loaded)).toEqual({ kind: "conflict" })
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("external edit\n")
  })

  it("refuses traversal, Git metadata, and directory junction writes", async () => {
    const root = repo()
    const outside = repo()
    mkdirSync(join(root, "folder"))
    writeFileSync(join(root, "folder", "source.txt"), "inside", "utf8")
    const review = trackedReview(root)
    const loaded = await revision(review, "folder/source.txt")
    renameSync(join(root, "folder"), join(root, "old-folder"))
    symlinkSync(outside, join(root, "folder"), "junction")
    await expect(review.saveFile("folder/source.txt", "escaped", loaded)).rejects.toThrow(/symlink|workspace|handle/i)
    await expect(review.saveFile("../source.txt", "escaped", loaded)).rejects.toThrow()
    await expect(review.saveFile(".git/config", "escaped", loaded)).rejects.toThrow()
    expect(readFileSync(join(outside, "source.txt"), "utf8")).toBe("before\r\n")
  })

  it("does not recreate a deleted file or save a truncated preview", async () => {
    const root = repo()
    const review = trackedReview(root)
    const loaded = await revision(review)
    rmSync(join(root, "source.txt"))
    expect(await review.saveFile("source.txt", "mine", loaded)).toEqual({ kind: "unavailable", reason: "not-found" })
    writeFileSync(join(root, "large.txt"), "x".repeat(300_000))
    const file = await review.file("large.txt")
    expect(file).toMatchObject({ kind: "text", truncated: true })
    expect("revision" in file && file.revision).toBeFalsy()
    expect(await review.saveFile("large.txt", "replacement", "0".repeat(64))).toEqual({ kind: "unavailable", reason: "too-large" })
    expect(readFileSync(join(root, "large.txt"), "utf8")).toHaveLength(300_000)
  })
})

// These integration cases launch many real Git processes. A measured 28-start
// chain took 1.27s alone, 2.57s with 12 workers; the full package run exceeded
// 5s. Keep a bounded 10s deadline for this group, including repository setup.
describe("human local Git controls", { timeout: 10_000 }, () => {
  it("unstages both paths of a rename and stages a deleted file", async () => {
    const root = repo()
    const review = trackedReview(root)
    git(root, "mv", "source.txt", "renamed.txt")
    expect(await review.unstage("renamed.txt")).toEqual({ kind: "ok" })
    expect(git(root, "diff", "--cached", "--name-only")).toBe("")
    expect(await review.stage("source.txt")).toEqual({ kind: "ok" })
    expect(git(root, "diff", "--cached", "--name-status").trim()).toBe("D\tsource.txt")
    expect(readFileSync(join(root, "renamed.txt"), "utf8")).toBe("before\r\n")
  })

  it("refuses to unstage a rename that crosses a nested workspace boundary", async () => {
    const root = repo()
    mkdirSync(join(root, "nested"))
    git(root, "mv", "source.txt", "nested/source.txt")
    const review = trackedReview(join(root, "nested"))
    const index = git(root, "diff", "--cached", "--name-status")
    expect(await review.unstage("source.txt")).toEqual({ kind: "unavailable", reason: "outside-workspace" })
    expect(git(root, "diff", "--cached", "--name-status")).toBe(index)
  })

  it("commits a scoped snapshot even if another process stages an outside file during commit", async () => {
    const root = repo()
    const nested = join(root, "nested")
    mkdirSync(nested)
    writeFileSync(join(nested, "inside.txt"), "inside\n", "utf8")
    git(root, "add", "nested/inside.txt")
    const wrapper = join(root, ".git", "commit-race.cjs")
    writeFileSync(wrapper, `const {spawnSync}=require('child_process'); const {writeFileSync}=require('fs'); const {join}=require('path'); const args=process.argv.slice(2); if(args.includes('commit')) { const env={...process.env}; delete env.GIT_INDEX_FILE; writeFileSync(join(process.cwd(),'../source.txt'),'outside edit\\n'); const stage=spawnSync('git',['add','--','../source.txt'],{env}); if(stage.status!==0)process.exit(stage.status); } const result=spawnSync('git',args,{env:process.env,stdio:'inherit'}); process.exit(result.status??1);`, "utf8")
    const review = trackedReview(nested, { gitCommand: { executable: process.execPath, prefixArgs: [wrapper] } })
    expect(await review.commit("inside only")).toMatchObject({ kind: "committed" })
    expect(git(root, "show", "HEAD:source.txt")).toBe("before\r\n")
    expect(git(root, "show", "HEAD:nested/inside.txt")).toBe("inside\n")
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("source.txt")
  })

  it("stages and unstages one literal path while retaining the working file", async () => {
    const root = repo()
    writeFileSync(join(root, "source.txt"), "edited\n", "utf8")
    writeFileSync(join(root, "other.txt"), "other\n", "utf8")
    const review = trackedReview(root)
    expect(await review.stage("source.txt")).toEqual({ kind: "ok" })
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("source.txt")
    expect(await review.changes()).toMatchObject({ files: expect.arrayContaining([expect.objectContaining({ path: "other.txt", staged: false, unstaged: true }), expect.objectContaining({ path: "source.txt", staged: true, unstaged: false })]) })
    expect(await review.unstage("source.txt")).toEqual({ kind: "ok" })
    expect(git(root, "diff", "--cached", "--name-only")).toBe("")
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("edited\n")
  })

  it("stages a literal bracket path without matching another untracked file", async () => {
    const root = repo()
    const review = trackedReview(root)
    writeFileSync(join(root, "[special].txt"), "literal\n", "utf8")
    writeFileSync(join(root, "s.txt"), "not selected\n", "utf8")
    expect(await review.stage("[special].txt")).toEqual({ kind: "ok" })
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("[special].txt")
  })

  it("commits the existing index only and keeps unstaged edits", async () => {
    const root = repo()
    const review = trackedReview(root)
    writeFileSync(join(root, "source.txt"), "staged\n", "utf8")
    await review.stage("source.txt")
    writeFileSync(join(root, "source.txt"), "unstaged\n", "utf8")
    const result = await review.commit("Human commit\n\nWith details")
    expect(result).toMatchObject({ kind: "committed", commit: expect.stringMatching(/^[a-f0-9]{40,64}$/) })
    expect(git(root, "show", "HEAD:source.txt")).toBe("staged\n")
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("unstaged\n")
    expect(git(root, "log", "-1", "--format=%B").trim()).toBe("Human commit\n\nWith details")
  })

  it("refuses a commit when the index has no changes", async () => {
    const root = repo()
    const review = trackedReview(root)
    expect(await review.commit("empty index")).toEqual({ kind: "unavailable", reason: "no-changes" })
  })

  it("rejects paths outside the workspace and commits containing an outside staged path", async () => {
    const root = repo()
    mkdirSync(join(root, "nested"))
    writeFileSync(join(root, "nested", "inside.txt"), "inside\n", "utf8")
    git(root, "add", "nested/inside.txt")
    writeFileSync(join(root, "source.txt"), "outside\n", "utf8")
    git(root, "add", "source.txt")
    const review = trackedReview(join(root, "nested"))
    const head = git(root, "rev-parse", "HEAD")
    await expect(review.stage("../source.txt")).rejects.toThrow()
    expect(await review.commit("workspace commit")).toEqual({ kind: "unavailable", reason: "outside-workspace" })
    expect(git(root, "rev-parse", "HEAD")).toBe(head)
    expect(git(root, "diff", "--cached", "--name-only")).toContain("source.txt")
  })
})
