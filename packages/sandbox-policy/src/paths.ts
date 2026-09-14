import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { SandboxExecutionPolicy } from "@i-harness/sandbox"

/**
 * WRITE confinement for the in-process file tools.
 *
 * Why this exists: the sandbox reached only `shell`. `fs`, `fs-search` and
 * `terminal` received no policy at all, and `resolvePath` — the thing IH calls fs
 * confinement — checks for workspace escape ONLY on relative inputs:
 *
 *     const isAbsoluteInput = path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)
 *     if (!isAbsoluteInput) { ...reject escapes... }
 *
 * So an absolute path skipped the check entirely. With `sandbox: "read-only"` the
 * shell refused to write and the `write` tool would happily write anywhere. These
 * tools are in-process, so no OS backend can wrap them; a path decision is the
 * only mechanism available.
 *
 * HONESTY ABOUT STRENGTH: this is not equivalent to kernel confinement. It
 * resolves symlinks (see `realTarget`) to close the obvious redirect, but it is a
 * check-then-use in user space and cannot close a TOCTOU race the way bwrap or a
 * Windows restricted token does. It removes the glaring hole — "write anywhere by
 * naming an absolute path" — and makes fs agree with what shell already enforces.
 * It does not make the two equally strong, and the document says so.
 *
 * READS ARE DELIBERATELY UNRESTRICTED. Every backend permits reads: bwrap binds
 * the whole root read-only, the Windows backend's header says reads are
 * unrestricted, and dsh behaves the same. Refusing reads here would make fs
 * stricter than shell for no security gain — `cat` would still reach the file —
 * and would be a false claim of isolation rather than the real absence of it.
 */

export type PathDecision = { ok: true } | { ok: false; reason: string }

/**
 * The real path of `target`, resolving symlinks, for a target that may not exist
 * yet.
 *
 * `realpathSync` requires every component to exist, so the deepest EXISTING
 * ancestor is resolved and the not-yet-created remainder is re-appended. Without
 * this, a symlink inside the workspace pointing outside it would pass a purely
 * lexical `relative()` check and the write would land outside.
 */
export function realTarget(target: string): string {
  const absolute = resolve(target)
  let head = absolute
  const tail: string[] = []
  for (;;) {
    if (existsSync(head)) break
    const parent = dirname(head)
    if (parent === head) break // reached the volume root without finding an ancestor
    tail.unshift(head.slice(parent.length + 1))
    head = parent
  }
  let real = head
  try {
    real = realpathSync(head)
  } catch {
    // A component exists but cannot be resolved (permissions, a dangling link).
    // Falling back to the lexical path is the conservative choice: the caller
    // still gets a decision, and `inside()` compares against the workspace root
    // which is itself resolved.
    real = head
  }
  return tail.length === 0 ? real : resolve(real, ...tail)
}

/** True when `target` is `root` itself or lives underneath it. */
function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * Decide whether a write to `target` is permitted under `policy`.
 *
 * Mirrors what the OS backends actually do for `shell`, so the two agree:
 *   - `danger-full-access` — no restriction
 *   - `workspace-write`    — the workspace only
 *   - `read-only`          — no write at all
 *
 * NO TEMP-DIRECTORY EXCEPTION, deliberately. `renderPolicyContext` says "some
 * platform temporary areas may also be writable", and an earlier version of this
 * function allowed all of `os.tmpdir()` to match. That was wrong twice over: the
 * bwrap backend binds the root read-only and re-binds ONLY the workspace (it adds
 * `/dev` and `/proc`, never a temp dir), so the allowance made `fs` LOOSER than
 * `shell` — the one direction that is a real hole — and "all of tmpdir" is a large
 * grant on a shared machine. Where the backends differ, fs follows the strictest
 * rather than the most permissive, because a model that tries and is refused gets
 * a clear message while a model that succeeds has already written.
 */
export function checkWrite(policy: SandboxExecutionPolicy, target: string): PathDecision {
  if (policy.mode === "danger-full-access") return { ok: true }

  const real = realTarget(target)
  const root = realTarget(policy.workspaceRoot)

  if (policy.mode === "read-only") {
    return {
      ok: false,
      reason:
        `read-only sandbox: refusing to modify ${target}. ` +
        `The session is in read-only mode, so no file may be written.`,
    }
  }

  if (inside(root, real)) return { ok: true }

  return {
    ok: false,
    reason:
      `workspace-write sandbox: refusing to modify ${target} because it resolves outside the session workspace ${policy.workspaceRoot}. ` +
      `Writes are confined to the workspace, which is the same boundary the shell sandbox enforces.`,
  }
}
