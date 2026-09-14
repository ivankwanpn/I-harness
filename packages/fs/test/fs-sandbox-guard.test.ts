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

// ── The escalation ladder on the fs surface ─────────────────────────────────
//
// The ladder runs ONCE PER CALL, at the TOP of each tool body, and only the
// resulting MODE travels into `guardWrite` — which stays synchronous because it
// is called PER HUNK on the patch path (patch.ts:186-189). Awaiting the ladder
// inside it would raise one approval prompt per hunk. These tests pin both
// halves: the ask happens once, and the granted mode is what the check sees.

type SeenPrompt = { agent: unknown; toolName: string; callId: string; reason: string }

/** An `EscalationApprover` that records the prompts and answers with `outcome`. */
function approverSaying(outcome: "allowed-once" | "rejected") {
  const prompts: SeenPrompt[] = []
  return {
    prompts,
    approver: {
      async request(req: SeenPrompt) {
        prompts.push({ agent: req.agent, toolName: req.toolName, callId: req.callId, reason: req.reason })
        return outcome
      },
    },
  }
}

const readOnly = (root: string) => () => ({ mode: "read-only" as const, workspaceRoot: root })

describe("fs escalation ladder (one ask per call, granted mode reaches the check)", () => {
  /** Every write tool, with args that would otherwise be a silent in-workspace write. */
  const ESCALATING_CALLS: Array<{ name: string; args: (target: string) => Record<string, unknown>; prepare?: (target: string) => Promise<void> }> = [
    { name: "write", args: (target) => ({ path: target, text: "hello" }) },
    {
      name: "edit",
      args: (target) => ({ path: target, old_string: "before", new_string: "after" }),
      prepare: async (target) => {
        await run("write", { workspace }, { path: target, text: "before" })
      },
    },
    {
      name: "apply_patch",
      // The patch names the file in its own dialect: apply_patch's subject is the
      // path AS THE PATCH WRITES IT (`hunks[0].path`), because resolving it up
      // front would turn one hunk's escape into a whole-call failure and break
      // the per-hunk error model. So the patch here carries the native path.
      args: (target) => ({
        patch_content: ["*** Begin Patch", `*** Add File: ${target}`, "+patched", "*** End Patch"].join("\n"),
      }),
    },
  ]

  for (const call of ESCALATING_CALLS) {
    it(`${call.name}: an approved escalation hands the GRANTED mode to writeGuard`, async () => {
      const { approver, prompts } = approverSaying("allowed-once")
      const modesSeen: Array<string | undefined> = []
      const target = join(workspace, `${call.name}-inside.txt`)
      if (call.prepare !== undefined) await call.prepare(target)
      const result = await run(
        call.name,
        {
          workspace,
          sandboxPolicy: readOnly(workspace),
          escalationApprover: approver as never,
          // The check itself is a spy here: what is under test is the mode it is
          // asked to judge under, not checkWrite's path rules.
          writeGuard: (_abs: string, modeOverride?: string) => {
            modesSeen.push(modeOverride)
            return { ok: true as const }
          },
        },
        {
          ...call.args(target),
          sandbox_permissions: "workspace-write",
          justification: "the workspace write is blocked by read-only",
        },
      )
      expect(result).toMatchObject({ ok: true })
      expect(prompts).toHaveLength(1)
      expect(prompts[0]!.toolName).toBe(call.name)
      // The prompt must NAME THE OPERATION — a capability grant whose purpose the
      // user cannot see is a rubber stamp, and the tool name alone does not say
      // which file is about to change.
      expect(prompts[0]!.reason).toContain(target)
      // The grant is what the guard is asked to judge under. Without it the
      // session's `read-only` mode reaches checkWrite and the write is refused.
      expect(modesSeen).toEqual(["workspace-write"])
    })
  }

  it("a refused escalation is returned AS ITSELF — never the guard's own refusal", async () => {
    const { approver } = approverSaying("rejected")
    let guardCalls = 0
    const target = join(workspace, "never.txt")
    const result = (await run(
      "write",
      {
        workspace,
        sandboxPolicy: readOnly(workspace),
        escalationApprover: approver as never,
        writeGuard: () => {
          guardCalls += 1
          return { ok: true as const }
        },
      },
      { path: target, text: "x", sandbox_permissions: "workspace-write", justification: "please" },
    )) as { error?: string; code?: string; denial?: SandboxDenial }
    expect(result.code).toBe("SANDBOX_DENIED")
    expect(result.denial?.surface).toBe("fs")
    expect(result.denial?.mode).toBe("read-only")
    expect(result.denial?.reason).toMatch(/rejected/)
    // §3.2 corollary 2: the REQUEST was refused, not the operation, so the
    // denial must not tell the model to retry with sandbox_permissions — that is
    // advice to send the same refused request again.
    expect(result.denial?.escalation).toBeUndefined()
    expect(result.error).not.toContain("sandbox_permissions")
    expect(guardCalls).toBe(0)
    expect(existsSync(target)).toBe(false)
  })

  it("apply_patch asks ONCE for a five-hunk patch (the guard runs per hunk)", async () => {
    // The redesign's whole point. `applyPatch` calls the guard inside
    // `for (const hunk of hunks)`, so a ladder awaited there would raise five
    // prompts for one tool call — and each grant would be scoped to a hunk
    // rather than to the call the user was asked about.
    const { approver, prompts } = approverSaying("allowed-once")
    const files = [1, 2, 3, 4, 5].map((n) => join(workspace, `hunk-${n}.txt`))
    const patch = [
      "*** Begin Patch",
      ...files.map((f) => `*** Add File: ${f.replace(/\\/g, "/")}\n+content`),
      "*** End Patch",
    ].join("\n")
    const result = (await run(
      "apply_patch",
      {
        workspace,
        sandboxPolicy: readOnly(workspace),
        escalationApprover: approver as never,
        writeGuard: () => ({ ok: true as const }),
      },
      { patch_content: patch, sandbox_permissions: "workspace-write", justification: "five hunks" },
    )) as { applied?: unknown[]; errors?: unknown[] }
    expect(prompts).toHaveLength(1)
    expect(result.errors ?? []).toHaveLength(0)
    expect(result.applied).toHaveLength(5)
    for (const f of files) expect(readFileSync(f, "utf8").trim()).toBe("content")
  })

  it("no escalation arguments means no ladder at all (nobody is asked)", async () => {
    const { approver, prompts } = approverSaying("allowed-once")
    const result = await run(
      "write",
      { workspace, sandboxPolicy: readOnly(workspace), escalationApprover: approver as never, writeGuard: guard },
      { path: join(workspace, "plain.txt"), text: "x" },
    )
    expect(result).toMatchObject({ ok: true })
    expect(prompts).toHaveLength(0)
  })
})
