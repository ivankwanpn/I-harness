import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SandboxDenial } from "@i-harness/sandbox"
import { createFsTools } from "../src/index.ts"

/**
 * The fs tools must honour the session's write confinement.
 *
 * Before this, `createFsTools` received `{ workspace }` and nothing else. Every
 * write point resolved the path and wrote, so with `sandbox: "read-only"` the
 * shell refused and the `write`/`edit`/`apply_patch` tools wrote anywhere on disk
 * — `resolvePath` skips its workspace-escape check for absolute inputs by design.
 *
 * The guard is a predicate, so these tests supply one directly rather than
 * pulling in the sandbox packages: what is under test here is that every write
 * point CALLS it, and that a refusal is a classified failure rather than a crash.
 */

let workspace: string
let outside: string

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "i-harness-fs-guard-"))
  workspace = join(base, "ws")
  outside = join(base, "outside")
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })
})

afterEach(() => {
  rmSync(join(workspace, ".."), { recursive: true, force: true })
})

/** Deny anything outside the workspace, exactly as checkWrite does. */
const guard = (abs: string): { ok: true } | { ok: false; denial: SandboxDenial } =>
  abs.startsWith(workspace)
    ? ({ ok: true } as const)
    : ({
        ok: false,
        denial: { code: "SANDBOX_DENIED", surface: "fs", mode: "read-only", reason: `denied: ${abs}` },
      } as const)

/**
 * The guard's refusal reaches the model as `FsToolFailure.error`, so that string
 * must CARRY the shared denial rather than merely mentioning a denial happened.
 * Parsing it back is the assertion that matters: a substring check for "denied"
 * would still pass on the `code` alone with the reason dropped — i.e. it would
 * pass on exactly the regression (losing the why) this shape exists to prevent.
 */
const denialOf = (result: unknown): SandboxDenial => {
  const message = (result as { error: string }).error
  return JSON.parse(message.slice(message.indexOf("{"))) as SandboxDenial
}

const toolNamed = (name: string, deps: Parameters<typeof createFsTools>[0]) => {
  const tool = createFsTools(deps).find((t) => t.name === name)
  if (!tool) throw new Error(`no tool named ${name}`)
  return tool
}

/** `Tool.execute` takes an execution context this suite does not exercise. */
const run = (name: string, deps: Parameters<typeof createFsTools>[0], args: Record<string, unknown>) =>
  toolNamed(name, deps).execute(args, {})

describe("fs write confinement", () => {
  it("write to an absolute path outside the workspace is DENIED and nothing is created", async () => {
    const target = join(outside, "escaped.txt")
    const result = await run("write", { workspace, writeGuard: guard }, { path: target, text: "x" })
    expect(result).toMatchObject({ code: "FS_SANDBOX_DENIED" })
    expect(denialOf(result)).toEqual({
      code: "SANDBOX_DENIED",
      surface: "fs",
      mode: "read-only",
      reason: `denied: ${target}`,
    })
    expect(existsSync(target)).toBe(false)
  })

  it("write inside the workspace still works with the guard present", async () => {
    // The guard must confine, not break. A fix that refuses everything would pass
    // the test above and be useless.
    const result = await run("write", { workspace, writeGuard: guard }, { path: "inside.txt", text: "hello" })
    expect(result).toMatchObject({ ok: true })
    expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toBe("hello")
  })

  it("write is unconfined when no guard is supplied (a host that requested no sandbox)", async () => {
    const target = join(outside, "unguarded.txt")
    const result = await run("write", { workspace }, { path: target, text: "x" })
    expect(result).toMatchObject({ ok: true })
    expect(existsSync(target)).toBe(true)
  })

  it("edit outside the workspace is DENIED", async () => {
    const target = join(outside, "edit-me.txt")
    await run("write", { workspace }, { path: target, text: "before" })
    const result = await run("edit", { workspace, writeGuard: guard }, {
      path: target,
      old_string: "before",
      new_string: "after",
    })
    expect(result).toMatchObject({ code: "FS_SANDBOX_DENIED" })
    expect(denialOf(result).reason).toBe(`denied: ${target}`)
    expect(readFileSync(target, "utf8")).toBe("before")
  })

  it("apply_patch DENIES a hunk that resolves outside the workspace", async () => {
    // Split from the mixed-hunk case on purpose: what matters here is that the
    // guard is reached on the patch path AT ALL. Whether the neighbouring hunks
    // still apply is the tool's per-hunk error model, covered separately below.
    const escapeTarget = join(outside, "patched.txt").replace(/\\/g, "/")
    const patch = ["*** Begin Patch", `*** Add File: ${escapeTarget}`, "+escaped", "*** End Patch"].join("\n")
    const result = (await run("apply_patch", { workspace, writeGuard: guard }, {
      patch_content: patch,
    })) as { errors?: { path: string; message: string }[] }
    expect(result.errors?.length).toBeGreaterThan(0)
    // Same parse-back rule as the write/edit cases: on this path the denial
    // arrives as a per-hunk `message` instead of a top-level failure, so the
    // substring "denied" is not enough — parse it and check the reason survived.
    // The guard is handed the RESOLVED path (patch.ts resolves the hunk path
    // before calling it), hence the native separator here.
    const message = result.errors![0]!.message
    const denial = JSON.parse(message.slice(message.indexOf("{"))) as SandboxDenial
    expect(denial.code).toBe("SANDBOX_DENIED")
    expect(denial.surface).toBe("fs")
    expect(denial.reason).toBe(`denied: ${join(outside, "patched.txt")}`)
    expect(existsSync(join(outside, "patched.txt"))).toBe(false)
  })

  it("apply_patch still applies a patch that stays inside the workspace", async () => {
    const patch = ["*** Begin Patch", "*** Add File: legit.txt", "+legit", "*** End Patch"].join("\n")
    const result = (await run("apply_patch", { workspace, writeGuard: guard }, {
      patch_content: patch,
    })) as { applied?: unknown[]; errors?: { path: string; message: string }[] }
    expect(result.errors ?? []).toHaveLength(0)
    expect(readFileSync(join(workspace, "legit.txt"), "utf8").trim()).toBe("legit")
  })

  it("reading outside the workspace is NOT blocked", async () => {
    // Reads are unrestricted on every backend — bwrap binds the whole root
    // read-only, the Windows backend documents reads as unrestricted. Gating them
    // here would be a false claim of isolation while `cat` still reached the file.
    const target = join(outside, "readable.txt")
    await run("write", { workspace }, { path: target, text: "visible" })
    const result = await run("read", { workspace, writeGuard: guard }, { path: target })
    expect(result).toMatchObject({ content: "visible" })
  })
})
