import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { SandboxExecutionPolicy } from "@i-harness/sandbox"
import { checkWrite } from "../src/paths.ts"

/**
 * Write confinement for the in-process file tools.
 *
 * The gap these cover: the sandbox reached only `shell`. `fs` was handed
 * `workspace` and nothing else, and `resolvePath` skips its escape check for
 * ABSOLUTE inputs, so `sandbox: "read-only"` refused a shell write while the
 * `write` tool wrote anywhere on disk.
 *
 * The semantics mirror what the OS backends actually enforce — bwrap binds the
 * whole root read-only and re-binds only the workspace writable — so `shell` and
 * `fs` now agree instead of one being stricter than the other.
 */

let workspace: string
let outside: string

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "i-harness-sandbox-paths-"))
  workspace = join(base, "ws")
  outside = join(base, "outside")
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })
})

afterEach(() => {
  rmSync(join(workspace, ".."), { recursive: true, force: true })
})

const policy = (mode: SandboxExecutionPolicy["mode"]): SandboxExecutionPolicy => ({ mode, workspaceRoot: workspace })

describe("checkWrite", () => {
  it("read-only refuses every write, inside the workspace as well as outside", () => {
    // Inside matters: "read-only" is not "workspace-write but quieter". The shell
    // sandbox denies both, and a divergence here would be a hole.
    expect(checkWrite(policy("read-only"), join(workspace, "a.txt")).ok).toBe(false)
    expect(checkWrite(policy("read-only"), join(outside, "b.txt")).ok).toBe(false)
  })

  it("workspace-write allows the workspace and refuses an absolute path outside it", () => {
    // The exact shape of the defect: an absolute path used to skip the check.
    expect(checkWrite(policy("workspace-write"), join(workspace, "a.txt")).ok).toBe(true)
    expect(checkWrite(policy("workspace-write"), join(workspace, "deep/nested/a.txt")).ok).toBe(true)
    const denied = checkWrite(policy("workspace-write"), join(outside, "b.txt"))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.reason).toContain("outside the session workspace")
  })

  it("workspace-write refuses a path in the platform temp directory that is not the workspace", () => {
    // NOT an allowance. An earlier version permitted all of os.tmpdir() to match
    // the rendered policy's "some platform temporary areas may also be writable",
    // which made fs LOOSER than the bwrap backend — that backend binds the root
    // read-only and re-binds only the workspace. Looser-than-shell is the one
    // direction that is an actual hole, so the strictest backend wins.
    expect(checkWrite(policy("workspace-write"), join(tmpdir(), "i-harness-scratch.txt")).ok).toBe(false)
  })

  it("danger-full-access allows everything", () => {
    expect(checkWrite(policy("danger-full-access"), join(outside, "b.txt")).ok).toBe(true)
  })

  it("a SYMLINK inside the workspace pointing outside does not launder the write", () => {
    // A purely lexical `relative()` check passes this, because the path string is
    // genuinely under the workspace. Resolving the real target is what catches it.
    const link = join(workspace, "escape")
    try {
      symlinkSync(outside, link, "junction")
    } catch {
      return // symlink creation needs privileges on Windows; skip rather than false-pass
    }
    expect(checkWrite(policy("workspace-write"), join(link, "b.txt")).ok).toBe(false)
  })

  it("a write to a path that does not exist yet is judged by its nearest existing ancestor", () => {
    // realpathSync requires every component to exist, so a naive implementation
    // either throws or gives up here. The ancestor is resolved and the remainder
    // re-appended.
    expect(checkWrite(policy("workspace-write"), join(workspace, "new/deep/file.txt")).ok).toBe(true)
    expect(checkWrite(policy("workspace-write"), join(outside, "new/deep/file.txt")).ok).toBe(false)
  })

  it("a workspace root that is itself a symlink still allows writes beneath it", () => {
    // The comparison resolves BOTH sides, so a workspace reached through a link is
    // not mistaken for an escape.
    const linkWs = join(workspace, "..", "ws-link")
    try {
      symlinkSync(workspace, linkWs, "junction")
    } catch {
      return
    }
    expect(checkWrite({ mode: "workspace-write", workspaceRoot: linkWs }, join(workspace, "a.txt")).ok).toBe(true)
  })

  it("a sibling directory whose name merely STARTS with the workspace name is refused", () => {
    // The classic prefix-comparison bug: `/tmp/ws-evil` must not pass for `/tmp/ws`.
    writeFileSync(join(workspace, "marker"), "x")
    const sibling = `${workspace}-evil`
    mkdirSync(sibling, { recursive: true })
    try {
      expect(checkWrite(policy("workspace-write"), join(sibling, "b.txt")).ok).toBe(false)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})
