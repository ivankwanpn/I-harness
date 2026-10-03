/// <reference path="./picomatch.d.ts" />
import { lstat, opendir, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { isAbsolute, join, relative, resolve } from "node:path"
import ignore from "ignore"
import picomatch from "picomatch"
import type { SearchQuery, SearchStats } from "@i-harness/fs-search"
import { openPinnedProjectDirectory, type PinnedProjectDirectory } from "./project-directory-handle.ts"
import { openPinnedFileForReview, type PinnedReviewFile } from "./review-handle.ts"
import { projectRelativePath } from "./project-files.ts"

export interface ProjectContentReaderOptions {
  openDirectory?: typeof openPinnedProjectDirectory
  openFile?: typeof openPinnedFileForReview
}
export interface ProjectContentBudget {
  maxInputBytes: number; maxFileBytes: number; maxCandidates: number
  stats: SearchStats; reserved: number; entries: number; pathBytes: number; policyFiles: number
  reasons: Set<string>; diagnostics: string[]
  maxEntries?: number; maxPolicyFiles?: number; maxCandidateBytes?: number
  labelRoot?: string
}
type Policy = { base: string; rules: ReturnType<typeof ignore> }
const inside = (root: string, path: string) => {
  const suffix = relative(root, path)
  return suffix === "" || suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\") && !isAbsolute(suffix)
}
const same = (first: string, second: string) => relative(first, second) === ""
export function contentDiagnostic(budget: ProjectContentBudget, reason: string, detail?: string) {
  budget.reasons.add(reason)
  if (detail && budget.diagnostics.length < 16) budget.diagnostics.push(detail.slice(0, 512))
}
function reserve(budget: ProjectContentBudget, desired: number) {
  const amount = Math.max(0, Math.min(desired, budget.maxInputBytes - budget.stats.inputBytes - budget.reserved))
  budget.reserved += amount
  return amount
}

/** Reads may explicitly follow a reference alias. The original catalog root
 * remains the write boundary; every byte comes from the checked leaf handle. */
export async function createPinnedProjectContentReader(workspace: string, budget: ProjectContentBudget, signal: AbortSignal, options: ProjectContentReaderOptions = {}) {
  const configuredRoot = resolve(workspace), openDirectory = options.openDirectory ?? openPinnedProjectDirectory, openFile = options.openFile ?? openPinnedFileForReview
  signal.throwIfAborted()
  const before = await realpath(configuredRoot), rootPin = await openDirectory(before), root = rootPin.finalPath
  if (!same(before, root)) { await rootPin.close(); throw new Error("Project root handle identity changed during open") }
  const externalRoot = !same(configuredRoot, root)
  let closed = false
  async function checkRoot() {
    signal.throwIfAborted()
    if (closed || !same(root, await realpath(configuredRoot))) throw new Error("Project root changed during content capture")
  }
  async function withParent<T>(path: string, operation: (parent: PinnedProjectDirectory, name: string) => Promise<T>): Promise<T> {
    const parts = projectRelativePath(path).split("/"), name = parts.pop()!
    const pins: PinnedProjectDirectory[] = []
    let parent = rootPin
    try {
      for (const part of parts) {
        signal.throwIfAborted()
        const child = join(parent.scanPath, part), info = await lstat(child)
        if (!info.isSymbolicLink() && !info.isDirectory()) throw new Error("Project content directory changed")
        const expected = await realpath(child)
        const pin = await openDirectory(expected); pins.push(pin)
        if (!same(expected, pin.finalPath)) throw new Error("Project content directory handle identity changed")
        parent = pin
      }
      await checkRoot()
      return await operation(parent, name)
    } finally { for (const pin of pins.reverse()) await pin.close() }
  }
  async function read(path: string, maxBytes: number, policy = false, allowExternal = true) {
    signal.throwIfAborted()
    const allowance = reserve(budget, Math.min(maxBytes, budget.maxFileBytes))
    if (allowance === 0) { contentDiagnostic(budget, "input-byte-limit"); return undefined }
    if (!policy) budget.stats.attemptedFiles++
    try {
      return await withParent(path, async (parent, name) => {
        const target = join(parent.scanPath, name), info = await lstat(target)
        if (!info.isSymbolicLink() && !info.isFile()) throw new Error("Project content leaf is not a regular file")
        const expected = await realpath(target)
        if (!allowExternal && (!inside(root, expected) || info.isSymbolicLink())) throw new Error("Automatic traversal does not follow external aliases")
        let handle: PinnedReviewFile | undefined
        try {
          handle = await openFile(target)
          if (!same(expected, handle.finalPath)) throw new Error("Project content file handle identity changed during open")
          await checkRoot()
          signal.throwIfAborted()
          const result = await handle.read(allowance)
          if (!Number.isSafeInteger(result.count) || result.count < 0 || result.count > allowance || result.bytes.byteLength !== result.count) throw new Error("Pinned reader exceeded its reservation")
          budget.stats.inputBytes += result.count
          const eof = result.count < allowance
          if (!policy) { budget.stats.readFiles++; if (eof) budget.stats.eofFiles++ }
          if (!eof) contentDiagnostic(budget, policy ? "ignore-policy-incomplete" : allowance < budget.maxFileBytes ? "input-byte-limit" : "file-byte-limit", `${path}: content boundary reached without proven EOF`)
          await checkRoot()
          const external = externalRoot || !inside(configuredRoot, handle.finalPath)
          return { path, bytes: Buffer.from(result.bytes), revision: createHash("sha256").update(result.bytes).digest("hex"), eof, external, readonly: external }
        } finally { await handle?.close() }
      })
    } catch (error) {
      if (signal.aborted) throw error
      contentDiagnostic(budget, policy ? "ignore-policy-incomplete" : "file-unavailable", `${path}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    } finally { budget.reserved -= allowance }
  }
  async function policies(folder: string, parent: PinnedProjectDirectory, inherited: Policy[], query: Required<SearchQuery>) {
    if (!query.respectIgnore) return inherited
    const rules = ignore({ ignorecase: false })
    let loaded = false
    // Later files have precedence in this directory. Child rules are evaluated
    // after inherited ones, but an ignored parent is never traversed.
    for (const name of [".gitignore", ".ignore", ".rgignore"]) {
      signal.throwIfAborted()
      const info = await lstat(join(parent.scanPath, name)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        contentDiagnostic(budget, "ignore-policy-incomplete", `${folder}/${name}: unreadable ignore policy`); return undefined
      })
      if (!info) continue
      if (budget.policyFiles >= (budget.maxPolicyFiles ?? 20)) { contentDiagnostic(budget, "ignore-policy-limit"); continue }
      budget.policyFiles++
      const path = folder ? `${folder}/${name}` : name
      const snapshot = await read(path, 64 * 1024, true, false)
      if (!snapshot || !snapshot.eof) { contentDiagnostic(budget, "ignore-policy-incomplete"); continue }
      try { rules.add(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes)); loaded = true }
      catch { contentDiagnostic(budget, "ignore-policy-incomplete", `${path}: ignore policy is not UTF-8`) }
    }
    return loaded ? [...inherited, { base: folder, rules }] : inherited
  }
  async function candidates(query: Required<SearchQuery>): Promise<string[]> {
    const result: string[] = [], include = query.includes.map(pattern => picomatch(pattern, { dot: true, basename: !pattern.includes("/") })), exclude = query.excludes.map(pattern => picomatch(pattern, { dot: true, basename: !pattern.includes("/") }))
    function ignored(path: string, directory: boolean, chain: Policy[]) {
      let excluded = false
      for (const scope of chain) {
        const local = scope.base ? path.slice(scope.base.length + 1) : path
        const status = scope.rules.test(local + (directory ? "/" : ""))
        if (status.ignored) excluded = true
        else if (status.unignored) excluded = false
      }
      return excluded
    }
    async function walk(folder: string, parent: PinnedProjectDirectory, inherited: Policy[], depth: number): Promise<void> {
      if (depth > 32) { contentDiagnostic(budget, "directory-depth-limit"); return }
      await checkRoot()
      const chain = await policies(folder, parent, inherited, query)
      let directory: Awaited<ReturnType<typeof opendir>> | undefined
      try {
        directory = await opendir(parent.scanPath)
        for await (const row of directory) {
          signal.throwIfAborted()
          if (budget.entries >= (budget.maxEntries ?? 3000)) { contentDiagnostic(budget, "entry-limit"); return }
          budget.entries++
          if (row.isSymbolicLink() || [".git", "node_modules"].includes(row.name) || !query.hidden && row.name.startsWith(".")) continue
          const path = folder ? `${folder}/${row.name}` : row.name
          try { projectRelativePath(path) } catch { contentDiagnostic(budget, "path-unavailable"); continue }
          const target = join(parent.scanPath, row.name), info = await lstat(target).catch(() => undefined)
          if (!info || info.isSymbolicLink()) continue
          const isDirectory = info.isDirectory()
          if (exclude.some(match => match(path) || isDirectory && match(`${path}/`)) || query.respectIgnore && ignored(path, isDirectory, chain)) continue
          if (isDirectory) {
            const pin = await openDirectory(target)
            try { if (!inside(root, pin.finalPath)) throw new Error("Project directory handle escapes root"); await walk(path, pin, chain, depth + 1) }
            finally { await pin.close() }
          } else if (info.isFile() && (!include.length || include.some(match => match(path)))) {
            if (budget.stats.candidateFiles >= budget.maxCandidates) { contentDiagnostic(budget, "candidate-limit"); return }
            const bytes = Buffer.byteLength(budget.labelRoot ? join(budget.labelRoot, path) : path)
            if (budget.pathBytes + bytes > (budget.maxCandidateBytes ?? 256 * 1024)) { contentDiagnostic(budget, "candidate-byte-limit"); return }
            budget.pathBytes += bytes; budget.stats.candidateFiles++; result.push(path)
          }
          if (budget.reasons.has("candidate-limit") || budget.reasons.has("candidate-byte-limit") || budget.reasons.has("entry-limit")) return
        }
      } finally { await directory?.close().catch(() => {}) }
    }
    await walk("", rootPin, [], 0)
    await checkRoot()
    return result
  }
  async function* snapshots(paths: string[]) {
    for (let next = 0; next < paths.length; next += 4) {
      signal.throwIfAborted()
      // Reserve synchronously before any awaited read; up to four in flight.
      const pending = paths.slice(next, next + 4).map(path => read(path, budget.maxFileBytes, false, false))
      const settled = await Promise.allSettled(pending)
      for (const outcome of settled) {
        if (outcome.status === "rejected") throw outcome.reason
        if (outcome.value) yield outcome.value
      }
      if (budget.stats.inputBytes >= budget.maxInputBytes) { contentDiagnostic(budget, "input-byte-limit"); break }
    }
  }
  return { candidates, snapshots, read, checkRoot, async close() { if (closed) return; closed = true; await rootPin.close() } }
}
