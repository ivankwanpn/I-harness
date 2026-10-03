import { closeSync, ftruncateSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import type { SessionAssembly } from "../../session-executor/src/assembly.ts"
import type { ApprovalRequest } from "@i-harness/interaction"
import { createFsTools } from "../../fs/src/index.ts"
import { createApprovalRulesAdapter } from "../../desktop-gateway/src/approval-rules.ts"
import { createInteractionBridge } from "../../desktop-gateway/src/interaction.ts"
import { nativeExecutableFixture } from "./native-executable-fixture.ts"

it("offers a trusted reusable read candidate for a packaged-size image and denies replacement held before the actual body", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ih-packaged-read-"))
  let bridge: ReturnType<typeof createInteractionBridge> | undefined
  try {
    const executable = join(directory, "packaged.exe"), rulesPath = join(directory, "rules.json")
    const fd = openSync(executable, "w")
    try { writeSync(fd, nativeExecutableFixture()); ftruncateSync(fd, 246032896) } finally { closeSync(fd) }
    writeFileSync(join(directory, "approval.txt"), "actual filesystem read")
    const options = { filePath: rulesPath, clock: () => 1000, policyIdentity: () => ({ workspaceId: "w", revision: "p" }) }
    let rules = createApprovalRulesAdapter(options)
    let bodies = 0
    const attach = () => {
      const ctx = createContext(), registry = createToolRegistry(ctx)
      const read = createFsTools({ workspace: directory }).find((tool) => tool.name === "read")!
      registry.register({ ...read, execute: async (args, exec) => { bodies++; return read.execute(args, exec) },
        approvalIdentity: (args) => { const identity = read.approvalIdentity?.(args); return identity ? { ...identity, executablePaths: [executable] } : undefined } })
      ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "ask-all packaged fixture" }))
      bridge = createInteractionBridge(() => {}, { approvalRules: rules })
      bridge.attach({ sessionId: "s", ctx } as SessionAssembly)
      return { ctx, registry }
    }
    let { ctx, registry } = attach()
    const call = { name: "read", args: { path: "approval.txt" } }
    const preparing = registry.prepare(call, undefined, { sessionId: "s" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const row = bridge!.pending()[0]!, request = row.payload as ApprovalRequest
    expect(request.remember?.available).toBe(true)
    expect(request.remember?.candidateId).toBeDefined()
    bridge!.replyTrustedHuman({ requestId: row.requestId, sessionId: "s", decision: { kind: "approval", approved: true, remember: { scope: "workspace", expiresAt: 2000 } } })
    const first = await preparing
    expect(JSON.stringify(await registry.dispatch(first))).toContain("actual filesystem read")
    expect(bodies).toBe(1)
    bridge!.close(); rules = createApprovalRulesAdapter(options)
    ;({ ctx, registry } = attach())
    const remembered = await registry.prepare(call, undefined, { sessionId: "s" })
    expect(bridge!.pending()).toEqual([])
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const arrived = new Promise<void>((resolve) => { entered = resolve })
    ctx.onCascade("tools/execute", async (_input, next) => { entered(); await gate; return next() })
    const dispatch = registry.dispatch(remembered)
    const refusal = expect(dispatch).rejects.toThrow(/approval.*changed/)
    await arrived
    renameSync(executable, join(directory, "previous.exe")); writeFileSync(executable, nativeExecutableFixture(2))
    release(); await refusal
    expect(bodies).toBe(1)
  } finally { bridge?.close(); rmSync(directory, { recursive: true, force: true }) }
}, 10000)
