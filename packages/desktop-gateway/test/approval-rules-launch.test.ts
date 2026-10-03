import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSessionService, type SessionAssembly } from "@i-harness/session-executor"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createFsTools } from "../../fs/src/index.ts"
import { createApprovalRulesAdapter } from "../src/approval-rules.ts"
import { createInteractionBridge } from "../src/interaction.ts"
import { createAgentProcesses } from "../src/agent-processes.ts"

function heldHook(ctx: PluginContext, name: string) {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const arrived = new Promise<void>((resolve) => { entered = resolve })
  ctx.onCascade("tools/execute", async (input, next) => {
    if ((input as { name: string }).name === name) { entered(); await gate }
    return next()
  })
  return { release, arrived }
}

for (const change of ["revoke", "expiry", "policy"] as const) {
  it(`does not write through an actual remembered filesystem tool after ${change} during an awaited execution hook`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "ih-rule-launch-"))
    let bridge: ReturnType<typeof createInteractionBridge> | undefined
    try {
      let revision = "p1", clock = 1000
      const rules = createApprovalRulesAdapter({ filePath: join(directory, "rules.json"), clock: () => clock, policyIdentity: () => ({ workspaceId: "w", revision }) })
      bridge = createInteractionBridge(() => {}, { approvalRules: rules })
      const ctx = createContext(), registry = createToolRegistry(ctx)
      writeFileSync(join(directory, "notes.txt"), "baseline")
      for (const tool of createFsTools({ workspace: directory })) registry.register(tool)
      ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "ask-all fixture" }))
      bridge.attach({ sessionId: "s", ctx } as SessionAssembly)
      const call = { name: "write", args: { path: "notes.txt", text: "must not be written" } }
      const first = registry.prepare(call, undefined, { sessionId: "s" })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const request = bridge.pending()[0]!
      bridge.replyTrustedHuman({ requestId: request.requestId, sessionId: "s", decision: { kind: "approval", approved: true, remember: { scope: "workspace", expiresAt: 2000 } } })
      await first
      const remembered = await registry.prepare(call, undefined, { sessionId: "s" })
      expect(bridge.pending()).toEqual([])
      const hook = heldHook(ctx, "write"), dispatch = registry.dispatch(remembered)
      const refusal = expect(dispatch).rejects.toThrow(/authority|approval.*changed/)
      await hook.arrived
      if (change === "revoke") rules.revoke("w", rules.list("w")[0]!.id)
      if (change === "expiry") clock = 2001
      if (change === "policy") revision = "p2"
      hook.release(); await refusal
      expect(readFileSync(join(directory, "notes.txt"), "utf8")).toBe("baseline")
    } finally { bridge?.close(); rmSync(directory, { recursive: true, force: true }) }
  })
}

for (const disposition of ["allow", "one-time", "guardian"] as const) {
  it(`retains current policy authority for an opaque ${disposition} operation during hooks`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "ih-opaque-launch-"))
    let bridge: ReturnType<typeof createInteractionBridge> | undefined
    try {
      let revision = "p1", bodies = 0
      const rules = createApprovalRulesAdapter({ filePath: join(directory, "rules.json"), policyIdentity: () => ({ workspaceId: "w", revision }) })
      bridge = createInteractionBridge(() => {}, { approvalRules: rules })
      const ctx = createContext(), registry = createToolRegistry(ctx)
      registry.register({ name: "opaque", description: "", inputSchema: {}, execute: async () => { bodies++; return "executed" } })
      ctx.on("tools/pre-execute", () => ({ kind: disposition === "allow" ? "allow" : "ask", reason: "fixture" }))
      if (disposition === "guardian") ctx.services.register("approval/guardian", async () => ({ outcome: "approve", rationale: "fixture" }))
      bridge.attach({ sessionId: "s", ctx } as SessionAssembly)
      const preparing = registry.prepare({ name: "opaque", args: {} }, undefined, { sessionId: "s" })
      if (disposition === "one-time") {
        await new Promise((resolve) => setTimeout(resolve, 0))
        const row = bridge.pending()[0]!
        expect((row.payload as { remember: { available: boolean } }).remember.available).toBe(false)
        bridge.replyTrustedHuman({ requestId: row.requestId, sessionId: "s", decision: { kind: "approval", approved: true } })
      }
      const prepared = await preparing
      const hook = heldHook(ctx, "opaque"), dispatch = registry.dispatch(prepared)
      const refusal = expect(dispatch).rejects.toThrow(/authority|policy.*changed/)
      await hook.arrived; revision = "p2"; hook.release(); await refusal
      expect(bodies).toBe(0); expect(rules.list("w")).toEqual([])
    } finally { bridge?.close(); rmSync(directory, { recursive: true, force: true }) }
  })
}

it("refuses an actual owner PTY control whose opaque binding is unregistered while a hook awaits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ih-pty-launch-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(directory, "sessions")))
  await coordinator.create({ sessionId: "s" })
  const service = createSessionService({ workspace: directory, modelPolicy: "test-mock", approveAll: true, sandbox: "danger-full-access", coordinator })
  try {
    const assembly = await service.assemblyFor("s")
    const opening = await assembly.tools.prepare({ name: "terminal_open", args: { command: process.execPath, args: ["-e", "process.stdin.on('data',d=>process.stdout.write(d));setInterval(()=>{},1000);setTimeout(()=>process.exit(0),10000)"] } }, undefined, { sessionId: "s" })
    const opened = await assembly.tools.dispatch(opening)
    const id = (opened as { id: string }).id
    let bodies = 0
    const tool = assembly.tools.get("terminal_send")!
    assembly.tools.unregister("terminal_send")
    assembly.tools.register({ ...tool, execute: async (args, exec) => { bodies++; return tool.execute(args, exec) } })
    const hook = heldHook(assembly.ctx, "terminal_send")
    const control = createAgentProcesses(coordinator, service).control("s", { action: "send", id, data: "must not be sent\n" })
    const refusal = expect(control).rejects.toThrow(/binding|revoked|replaced/)
    await hook.arrived; assembly.tools.unregister("terminal_send"); hook.release(); await refusal
    expect(bodies).toBe(0)
  } finally { await service.close(); await coordinator.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}, 15000)
