import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, win32 } from "node:path"
import { openPinnedFileForReview, type PinnedReviewFile } from "./review-handle.ts"

export interface ChangeRow {
  path: string
  status: "modified" | "added" | "deleted" | "untracked" | "renamed"
  canDiff: boolean
  canPreview: boolean
}

export type ChangesResult =
  | { kind: "ok"; files: ChangeRow[]; truncated: boolean }
  | { kind: "unavailable"; reason: "not-git-repo" | "git-missing" | "no-head" }

export type DiffResult =
  | { kind: "text"; text: string; truncated: boolean; bytes: number }
  | { kind: "unavailable"; reason: "untracked" | "binary" | "deleted" | "no-head" | "no-diff" | "not-found" | "not-git-repo" | "git-missing" }

export type FileResult =
  | { kind: "text"; text: string; truncated: boolean; bytes: number }
  | { kind: "unavailable"; reason: "binary" | "deleted" | "not-found" }

export interface WorkspaceReview {
  changes(): Promise<ChangesResult>
  diff(path: string, maxBytes?: number): Promise<DiffResult>
  file(path: string, maxBytes?: number): Promise<FileResult>
  close(): Promise<void>
}

export class ReviewPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReviewPathError"
  }
}

const MAX_CHANGE_ROWS = 500
const STATUS_LIMIT_BYTES = 8 * 1024 * 1024
const DEFAULT_DIFF_BYTES = 512 * 1024
const MAX_DIFF_BYTES = 2 * 1024 * 1024
const DEFAULT_FILE_BYTES = 256 * 1024
const MAX_FILE_BYTES = 1024 * 1024

interface GitResult { data: Buffer; truncated: boolean; code: number | null; missing: boolean }

function runGit(root: string, args: string[], maxBytes: number, control: {
  signal: AbortSignal
  active: Set<ChildProcessWithoutNullStreams>
  command: string
  prefixArgs: string[]
  timeoutMs: number
}): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    if (control.signal.aborted) { reject(new Error("review closed")); return }
    const child = spawn(control.command, [...control.prefixArgs, "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args], {
      cwd: root, shell: false, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })
    control.active.add(child)
    child.stderr.resume() // Never let an untrusted diagnostic fill the pipe.
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, control.timeoutMs)
    const abort = () => child.kill()
    control.signal.addEventListener("abort", abort, { once: true })
    const chunks: Buffer[] = []
    let count = 0
    let truncated = false
    let missing = false
    let finished = false
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true
      else if (!finished) { finished = true; reject(error) }
    })
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return
      const room = maxBytes + 1 - count
      if (room > 0) {
        const part = chunk.subarray(0, room)
        chunks.push(part)
        count += part.length
      }
      if (count > maxBytes) {
        truncated = true
        child.kill()
      }
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      control.signal.removeEventListener("abort", abort)
      control.active.delete(child)
      if (finished) return
      finished = true
      if (control.signal.aborted) { reject(new Error("review closed: Git cancelled")); return }
      if (timedOut) { reject(new Error("Git review timed out")); return }
      resolveResult({ data: Buffer.concat(chunks), truncated, code, missing })
    })
  })
}

function checkedRelative(path: string): { parts: string[]; gitPath: string } {
  if (path === "" || path.includes("\0") || isAbsolute(path) || win32.isAbsolute(path)) {
    throw new ReviewPathError("review path must be workspace-relative")
  }
  const parts = path.replaceAll("\\", "/").split("/")
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes(":"))) {
    throw new ReviewPathError("review path escapes workspace")
  }
  return { parts, gitPath: parts.join("/") }
}

function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate)
  return suffix !== "" && suffix !== ".." && !suffix.startsWith("..\\") && !suffix.startsWith("../") && !isAbsolute(suffix)
}

function cap(requested: number | undefined, defaultBytes: number, hardMax: number): number {
  if (requested === undefined) return defaultBytes
  if (!Number.isInteger(requested) || requested < 1) throw new Error("maxBytes must be a positive integer")
  return Math.min(requested, hardMax)
}

function utf8Prefix(bytes: Buffer, truncated: boolean): string | undefined {
  for (let trim = 0; trim <= (truncated ? Math.min(3, bytes.length) : 0); trim++) {
    if (bytes.length > 0 && trim === bytes.length) break
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - trim)) }
    catch { /* The byte cap may have cut a code point; drop its incomplete suffix. */ }
  }
  return undefined
}

function parseStatus(data: Buffer): ChangeRow[] {
  const fields = data.toString("utf8").split("\0")
  const rows: ChangeRow[] = []
  for (let index = 0; index < fields.length - 1; index++) {
    const field = fields[index]!
    if (field.length < 4) continue
    const xy = field.slice(0, 2)
    const path = field.slice(3)
    if (xy.includes("R") || xy.includes("C")) index++ // -z adds the origin path next.
    const status: ChangeRow["status"] = xy === "??" ? "untracked"
      : xy.includes("D") ? "deleted"
      : xy.includes("A") ? "added"
      : xy.includes("R") ? "renamed" : "modified"
    rows.push({ path, status, canDiff: status !== "untracked" && status !== "deleted", canPreview: status !== "deleted" })
  }
  return rows
}

