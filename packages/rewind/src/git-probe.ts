// packages/rewind/src/git-probe.ts — M58 R-B4 A: the read-only git probe.
//
// The recorder only sees fs-tool writes (write/edit/apply_patch); shell, an
// external editor, another process or another session can change the workspace
// without ever entering the journal. When the workspace is a git work tree we
// can ASK GIT what is dirty — but a raw "git dirty − covered" list would be
// wrong, because the agent's own uncommitted writes are dirty too. The probe
// therefore only OBSERVES (all dirty paths, workspace-relative); the service
// decides which of them the journal cannot explain (see service.ts plan()).
//
// READ-ONLY CONTRACT: only `rev-parse` and `status`; `GIT_OPTIONAL_LOCKS=0`
// stops git from refreshing/taking the index lock; `GIT_TERMINAL_PROMPT=0`
// forbids credential prompts. Every failure path returns [] — the probe NEVER
// throws (a missing git, a non-repo workspace, a timeout, a broken repo all
// mean "no git evidence", never a broken plan()).
import { execFile } from "node:child_process"
import { dirname, isAbsolute, join, relative } from "node:path"
import { normalizeRelPath } from "./path.ts"
import type { UnseenChange, UnseenChangeKind } from "./types.ts"

/** The exec surface the probe needs (injectable for tests). */
export interface GitExecOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
  maxBuffer: number
}

export type GitExec = (
  file: string,
  args: string[],
  opts: GitExecOptions,
) => Promise<{ stdout: string }>

export interface GitProbe {
  /**
   * Every path git reports dirty (staged, unstaged, untracked), as
   * workspace-relative normalized keys. Resolves [] when the workspace is not
   * a git work tree, git is unavailable, or anything goes wrong. Memoized per
   * probe instance (one git pass).
   */
  changes(): Promise<UnseenChange[]>
}

export interface GitProbeOptions {
  /** Absolute workspace root (the journal's path base). */
  workspace: string
  /** Workspace-relative prefixes to drop (e.g. the rewind store dir when it
   * lives inside the workspace). */
  excludePrefixes?: string[]
  /** Bounded read-only git invocation. Default 5000ms. */
  timeoutMs?: number
  /** Test seam; defaults to node:child_process.execFile. */
  exec?: GitExec
}

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_BUFFER = 10 * 1024 * 1024

const defaultExec: GitExec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeout, maxBuffer: opts.maxBuffer, windowsHide: true }, (err, stdout) => {
      if (err !== null) reject(err)
      else resolve({ stdout })
    })
  })

/** porcelain v1 `XY` → our three honest kinds. `??` = untracked; any `D` =
 * deleted; everything else (M/A/R/C new side) = modified. */
function kindOf(xy: string): UnseenChangeKind {
  if (xy === "??") return "untracked"
  if (xy.includes("D")) return "deleted"
  return "modified"
}

/** Parse `git status --porcelain=v1 -z`. Records are NUL-terminated; a rename
 * (`R`) or copy (`C`) entry carries the ORIGIN path as one extra NUL-separated
 * segment after the new path. A rename's origin is gone from disk (deleted);
 * a copy's origin is untouched (skipped). */
function parsePorcelainZ(raw: string): Array<{ xy: string; path: string }> {
  const out: Array<{ xy: string; path: string }> = []
  const parts = raw.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!
    if (seg === "") continue
    const xy = seg.slice(0, 2)
    const path = seg.slice(3)
    if (path === "") continue
    out.push({ xy, path })
    if (xy.includes("R") || xy.includes("C")) {
      const origin = parts[++i] ?? ""
      if (origin !== "" && xy.includes("R")) out.push({ xy: "D ", path: origin })
    }
  }
  return out
}

function toWorkspaceRel(toplevel: string, workspace: string, porcelainPath: string): string | null {
  const abs = join(toplevel, ...porcelainPath.split("/"))
  const rel = relative(workspace, abs)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null
  try {
    return normalizeRelPath(rel)
  } catch {
    return null
  }
}

function isExcluded(rel: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => rel === p || rel.startsWith(`${p}/`))
}

export function createGitProbe(opts: GitProbeOptions): GitProbe {
  const exec = opts.exec ?? defaultExec
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const excludePrefixes = (opts.excludePrefixes ?? [])
    .map((p) => {
      try {
        return normalizeRelPath(p)
      } catch {
        return null
      }
    })
    .filter((p): p is string => p !== null)
  const gitOpts: GitExecOptions = {
    cwd: opts.workspace,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    timeout,
    maxBuffer: MAX_BUFFER,
  }
  let cached: Promise<UnseenChange[]> | undefined

  async function probe(): Promise<UnseenChange[]> {
    let toplevel: string
    try {
      const rev = await exec("git", ["rev-parse", "--is-inside-work-tree", "--show-toplevel"], gitOpts)
      const lines = rev.stdout.split(/\r?\n/)
      if (lines[0]?.trim() !== "true") return []
      const top = lines[1]?.trim() ?? ""
      if (top === "") return []
      toplevel = top
    } catch {
      return []
    }
    let raw: string
    try {
      const status = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], gitOpts)
      raw = status.stdout
    } catch {
      return []
    }
    const out: UnseenChange[] = []
    const seen = new Set<string>()
    for (const entry of parsePorcelainZ(raw)) {
      const rel = toWorkspaceRel(toplevel, opts.workspace, entry.path)
      if (rel === null || isExcluded(rel, excludePrefixes)) continue
      const key = `${rel}\0${entry.xy}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ path: rel, kind: kindOf(entry.xy) })
    }
    return out
  }

  return {
    changes(): Promise<UnseenChange[]> {
      cached ??= probe()
      return cached
    },
  }
}

/**
 * M58 R-B4 A: the product wiring — a probe bound to the store's own directory.
 * The rewind journal may live inside the workspace (e.g. `--session-dir .`);
 * its own files must never be reported as "unseen changes", so the store dir
 * is excluded when it resolves inside the workspace. M60 H: the SESSION store
 * root (`store.storeRoot` — the session JSONL/lock files' directory) is
 * excluded too when it is a PROPER descendant of the workspace; a store root
 * equal to the workspace is never excluded (that would hide every real
 * change).
 */
export function createGitProbeForStore(
  store: { readonly pointsFile: string; readonly storeRoot?: string },
  workspace: string,
  opts: { timeoutMs?: number; exec?: GitExec } = {},
): GitProbe {
  const excludePrefixes: string[] = []
  const excludeInside = (dir: string | undefined): void => {
    if (dir === undefined || dir === "") return
    const rel = relative(workspace, dir)
    // "" = the workspace itself; ".."/absolute = outside — neither is excluded.
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) excludePrefixes.push(rel)
  }
  excludeInside(dirname(store.pointsFile))
  excludeInside(store.storeRoot)
  return createGitProbe({ workspace, excludePrefixes, ...opts })
}
