import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import type { ApprovalRequest, QuestionProvider } from "@i-harness/interaction"
import { createInteractionBridge } from "../src/interaction.ts"

it("attaches owned answerers to the actual context and settles each session request", async () => {
  const ctx = createContext()
  const bridge = createInteractionBridge(() => {})
  bridge.attachOwned({ ctx, sessionId: "owned" })
  const approve = ctx.services.get<(request: ApprovalRequest) => Promise<boolean>>("approval/answerer")
  const ask = ctx.services.get<QuestionProvider>("questions/provider")
  const decision = approve({ name: "write", reason: "edit" })
  const answer = ask.ask({ id: "q", prompt: "Choose", options: ["yes"] })
  const rows = bridge.pending("owned")
  bridge.reply({ requestId: rows[0]!.requestId, sessionId: "owned", decision: { kind: "approval", approved: true } })
  bridge.reply({ requestId: rows[1]!.requestId, sessionId: "owned", decision: { kind: "question", answer: "yes" } })
  expect(await decision).toBe(true)
  expect(await answer).toBe("yes")
  bridge.close()
})

it("attaches original owned approval authority to the same registry and revalidates policy", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { createToolRegistry } = await import("@i-harness/core-tools")
  const { createApprovalRulesAdapter } = await import("../src/approval-rules.ts")
  const directory = mkdtempSync(join(tmpdir(), "ih-owned-rule-"))
  try {
    let revision = "one"
    const ctx = createContext(), tools = createToolRegistry(ctx)
    const rules = createApprovalRulesAdapter({ filePath: join(directory, "rules.json"), policyIdentity: () => undefined, ownedPolicyIdentity: () => ({ workspaceId: "w", revision }) })
    const bridge = createInteractionBridge(() => {}, { approvalRules: rules })
    tools.register({ name: "fixture", description: "", inputSchema: { type: "object" }, execute: async () => "done", approvalIdentity: () => ({ binding: "fixture" }) })
    ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "fixture" }))
    bridge.attachOwned({ ctx, sessionId: "s", tools })
    const pending = tools.prepare({ name: "fixture", args: {} }, undefined, { sessionId: "s" })
    await new Promise(resolve => setTimeout(resolve, 0))
    const row = bridge.pending("s")[0]!
    revision = "two"
    expect(() => bridge.replyTrustedHuman({ requestId: row.requestId, sessionId: "s", decision: { kind: "approval", approved: true, remember: { scope: "session", expiresAt: Date.now() + 60000 } } })).toThrow(/changed/i)
    bridge.reply({ requestId: row.requestId, sessionId: "s", decision: { kind: "approval", approved: false } })
    await expect(pending).rejects.toThrow(/denied/)
    bridge.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it("approving through rememberPending grants the rule and settles the pending request", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { createToolRegistry } = await import("@i-harness/core-tools")
  const { createApprovalRulesAdapter } = await import("../src/approval-rules.ts")
  const directory = mkdtempSync(join(tmpdir(), "ih-owned-remember-"))
  try {
    const ctx = createContext(), tools = createToolRegistry(ctx)
    const rules = createApprovalRulesAdapter({ filePath: join(directory, "rules.json"), policyIdentity: () => undefined, ownedPolicyIdentity: () => ({ workspaceId: "w", revision: "one" }) })
    const bridge = createInteractionBridge(() => {}, { approvalRules: rules })
    tools.register({ name: "fixture", description: "", inputSchema: { type: "object" }, execute: async () => "done", approvalIdentity: () => ({ binding: "fixture" }) })
    ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "fixture" }))
    bridge.attachOwned({ ctx, sessionId: "s", tools })
    const preparing = tools.prepare({ name: "fixture", args: {} }, undefined, { sessionId: "s" })
    await new Promise(resolve => setTimeout(resolve, 0))
    const row = bridge.pending("s")[0]!
    expect(bridge.rememberPending({ requestId: row.requestId, sessionId: "s", remember: { scope: "session", expiresAt: Date.now() + 60000 } })).toEqual({ accepted: true })
    await expect(preparing).resolves.toBeDefined()
    expect(bridge.pending("s")).toHaveLength(0)
    expect(rules.list("w")).toHaveLength(1)
    bridge.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