export function createWorkspaceReview(root: string, options: {
  openPinnedFile?: (path: string) => Promise<PinnedReviewFile>
  gitCommand?: { executable: string; prefixArgs?: string[]; timeoutMs?: number }
} = {}): WorkspaceReview {
  const workspace = resolve(root)
  const openPinnedFile = options.openPinnedFile ?? openPinnedFileForReview
  const aborter = new AbortController()
  const active = new Set<ChildProcessWithoutNullStreams>()
  const gitControl = {
    signal: aborter.signal,
    active,
    command: options.gitCommand?.executable ?? "git",
    prefixArgs: options.gitCommand?.prefixArgs ?? [],
    timeoutMs: options.gitCommand?.timeoutMs ?? 10_000,
  }
  const git = (args: string[], maxBytes: number) => runGit(workspace, args, maxBytes, gitControl)

  async function gitAvailable(): Promise<"ok" | "git-missing" | "not-git-repo" | "no-head"> {
    const repo = await git(["rev-parse", "--is-inside-work-tree"], 128)
    if (repo.missing) return "git-missing"
    if (repo.code !== 0 || repo.data.toString("utf8").trim() !== "true") return "not-git-repo"
    const head = await git(["rev-parse", "--verify", "HEAD"], 128)
    return head.code === 0 ? "ok" : "no-head"
  }

  async function changes(): Promise<ChangesResult> {
    const available = await gitAvailable()
    if (available !== "ok") return { kind: "unavailable", reason: available }
    const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], STATUS_LIMIT_BYTES)
    if (status.code !== 0 && !status.truncated) throw new Error("git status failed")
    const prefixResult = await git(["rev-parse", "--show-prefix"], 4096)
    if (prefixResult.code !== 0 || prefixResult.truncated) throw new Error("git workspace prefix unavailable")
    const prefix = prefixResult.data.toString("utf8").trim()
    const rows = parseStatus(status.data)
      .filter((row) => prefix === "" || row.path.startsWith(prefix))
      .map((row) => ({ ...row, path: prefix === "" ? row.path : row.path.slice(prefix.length) }))
    return { kind: "ok", files: rows.slice(0, MAX_CHANGE_ROWS), truncated: status.truncated || rows.length > MAX_CHANGE_ROWS }
  }

  async function diff(path: string, maxBytes?: number): Promise<DiffResult> {
    const { gitPath } = checkedRelative(path)
    const listed = await changes()
    if (listed.kind !== "ok") return { kind: "unavailable", reason: listed.reason }
    const row = listed.files.find((candidate) => candidate.path === gitPath)
    if (!row) return { kind: "unavailable", reason: "no-diff" }
    if (row.status === "untracked") return { kind: "unavailable", reason: "untracked" }
    if (row.status === "deleted") return { kind: "unavailable", reason: "deleted" }
    const limit = cap(maxBytes, DEFAULT_DIFF_BYTES, MAX_DIFF_BYTES)
    const numstat = await git(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "HEAD", "--", gitPath], 1024)
    if (numstat.data.toString("utf8").startsWith("-\t-\t")) return { kind: "unavailable", reason: "binary" }
    const result = await git(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", gitPath], limit)
    if (result.code !== 0 && !result.truncated) throw new Error("git diff failed")
    if (result.data.length === 0) return { kind: "unavailable", reason: "no-diff" }
    const text = utf8Prefix(result.data.subarray(0, limit), result.truncated)
    if (text === undefined) return { kind: "unavailable", reason: "binary" }
    return { kind: "text", text, truncated: result.truncated, bytes: result.data.length }
  }

  async function file(path: string, maxBytes?: number): Promise<FileResult> {
    const { parts } = checkedRelative(path)
    const limit = cap(maxBytes, DEFAULT_FILE_BYTES, MAX_FILE_BYTES)
    const canonicalRoot = await realpath(workspace)
    let target = canonicalRoot
    try {
      for (const part of parts) {
        target = join(target, part)
        if ((await lstat(target)).isSymbolicLink()) throw new ReviewPathError("review path is a symlink")
      }
      const before = await realpath(target)
      if (!inside(canonicalRoot, before)) throw new ReviewPathError("review path escapes workspace")
      const handle = await openPinnedFile(target)
      try {
        if (!inside(canonicalRoot, handle.finalPath)) throw new ReviewPathError("review handle escapes workspace")
        const { bytes, count } = await handle.read(limit + 1)
        const slice = bytes.subarray(0, Math.min(count, limit))
        if (slice.includes(0)) return { kind: "unavailable", reason: "binary" }
        const text = utf8Prefix(slice, count > limit)
        if (text === undefined) return { kind: "unavailable", reason: "binary" }
        return { kind: "text", text, truncated: count > limit, bytes: count }
      } finally { await handle.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const listed = await changes()
        const deleted = listed.kind === "ok" && listed.files.some((row) => row.path === parts.join("/") && row.status === "deleted")
        return { kind: "unavailable", reason: deleted ? "deleted" : "not-found" }
      }
      throw error
    }
  }

  return {
    changes,
    diff,
    file,
    async close() {
      aborter.abort()
      for (const child of active) child.kill()
      if (active.size > 0) await Promise.all([...active].map((child) => new Promise<void>((resolve) => child.once("close", () => resolve()))))
    },
  }
}
