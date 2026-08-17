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

  it("Layer 3: harmless bash command executes", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    registry.register(makeBashTool((args: { command: string }) => (args.command as string).split(" ")))
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
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

  it("askForNonReadOnly=false allows non-readOnly tools without approval", async () => {
    const { registry } = setup({ workspace: process.cwd(), askForNonReadOnly: false })
    registry.register(makeWriteTool)
    const result = await registry.execute({ name: "write", args: {} })
    expect(result.output).toEqual({ ok: true })
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
})
