import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, lstat, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, win32 } from "node:path"
import { openPinnedFileForReview, type PinnedReviewFile } from "./review-handle.ts"
import { openPinnedFileForEdit, type PinnedEditableFile } from "./review-edit-handle.ts"

export interface ChangeRow {
  path: string
  status: "modified" | "added" | "deleted" | "untracked" | "renamed"
  canDiff: boolean
  canPreview: boolean
  staged: boolean
  unstaged: boolean
  originalPath?: string
  outsideWorkspace?: boolean
}

export type ChangesResult =
  | { kind: "ok"; files: ChangeRow[]; truncated: boolean }
  | { kind: "unavailable"; reason: "not-git-repo" | "git-missing" | "no-head" }

export type DiffResult =
  | { kind: "text"; text: string; truncated: boolean; bytes: number }
  | { kind: "unavailable"; reason: "untracked" | "binary" | "deleted" | "no-head" | "no-diff" | "not-found" | "not-git-repo" | "git-missing" }

export type FileResult =
  | { kind: "text"; text: string; truncated: boolean; bytes: number; revision?: string }
  | { kind: "unavailable"; reason: "binary" | "deleted" | "not-found" }

export type SaveFileResult =
  | { kind: "saved"; revision: string; bytes: number }
  | { kind: "conflict" }
  | { kind: "unavailable"; reason: "not-found" | "binary" | "too-large" }

export type GitMutationUnavailable = { kind: "unavailable"; reason: "not-git-repo" | "git-missing" | "no-head" | "not-found" | "no-changes" | "outside-workspace" | "git-failed" }
export type GitMutationResult = { kind: "ok" } | GitMutationUnavailable
export type GitCommitResult = { kind: "committed"; commit: string } | GitMutationUnavailable

export interface WorkspaceReview {
  changes(): Promise<ChangesResult>
  diff(path: string, maxBytes?: number): Promise<DiffResult>
  file(path: string, maxBytes?: number): Promise<FileResult>
  saveFile(path: string, text: string, expectedRevision: string): Promise<SaveFileResult>
  stage(path: string): Promise<GitMutationResult>
  unstage(path: string): Promise<GitMutationResult>
  commit(message: string): Promise<GitCommitResult>
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
  extraEnv?: NodeJS.ProcessEnv
}): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    if (control.signal.aborted) { reject(new Error("review closed")); return }
    const child = spawn(control.command, [...control.prefixArgs, "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args], {
      cwd: root, shell: false, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...control.extraEnv },
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
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, bytes.length - trim)) }
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
    const originalPath = xy.includes("R") || xy.includes("C") ? fields[++index] : undefined // -z adds the origin path next.
    const status: ChangeRow["status"] = xy === "??" ? "untracked"
      : xy.includes("D") ? "deleted"
      : xy.includes("A") ? "added"
      : xy.includes("R") ? "renamed" : "modified"
    rows.push({ path, status, canDiff: status !== "untracked" && status !== "deleted", canPreview: status !== "deleted",
      staged: xy !== "??" && xy[0] !== " ", unstaged: xy === "??" || xy[1] !== " ", ...(originalPath === undefined ? {} : { originalPath }) })
  }
  return rows
}

