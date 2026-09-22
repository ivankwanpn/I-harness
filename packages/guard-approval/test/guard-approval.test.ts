import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { createApprovalPolicy, type ApprovalConfig } from "../src/index.ts"

function setup(config: ApprovalConfig) {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  // policy mounts its own pre-execute handler; registry executes via ctx.emit
  createApprovalPolicy(ctx, registry, config)
  return { ctx, registry }
}

const makeWriteTool: Tool = {
  name: "write", description: "", inputSchema: {},
  isReadOnly: false,
  execute: async () => ({ ok: true }),
}
const makeReadTool: Tool = {
  name: "read", description: "", inputSchema: {},
  isReadOnly: true,
  execute: async () => ({ content: "x" }),
}
const makeBashTool = (getArgv: (args: { command: string }) => string[]): Tool => ({
  name: "bash", description: "", inputSchema: {},
  isReadOnly: false,
  getArgv,
  execute: async () => ({ stdout: "ran", exitCode: 0 }),
})

describe("guard-approval policy", () => {
  it("Layer 1: isReadOnly tool executes without approval", async () => {
    const { registry } = setup({ workspace: process.cwd() })
    registry.register(makeReadTool)
    const result = await registry.execute({ name: "read", args: {} })
    expect(result.output).toEqual({ content: "x" })
  })

  it("Layer 1: non-readOnly tool asks → fail-closed without answerer", async () => {
    const { registry } = setup({ workspace: process.cwd() })
    registry.register(makeWriteTool)
    await expect(registry.execute({ name: "write", args: {} })).rejects.toThrow(/approval/i)
  })

  it("Layer 2: write with no path asks then approves via answerer", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    registry.register(makeWriteTool)
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
    // no path arg → policy asks (not the whitelist allow); the answerer approves
    const result = await registry.execute({ name: "write", args: {} })
    expect(result.output).toEqual({ ok: true })
  })

  it("Layer 2: write inside workspace allows without any approval (no answerer)", async () => {
    const { registry } = setup({ workspace: process.cwd() })
    const writeTool: Tool = {
      name: "write", description: "", inputSchema: {},
      isReadOnly: false,
      // resolvePath happens in the fs tool; here simulate an in-workspace path
      execute: async () => ({ ok: true }),
    }
    registry.register(writeTool)
    // no answerer registered — the whitelist allow must NOT require approval
    const result = await registry.execute({ name: "write", args: { path: "inside.txt" } })
    expect(result.output).toEqual({ ok: true })
  })

  it("Layer 2: write outside workspace asks even with answerer auto-allow absent", async () => {
    const { registry } = setup({ workspace: process.cwd() })
    const outsideWrite: Tool = {
      name: "write", description: "", inputSchema: {},
      isReadOnly: false,
      execute: async ({ path }: { path: string }) => ({ ok: true, path }),
    }
    registry.register(outsideWrite)
    // no answerer → fail closed for a path outside the workspace
    await expect(registry.execute({ name: "write", args: { path: "../outside.txt" } })).rejects.toThrow(/approval|denied/i)
  })

  it("Layer 3: dangerous bash command asks even with answerer auto-allow absent", async () => {
    const { registry } = setup({ workspace: process.cwd() })
    registry.register(makeBashTool((args: { command: string }) => (args.command as string).split(" ")))
    // no answerer → ask fails closed for `rm -rf`
    await expect(registry.execute({ name: "bash", args: { command: "rm -rf x" } })).rejects.toThrow(/approval|denied/i)
  })

  it("Layer 3: harmless bash command executes WITHOUT asking (deliberate: shells are the one Layer-1 exception)", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    registry.register(makeBashTool((args: { command: string }) => (args.command as string).split(" ")))
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
    const result = await registry.execute({ name: "bash", args: { command: "echo hi" } })
    expect(result.output).toEqual({ stdout: "ran", exitCode: 0 })
  })

  it("Layer 3: a benign shell command runs even with NO answerer (it never asks at all)", async () => {
    // The discriminating version of the case above: an answerer that would
    // THROW proves the ask never happened. Without it, "executes" alone cannot
    // distinguish "approved by the answerer" from "never asked" — and the
    // difference is the whole point of the Layer-1 exception for shells (see
    // the layers comment in src/index.ts). Every OTHER non-readOnly tool fails
    // closed here; the shell tools do not, because classifyDanger() said none.
    const { ctx, registry } = setup({ workspace: process.cwd() })
    registry.register(makeBashTool((args: { command: string }) => (args.command as string).split(" ")))
    registerApprovalAnswerer(ctx, async () => { throw new Error("must not be asked") })
    const result = await registry.execute({ name: "bash", args: { command: "echo hi" } })
    expect(result.output).toEqual({ stdout: "ran", exitCode: 0 })
  })

  it("F03-2 bypass: quoted rm via getArgv is classified dangerous", async () => {
    const { registry } = setup({ workspace: process.cwd() })
    registry.register(makeBashTool((_args: { command: string }) => {
      // simulate shell-quote parsing: 'r''m' → rm
      return ["rm", "-rf", "x"]
    }))
    await expect(registry.execute({ name: "bash", args: { command: "'r''m' -rf x" } })).rejects.toThrow(/approval|denied/i)
  })

  it("metachar bypass regression: '; rm -rf /' asks even when argv[0] is the separator", async () => {
    const { registry } = setup({ workspace: process.cwd() })
    // naive getArgv: `; rm -rf /` → argv[0] === ";" (Task 3 review: advisory)
    registry.register(makeBashTool((args: { command: string }) => (args.command as string).split(" ")))
    await expect(registry.execute({ name: "bash", args: { command: "; rm -rf /" } })).rejects.toThrow(/approval|denied/i)
  })

  it("metachar-only command without a dangerous basename still asks (deny-on-metachar)", async () => {
    const { registry } = setup({ workspace: process.cwd() })
    // `echo a; echo b` — every basename is harmless but the raw string carries
    // control flow, so it must ask regardless.
    registry.register(makeBashTool((args: { command: string }) => (args.command as string).split(" ")))
    await expect(registry.execute({ name: "bash", args: { command: "echo a; echo b" } })).rejects.toThrow(/approval|denied/i)
  })

  it("M62: output redirection asks — harmless basename, no listed command, real write outside the workspace", async () => {
    // The measured hole this closes: `echo hi > /etc/passwd` has no dangerous
    // basename and no listed command, so the classifier said "none" and the
    // command ran unapproved. The write TOOL is gated by isInsideWorkspace; a
    // shell redirect is not, which is exactly the shape the metachar layer
    // exists for ("harmless basename, real effect").
    const { registry } = setup({ workspace: process.cwd() })
    registry.register(makeBashTool((args: { command: string }) => (args.command as string).split(" ")))
    await expect(registry.execute({ name: "bash", args: { command: "echo hi > /etc/passwd" } })).rejects.toThrow(/approval|denied/i)
    // negative control: the same echo without a redirect still needs no approval
    const { ctx, registry: ok } = setup({ workspace: process.cwd() })
    ok.register(makeBashTool((args: { command: string }) => (args.command as string).split(" ")))
    registerApprovalAnswerer(ctx, async () => { throw new Error("must not be asked") })
    const result = await ok.execute({ name: "bash", args: { command: "echo hi" } })
    expect(result.output).toEqual({ stdout: "ran", exitCode: 0 })
  })

  it("askForNonReadOnly=false allows non-readOnly tools without approval", async () => {
    const { registry } = setup({ workspace: process.cwd(), askForNonReadOnly: false })
    registry.register(makeWriteTool)
    const result = await registry.execute({ name: "write", args: {} })
    expect(result.output).toEqual({ ok: true })
  })

  // ── Layer 2 and the tool NAMES it classifies ──────────────────────────────
  //
  // Layer 2 is a directory whitelist: inside the workspace allows, outside (or
  // unspecified) asks. A tool in NEITHER `SHELL_TOOLS` nor `WRITE_TOOLS` falls to
  // the Layer-1 fallback and asks UNCONDITIONALLY — which is where `edit` used to
  // sit, so an in-workspace `edit` prompted every single time while the
  // wholesale-overwriting `write` beside it ran silently. The asymmetry was
  // backwards on destructiveness (it pushed the model toward the blunter tool)
  // and the loosening is nominal: `write` already reached every in-workspace byte
  // without a prompt.
  //
  // Both directions are pinned, and so is the deliberate EXCEPTION —
  // `apply_patch` stays out because it carries `patch_content` and can touch many
  // paths, so Layer 2's single-`path` check cannot classify it. An unstated
  // exception and an oversight look identical, which is how the `edit` omission
  // survived; the schema/pin below is what keeps the reason attached.

  const namedTool = (name: string): Tool => ({
    name, description: "", inputSchema: {},
    isReadOnly: false,
    execute: async () => ({ ok: true }),
  })

  it("Layer 2: edit INSIDE the workspace allows without any approval", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    registry.register(namedTool("edit"))
    // A throwing answerer is the discriminating double: it proves the ask never
    // happened, where "executes" alone cannot tell "never asked" from "approved".
    registerApprovalAnswerer(ctx, async () => { throw new Error("must not be asked") })
    const result = await registry.execute({ name: "edit", args: { path: "inside.txt", old_string: "a", new_string: "b" } })
    expect(result.output).toEqual({ ok: true })
  })

  it("Layer 2: edit OUTSIDE the workspace still asks", async () => {
    // The other direction: the ruling must not have turned `edit` into an
    // unguarded tool.
    const { registry } = setup({ workspace: process.cwd() })
    registry.register(namedTool("edit"))
    await expect(
      registry.execute({ name: "edit", args: { path: "../outside.txt", old_string: "a", new_string: "b" } }),
    ).rejects.toThrow(/approval|denied/i)
  })

  it("Layer 2 exception: apply_patch takes the Layer-1 fallback, asking for ANY path", async () => {
    // Pinned so a later reader cannot "fix" the exception into a classification
    // the tool's arguments cannot support.
    //
    // The assertion is the REASON, not `/approval|denied/i`: an `apply_patch`
    // admitted to `WRITE_TOOLS` would take Layer 2's `pathArg === undefined`
    // branch and ask as well, so a loose matcher passes for precisely the change
    // this test exists to forbid. Only the Layer-1 fallback says "tool '...'
    // requires approval"; adding `apply_patch` to WRITE_TOOLS changes that string.
    const { registry } = setup({ workspace: process.cwd() })
    registry.register(namedTool("apply_patch"))
    await expect(
      registry.execute({ name: "apply_patch", args: { patch_content: "*** Begin Patch\n*** End Patch" } }),
    ).rejects.toThrow(/tool 'apply_patch' requires approval/)
  })

  it("decide tolerates a payload that is already a decision object", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    registry.register(makeBashTool((args) => args.command.split(" ")))
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
    // seed a decision via the plain-listener path, then dispatch: the waterfall
    // handler receives the seeded { kind } object and must pass it through
    const result = await registry.execute({ name: "bash", args: { command: "rm -rf /tmp/x" } })
    expect(result.output).toEqual({ stdout: "ran", exitCode: 0 })
  })

  it("decide guard is discriminating: a ToolCall-shaped decision passes through as-is", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    // a NON-readOnly bash tool whose args would classify as dangerous IF re-parsed
    registry.register(makeBashTool((args) => args.command.split(" ")))
    // seed the chain with a decision object that is ALSO ToolCall-shaped.
    // Without the guard, decide() would see `name: "bash"` + dangerous args and
    // re-classify it to { kind: "ask" } → no answerer → fail-closed throw.
    // With the guard, it passes through as { kind: "allow" } → dispatch runs.
    ctx.on("tools/pre-execute", () => ({ kind: "allow", name: "bash", args: { command: "rm -rf /tmp/x" } }))
    const result = await registry.execute({ name: "bash", args: { command: "rm -rf /tmp/x" } })
    expect(result.output).toEqual({ stdout: "ran", exitCode: 0 })
  })
})
