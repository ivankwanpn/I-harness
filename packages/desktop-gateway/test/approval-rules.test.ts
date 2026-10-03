import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import type { SessionAssembly } from "@i-harness/session-executor"
import { createInteractionBridge } from "../src/interaction.ts"
import { createApprovalRulesAdapter } from "../src/approval-rules.ts"
import type { PendingInteraction } from "../src/interaction.ts"
import { createFsTools } from "../../fs/src/index.ts"

it("only remembers explicit trusted human live replies and revalidates policy before creating grants", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ih-rule-bridge-"))
  try {
    let revision = "p1"
    const rules = createApprovalRulesAdapter({ filePath: join(directory, "rules.json"), policyIdentity: () => ({ workspaceId: "w", revision }) })
    const bridge = createInteractionBridge(() => {}, { approvalRules: rules })
    let ctx = createContext(); let registry = createToolRegistry(ctx)
    let owner = { sessionId: "s", ctx } as SessionAssembly
    registry.register({ name: "fixture", description: "", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, execute: async (args) => args, approvalIdentity: () => ({ binding: "fixture-v1" }) })
    ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "fixture" }))
    bridge.attach(owner)
    const call = { name: "fixture", args: { value: "full arguments" } }
    const first = registry.prepare(call, undefined, { sessionId: "s" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const request = bridge.pending()[0]!
    expect((request.payload as any).remember.available).toBe(true)
    expect(() => bridge.reply({ requestId: request.requestId, sessionId: "s", decision: { kind: "approval", approved: true, remember: { scope: "workspace", expiresAt: Date.now() + 60000 } } })).toThrow(/trusted/i)
    bridge.replyTrustedHuman({ requestId: request.requestId, sessionId: "s", decision: { kind: "approval", approved: true, remember: { scope: "workspace", expiresAt: Date.now() + 60000 } } })
    await first
    expect(rules.list("w")).toHaveLength(1)
    const remembered = await registry.prepare(call, undefined, { sessionId: "s" }); expect(bridge.pending()).toEqual([])
    rules.revoke("w", rules.list("w")[0]!.id)
    await expect(registry.dispatch(remembered)).rejects.toThrow(/changed/)
    const second = registry.prepare(call, undefined, { sessionId: "s" }); await new Promise((resolve) => setTimeout(resolve, 0))
    const secondRequest = bridge.pending()[0]!
    revision = "p2"
    expect(() => bridge.replyTrustedHuman({ requestId: secondRequest.requestId, sessionId: "s", decision: { kind: "approval", approved: true, remember: { scope: "session", expiresAt: Date.now() + 60000 } } })).toThrow(/changed/i)
    expect(rules.list("w")).toEqual([])
    bridge.reply({ requestId: secondRequest.requestId, sessionId: "s", decision: { kind: "approval", approved: false } })
    await expect(second).rejects.toThrow(/denied/)
    bridge.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it("actively reuses an actual write tool across restart, then asks after revocation and policy changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ih-real-fs-rule-"))
  try {
    const filePath = join(directory, "rules.json"), target = join(directory, "notes.txt")
    writeFileSync(target, "old")
    let revision = "p1", confined = true
    let rules = createApprovalRulesAdapter({ filePath, policyIdentity: () => ({ workspaceId: "w", revision }) })
    let bridge = createInteractionBridge(() => {}, { approvalRules: rules })
    let ctx = createContext(), registry = createToolRegistry(ctx)
    const tools = () => createFsTools({ workspace: directory, writeGuard: () => confined ? { ok: true } : { ok: false, denial: { code: "SANDBOX_DENIED", mode: "read-only", surface: "fs", reason: "fixture confined refusal" } } })
    for (const tool of tools()) registry.register(tool)
    ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "ask-all fixture" }))
    bridge.attach({ sessionId: "s", ctx } as SessionAssembly)
    const call = { name: "write", args: { path: "notes.txt", text: "new" } }
    const first = registry.prepare(call, undefined, { sessionId: "s" }); await new Promise((resolve) => setTimeout(resolve, 0))
    const request = bridge.pending()[0]!
    expect((request.payload as any).remember.available).toBe(true)
    bridge.replyTrustedHuman({ requestId: request.requestId, sessionId: "s", decision: { kind: "approval", approved: true, remember: { scope: "workspace", expiresAt: Date.now() + 60000 } } })
    await registry.dispatch(await first); expect(readFileSync(target, "utf8")).toBe("new")
    bridge.close()
    rules = createApprovalRulesAdapter({ filePath, policyIdentity: () => ({ workspaceId: "w", revision }) })
    bridge = createInteractionBridge(() => {}, { approvalRules: rules })
    ctx = createContext(); registry = createToolRegistry(ctx)
    for (const tool of tools()) registry.register(tool)
    ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "ask-all fixture" }))
    bridge.attach({ sessionId: "s", ctx } as SessionAssembly)
    const reused = await registry.prepare(call, undefined, { sessionId: "s" }); expect(bridge.pending()).toEqual([])
    confined = false
    expect(await registry.dispatch(reused)).toMatchObject({ code: "FS_SANDBOX_DENIED" })
    confined = true
    rules.revoke("w", rules.list("w")[0]!.id)
    const waiting = registry.prepare(call, undefined, { sessionId: "s" }); const denied = expect(waiting).rejects.toThrow(/denied/)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const row = bridge.pending()[0]!
    revision = "p2"
    expect(() => bridge.replyTrustedHuman({ requestId: row.requestId, sessionId: "s", decision: { kind: "approval", approved: true, remember: { scope: "workspace", expiresAt: Date.now() + 60000 } } })).toThrow(/changed/)
    bridge.reply({ requestId: row.requestId, sessionId: "s", decision: { kind: "approval", approved: false } }); await denied
    const outside = join(directory, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret.txt"), "fixture")
    const link = join(directory, "link"); symlinkSync(outside, link, "junction")
    expect(registry.get("write")!.approvalIdentity?.({ path: "link/secret.txt", text: "no" })).toBeUndefined()
    bridge.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it("never remembers cold recovery and keeps guards, guardian denial, immutable args and binding revocation authoritative", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ih-rule-bridge-"))
  try {
    const rules = createApprovalRulesAdapter({ filePath: join(directory, "rules.json"), policyIdentity: () => ({ workspaceId: "w", revision: "p" }) })
    let saved: PendingInteraction[] = []
    const options = { approvalRules: rules, persistence: { read: () => saved, write: (rows: PendingInteraction[]) => { saved = structuredClone(rows) } }, recover: async () => {} }
    let bridge = createInteractionBridge(() => {}, options)
    let ctx = createContext(); let registry = createToolRegistry(ctx)
    let owner = { sessionId: "s", ctx } as SessionAssembly
    const tool = { name: "fixture", description: "", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, execute: async (args: unknown) => args, approvalIdentity: () => ({ binding: "fixture-v1" }) }
    registry.register(tool); ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "fixture" })); bridge.attach(owner)
    const original = { name: "fixture", args: { value: "one" } }
    const first = registry.prepare(original, undefined, { sessionId: "s" })
    const denied = expect(first).rejects.toThrow(/denied/)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const request = bridge.pending()[0]!
    original.args.value = "changed outside preparation"
    expect((request.payload as any).remember.arguments).toBe('{"value":"one"}')
    bridge.close(); await denied
    bridge = createInteractionBridge(() => {}, options)
    expect(() => bridge.replyTrustedHuman({ requestId: request.requestId, sessionId: "s", decision: { kind: "approval", approved: true, remember: { scope: "workspace", expiresAt: Date.now() + 60000 } } })).toThrow(/live/)
    await bridge.reply({ requestId: request.requestId, sessionId: "s", decision: { kind: "approval", approved: true } })
    expect(rules.list("w")).toEqual([])
    ctx = createContext(); registry = createToolRegistry(ctx); owner = { sessionId: "s", ctx } as SessionAssembly
    registry.register(tool); ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "fixture" }))
    bridge.attach(owner)
    const next = registry.prepare({ name: "fixture", args: { value: "one" } }, undefined, { sessionId: "s" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const row = bridge.pending()[0]!
    bridge.replyTrustedHuman({ requestId: row.requestId, sessionId: "s", decision: { kind: "approval", approved: true, remember: { scope: "workspace", expiresAt: Date.now() + 60000 } } })
    const prepared = await next
    ctx.services.register("approval/guardian", async () => ({ outcome: "deny", rationale: "hook/policy guardian fixture" }))
    await expect(registry.prepare({ name: "fixture", args: { value: "one" } })).rejects.toThrow(/guardian denied/)
    expect(bridge.pending()).toEqual([])
    registry.unregister("fixture"); registry.register({ ...tool })
    await expect(registry.dispatch(prepared)).rejects.toThrow(/changed/)
    ctx.guard("tools/execute", () => "Plan / role / sandbox fixture deny")
    await expect(registry.prepare({ name: "fixture", args: { value: "one" } })).rejects.toThrow(/guard denied/)
    bridge.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