export function createWorkspaceReview(root: string, options: {
  openPinnedFile?: (path: string) => Promise<PinnedReviewFile>
  openEditableFile?: (path: string) => Promise<PinnedEditableFile>
  gitCommand?: { executable: string; prefixArgs?: string[]; timeoutMs?: number }
} = {}): WorkspaceReview {
  const workspace = resolve(root)
  const openPinnedFile = options.openPinnedFile ?? openPinnedFileForReview
  const openEditableFile = options.openEditableFile ?? openPinnedFileForEdit
  const revisionOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
  const aborter = new AbortController()
  const active = new Set<ChildProcessWithoutNullStreams>()
  const gitControl = {
    signal: aborter.signal,
    active,
    command: options.gitCommand?.executable ?? "git",
    prefixArgs: options.gitCommand?.prefixArgs ?? [],
    timeoutMs: options.gitCommand?.timeoutMs ?? 10_000,
  }
  const git = (args: string[], maxBytes: number, extraEnv?: NodeJS.ProcessEnv) => runGit(workspace, args, maxBytes, { ...gitControl, extraEnv })

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
    const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], STATUS_LIMIT_BYTES)
    if (status.code !== 0 && !status.truncated) throw new Error("git status failed")
    const prefixResult = await git(["rev-parse", "--show-prefix"], 4096)
    if (prefixResult.code !== 0 || prefixResult.truncated) throw new Error("git workspace prefix unavailable")
    const prefix = prefixResult.data.toString("utf8").trim()
    const rows = parseStatus(status.data)
      .filter((row) => prefix === "" || row.path.startsWith(prefix))
      .map((row) => ({ ...row, path: prefix === "" ? row.path : row.path.slice(prefix.length),
        ...(row.originalPath === undefined ? {} : prefix !== "" && !row.originalPath.startsWith(prefix)
          ? { outsideWorkspace: true } : { originalPath: prefix === "" ? row.originalPath : row.originalPath.slice(prefix.length) }) }))
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
        return { kind: "text", text, truncated: count > limit, bytes: count, ...(count > limit ? {} : { revision: revisionOf(slice) }) }
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

  async function mutationTarget(path: string, allowMissing = false) {
    const { parts, gitPath } = checkedRelative(path)
    if (parts.some((part) => part.toLowerCase() === ".git")) throw new ReviewPathError("Git metadata cannot be edited")
    const canonicalRoot = await realpath(workspace)
    let target = canonicalRoot
    for (let index = 0; index < parts.length; index++) {
      target = join(target, parts[index]!)
      try {
        if ((await lstat(target)).isSymbolicLink()) throw new ReviewPathError("edit path is a symlink")
        if (!inside(canonicalRoot, await realpath(target))) throw new ReviewPathError("edit path escapes workspace")
      } catch (error) {
        if (allowMissing && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") break
        throw error
      }
    }
    return { canonicalRoot, target, gitPath }
  }

  async function saveFile(path: string, text: string, expectedRevision: string): Promise<SaveFileResult> {
    if (typeof text !== "string" || typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error("a complete file revision is required")
    const replacement = Buffer.from(text, "utf8")
    if (replacement.length > DEFAULT_FILE_BYTES) return { kind: "unavailable", reason: "too-large" }
    if (replacement.includes(0)) return { kind: "unavailable", reason: "binary" }
    try {
      const { canonicalRoot, target } = await mutationTarget(path)
      const handle = await openEditableFile(target)
      try {
        if (!inside(canonicalRoot, handle.finalPath)) throw new ReviewPathError("edit handle escapes workspace")
        const current = await handle.read(DEFAULT_FILE_BYTES + 1)
        if (current.count > DEFAULT_FILE_BYTES) return { kind: "unavailable", reason: "too-large" }
        if (current.bytes.includes(0) || utf8Prefix(current.bytes, false) === undefined) return { kind: "unavailable", reason: "binary" }
        if (revisionOf(current.bytes) !== expectedRevision) return { kind: "conflict" }
        await handle.write(replacement)
        return { kind: "saved", revision: revisionOf(replacement), bytes: replacement.length }
      } finally { await handle.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "unavailable", reason: "not-found" }
      throw error
    }
  }

  async function changeIndex(path: string, action: "stage" | "unstage"): Promise<GitMutationResult> {
    const { gitPath } = await mutationTarget(path, true)
    const listed = await changes()
    if (listed.kind !== "ok") return listed
    const row = listed.files.find((candidate) => candidate.path === gitPath)
    if (!row) return { kind: "unavailable", reason: "not-found" }
    if (row.outsideWorkspace) return { kind: "unavailable", reason: "outside-workspace" }
    const paths = [gitPath]
    if (row.originalPath !== undefined) {
      await mutationTarget(row.originalPath, true)
      paths.push(row.originalPath)
    }
    const result = await git(action === "stage" ? ["--literal-pathspecs", "add", "--", ...paths] : ["--literal-pathspecs", "restore", "--staged", "--", ...paths], 8192)
    return result.code === 0 ? { kind: "ok" } : { kind: "unavailable", reason: result.missing ? "git-missing" : "git-failed" }
  }

  async function commit(message: string): Promise<GitCommitResult> {
    if (typeof message !== "string" || message.trim() === "" || message.includes("\0") || Buffer.byteLength(message, "utf8") > 64 * 1024) throw new Error("a commit message of at most 64 KiB is required")
    const available = await gitAvailable()
    if (available !== "ok") return { kind: "unavailable", reason: available }
    const indexPath = await git(["rev-parse", "--git-path", "index"], 4096)
    if (indexPath.code !== 0 || indexPath.truncated) return { kind: "unavailable", reason: "git-failed" }
    const temporaryRoot = await mkdtemp(join(tmpdir(), "ih-human-commit-"))
    try {
      // Git consumes a frozen copy, so an external stage between validation and
      // commit cannot add a path outside this workspace to the commit.
      const snapshotIndex = join(temporaryRoot, "index")
      await copyFile(resolve(workspace, indexPath.data.toString("utf8").trim()), snapshotIndex)
      const snapshotEnv = { GIT_INDEX_FILE: snapshotIndex }
      const staged = await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z"], STATUS_LIMIT_BYTES, snapshotEnv)
      if (staged.code !== 0 || staged.truncated) return { kind: "unavailable", reason: "git-failed" }
      const paths = staged.data.toString("utf8").split("\0").filter(Boolean)
      if (paths.length === 0) return { kind: "unavailable", reason: "no-changes" }
      const prefixResult = await git(["rev-parse", "--show-prefix"], 4096)
      if (prefixResult.code !== 0 || prefixResult.truncated) return { kind: "unavailable", reason: "git-failed" }
      const prefix = prefixResult.data.toString("utf8").trim()
      if (prefix && paths.some((path) => !path.startsWith(prefix))) return { kind: "unavailable", reason: "outside-workspace" }
      const result = await git(["-c", "commit.gpgsign=false", "commit", "-m", message], 8192, snapshotEnv)
      if (result.code !== 0) return { kind: "unavailable", reason: result.missing ? "git-missing" : "git-failed" }
      const head = await git(["rev-parse", "--verify", "HEAD"], 128)
      if (head.code !== 0) return { kind: "unavailable", reason: "git-failed" }
      return { kind: "committed", commit: head.data.toString("utf8").trim() }
    } finally {
      if (!inside(resolve(tmpdir()), resolve(temporaryRoot))) throw new Error("temporary index cleanup escaped its directory")
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  }

  return {
    changes,
    diff,
    file,
    saveFile,
    stage: (path) => changeIndex(path, "stage"),
    unstage: (path) => changeIndex(path, "unstage"),
    commit,
    async close() {
      aborter.abort()
      for (const child of active) child.kill()
      if (active.size > 0) await Promise.all([...active].map((child) => new Promise<void>((resolve) => child.once("close", () => resolve()))))
    },
  }
}
