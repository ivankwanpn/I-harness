import { afterEach, expect, it } from "vitest"
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPinnedProjectContentReader, type ProjectContentBudget } from "../src/project-content-reader.ts"
import { openPinnedFileForReview } from "../src/review-handle.ts"

const homes: string[] = []
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }) })
async function fixture() { const home = await mkdtemp(join(tmpdir(), "ih-content-reader-")); homes.push(home); return home }
const query = { pattern: "needle", mode: "literal", case: "sensitive", before: 0, after: 0, includes: [], excludes: [], hidden: false, respectIgnore: true, regexEngine: "default", multiline: false, encoding: "auto", maxResults: 250, maxResultBytes: 262144, timeoutMs: 30000 } as const
function budget(input = 32 * 1024 * 1024, file = 1024 * 1024): ProjectContentBudget { return { maxInputBytes: input, maxFileBytes: file, maxCandidates: 1000, reserved: 0, entries: 0, pathBytes: 0, policyFiles: 0, reasons: new Set(), diagnostics: [], stats: { candidateFiles: 0, attemptedFiles: 0, readFiles: 0, completedFiles: 0, eofFiles: 0, inputBytes: 0, engineRawBytes: 0, runnerRawBytes: 0 } } }

it("captures an explicitly selected aliased root as readonly external bytes", async () => {
  const root = await fixture(), outside = await fixture(), original = `${root}-saved`; homes.push(original)
  await writeFile(join(outside, "secret.txt"), "secret")
  await rename(root, original); await symlink(outside, root, process.platform === "win32" ? "junction" : "dir")
  const limits = budget()
  const reader = await createPinnedProjectContentReader(root, limits, new AbortController().signal)
  try { const result = await reader.read("secret.txt", 1024); expect(result).toMatchObject({ external: true, readonly: true }); expect(result?.bytes.toString()).toBe("secret"); expect(limits.stats.inputBytes).toBe(6) }
  finally { await reader.close() }
})

it("reads an intentional external leaf alias as readonly while a replace-after-check race remains refused", async () => {
  const root = await fixture(), outside = await fixture()
  await writeFile(join(outside, "secret.txt"), "outside secret"); await symlink(join(outside, "secret.txt"), join(root, "link.txt"), "file")
  const reader = await createPinnedProjectContentReader(root, budget(), new AbortController().signal)
  try { const result = await reader.read("link.txt", 1024); expect(result).toMatchObject({ external: true, readonly: true }); expect(result?.bytes.toString()).toBe("outside secret") }
  finally { await reader.close() }
})

it("refuses an outside leaf handle before calling its read method after replacement", async () => {
  const root = await fixture(), outside = await fixture(), leaf = join(root, "leaf.txt"), saved = join(root, "saved.txt")
  await writeFile(leaf, "inside"); await writeFile(join(outside, "secret.txt"), "outside secret")
  let outsideReads = 0
  const limits = budget(), reader = await createPinnedProjectContentReader(root, limits, new AbortController().signal, { async openFile(path) {
    await rename(leaf, saved); await symlink(join(outside, "secret.txt"), leaf, "file")
    const handle = await openPinnedFileForReview(path)
    return { ...handle, async read(maxBytes) { outsideReads++; return handle.read(maxBytes) } }
  } })
  try { expect(await reader.read("leaf.txt", 1024)).toBeUndefined(); expect(outsideReads).toBe(0); expect(limits.stats.inputBytes).toBe(0); expect(limits.reasons.has("file-unavailable")).toBe(true) }
  finally { await reader.close() }
})

it("reserves the last aggregate bytes before four real reads and never invents EOF at an exact boundary", async () => {
  const root = await fixture(); for (const name of ["a", "b", "c", "d"]) await writeFile(join(root, name), "1234567890")
  const limits = budget(15, 10), reader = await createPinnedProjectContentReader(root, limits, new AbortController().signal)
  try {
    const snapshots = []; for await (const value of reader.snapshots(["a", "b", "c", "d"])) snapshots.push(value)
    expect(limits.stats).toMatchObject({ inputBytes: 15, readFiles: 2, eofFiles: 0 })
    expect(snapshots.map(row => row.bytes.length)).toEqual([10, 5]); expect(snapshots.every(row => !row.eof)).toBe(true)
    expect(limits.reserved).toBe(0); expect(limits.reasons.has("input-byte-limit")).toBe(true)
  } finally { await reader.close() }
})

it("applies pinned local ignore precedence, deeper rules, escaped spaces and ignored-parent behavior", async () => {
  const root = await fixture()
  await mkdir(join(root, "nested")); await mkdir(join(root, "ignored")); await mkdir(join(root, "node_modules"))
  for (const path of ["skip.txt", "keep.txt", "higher.txt", "with space.txt", ".hidden", "nested/keep.txt", "ignored/keep.txt", "node_modules/keep.txt"]) await writeFile(join(root, path), "needle")
  await writeFile(join(root, ".gitignore"), "*.txt\n!keep.txt\nignored/\nwith\\ space.txt\n")
  await writeFile(join(root, ".ignore"), "!skip.txt\n")
  await writeFile(join(root, ".rgignore"), "skip.txt\n!higher.txt\n")
  await writeFile(join(root, "nested", ".gitignore"), "keep.txt\n")
  const limits = budget(), reader = await createPinnedProjectContentReader(root, limits, new AbortController().signal)
  try { expect((await reader.candidates({ ...query, includes: [], excludes: [] })).sort()).toEqual(["higher.txt", "keep.txt"]); expect(limits.reasons.size).toBe(0) }
  finally { await reader.close() }
})

it("marks policy boundary incompleteness instead of claiming the ignore rules were completely read", async () => {
  const root = await fixture(); await writeFile(join(root, ".gitignore"), "#".repeat(65536)); await writeFile(join(root, "a.txt"), "needle")
  const limits = budget(), reader = await createPinnedProjectContentReader(root, limits, new AbortController().signal)
  try { await reader.candidates({ ...query, includes: [], excludes: [] }); expect(limits.reasons.has("ignore-policy-incomplete")).toBe(true); expect(limits.stats.inputBytes).toBe(65536) }
  finally { await reader.close() }
})
