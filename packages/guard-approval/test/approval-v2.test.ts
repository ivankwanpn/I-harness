import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool, type ToolDecision } from "@i-harness/core-tools"
import { createApprovalPolicy, type ApprovalConfig } from "../src/index.ts"

// 複用 guard-approval.test.ts 的 setup 模式（註冊 bash mock，getArgv 切 command args）
function setup(config: ApprovalConfig) {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  // policy mounts its own pre-execute handler; registry executes via ctx.emit
  createApprovalPolicy(ctx, registry, config)
  return { ctx, registry }
}

const makeBashTool = (getArgv: (args: { command: string }) => string[]): Tool => ({
  name: "bash", description: "", inputSchema: {},
  isReadOnly: false,
  getArgv,
  execute: async () => ({ stdout: "ran", exitCode: 0 }),
})

const splitArgv = (args: { command: string }) => args.command.split(" ")

// 直接走 pre-execute emit（與 registry.execute 相同的 decision 播種路徑：
// plain listener 播種 → waterfall 透傳），以觀察 ask/deny 原始決策
async function decideOf(ctx: ReturnType<typeof createContext>, call: unknown): Promise<ToolDecision | undefined> {
  const out = await ctx.emit("tools/pre-execute", call) as ToolDecision | undefined
  return out?.kind !== undefined && ["allow", "deny", "ask"].includes(out.kind) ? out : undefined
}

describe("approval policy v2 (M22)", () => {
  it("approvalPolicy never: extreme-danger → deny (not ask)", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd(), approvalPolicy: "never" })
    registry.register(makeBashTool(splitArgv))
    const decision = await decideOf(ctx, { name: "bash", args: { command: "rm -rf C:/system" } })
    if (!decision || decision.kind === "allow") throw new Error(`expected a deny/ask decision, got ${JSON.stringify(decision)}`)
    expect(decision.kind).toBe("deny")
    expect(decision.reason).toMatch(/approval policy is 'never';/)
    // 且 answerer 不會被問到：deny 短路，無 answerer 也直接拒絕
    await expect(registry.execute({ name: "bash", args: { command: "rm -rf C:/system" } })).rejects.toThrow(/denied.*never|never.*extreme/i)
  })

  it("default (no approvalPolicy): extreme → ask", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    registry.register(makeBashTool(splitArgv))
    const decision = await decideOf(ctx, { name: "bash", args: { command: "rm -rf C:/system" } })
    if (!decision || decision.kind === "allow") throw new Error(`expected an ask decision, got ${JSON.stringify(decision)}`)
    expect(decision.kind).toBe("ask")
    expect(decision.reason).toMatch(/EXTREME/)
  })

  it("approvalPolicy never leaves harmless shell commands executable", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd(), approvalPolicy: "never" })
    registry.register(makeBashTool(splitArgv))
    // "echo hi" 分類為 none → no decision（不 deny）→ 免核准直接執行
    expect(await decideOf(ctx, { name: "bash", args: { command: "echo hi" } })).toBeUndefined()
    const result = await registry.execute({ name: "bash", args: { command: "echo hi" } })
    expect(result.output).toEqual({ stdout: "ran", exitCode: 0 })
  })

  it("Layer 2/1 untouched under never: write outside workspace asks by default and denies under never", async () => {
    const outsideWrite = {
      name: "write", description: "", inputSchema: {},
      isReadOnly: false,
      execute: async ({ path }: { path: string }) => ({ ok: true, path }),
    }
    const def = setup({ workspace: process.cwd() })
    def.registry.register(outsideWrite)
    expect((await decideOf(def.ctx, { name: "write", args: { path: "../outside.txt" } }))?.kind).toBe("ask")

    const never = setup({ workspace: process.cwd(), approvalPolicy: "never" })
    never.registry.register(outsideWrite)
    expect(
      (await decideOf(never.ctx, { name: "write", args: { path: "../outside.txt" } }))?.kind,
    ).toBe("deny")
  })
})
