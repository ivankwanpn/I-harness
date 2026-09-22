import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { SandboxExecutionPolicy, SandboxMode } from "@i-harness/sandbox"

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

/**
 * `sufficientMode` is REQUIRED on a refusal, and it is the narrowest mode in which
 * THIS target would be permitted — NOT merely a mode wider than the one in force.
 *
 * Why it is not optional: a denial must never advise a retry that cannot work. The
 * fs share of that rule used to be inferred by the caller from the first
 * strictly-wider mode, which is right for an IN-workspace target under `read-only`
 * (`workspace-write` genuinely lifts it) and wrong for one OUTSIDE the workspace
 * (`workspace-write` refuses it again; only `danger-full-access` helps). Two
 * independent final-review scopes found that the model's first retry was
 * guaranteed to fail, and neither found a test that read the field. Making this
 * required means a future refusal path cannot forget to answer, and the compiler
 * is what enforces it.
 */
export type PathDecision = { ok: true } | { ok: false; reason: string; sufficientMode: SandboxMode }

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
      // `read-only` refuses EVERY write, so the sufficient mode depends on where
      // the target is: an in-workspace path is lifted by `workspace-write`, an
      // outside one is not. `real`/`root` are already resolved above, so this
      // costs one containment test rather than a second traversal.
      sufficientMode: inside(root, real) ? "workspace-write" : "danger-full-access",
      reason:
        `read-only sandbox: refusing to modify ${target}. ` +
        `The session is in read-only mode, so no file may be written.`,
    }
  }

  if (inside(root, real)) return { ok: true }

  return {
    ok: false,
    // Reached only when the target is outside the workspace, which
    // `workspace-write` refuses by definition — so a wider mode is not enough
    // here, and naming one would send the model to a retry that fails the same way.
    sufficientMode: "danger-full-access",
    reason:
      `workspace-write sandbox: refusing to modify ${target} because it resolves outside the session workspace ${policy.workspaceRoot}. ` +
      `Writes are confined to the workspace, which is the same boundary the shell sandbox enforces.`,
  }
}
