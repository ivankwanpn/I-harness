import { expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "../src/index.ts"

function heldHook(ctx: PluginContext) {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const arrived = new Promise<void>((resolve) => { entered = resolve })
  ctx.onCascade("tools/execute", async (_input, next) => { entered(); await gate; return next() })
  return { release, arrived }
}

for (const action of ["unregister", "replace", "same-object-reregister"] as const) {
  it(`refuses an opaque allowed tool ${action} while an execution hook is awaiting`, async () => {
    const ctx = createContext(), registry = createToolRegistry(ctx)
    let bodies = 0, replacementBodies = 0, preHooks = 0
    const tool: Tool = { name: "opaque-control", description: "", inputSchema: {}, execute: async () => { bodies++; return "executed" } }
    registry.register(tool)
    ctx.on("tools/pre-execute", () => { preHooks++ })
    const prepared = await registry.prepare({ name: tool.name, args: {} })
    const hook = heldHook(ctx)
    const dispatch = registry.dispatch(prepared)
    const refusal = expect(dispatch).rejects.toThrow(/binding|replaced|revoked/i)
    await hook.arrived
    registry.unregister(tool.name)
    if (action === "replace") registry.register({ ...tool, execute: async () => { replacementBodies++; return "replacement" } })
    if (action === "same-object-reregister") registry.register(tool)
    hook.release(); await refusal
    expect(bodies).toBe(0); expect(replacementBodies).toBe(0); expect(preHooks).toBe(1)
  })
}

it("refuses newly denying ancestor guards after a held execution hook", async () => {
  const parent = createContext(), ctx = parent.scope.mount(), registry = createToolRegistry(ctx)
  let denied = false, bodies = 0
  parent.guard("tools/execute", () => denied ? "current Plan/role guard" : undefined)
  registry.register({ name: "control", description: "", inputSchema: {}, execute: async () => { bodies++; return true } })
  const prepared = await registry.prepare({ name: "control", args: {} })
  const hook = heldHook(parent), dispatch = registry.dispatch(prepared)
  const refusal = expect(dispatch).rejects.toThrow(/guard denied.*current Plan\/role guard/)
  await hook.arrived; denied = true; hook.release(); await refusal
  expect(bodies).toBe(0)
})

it("refuses remembered authority revoked while an execution hook is awaiting", async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  let active = true, bodies = 0, validations = 0
  registry.register({ name: "remembered", description: "", inputSchema: {}, execute: async () => { bodies++; return "executed" } })
  ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "fixture" }))
  ctx.services.register("approval/prepared", () => ({ remembered: true, remember: { available: true }, validate: () => { validations++; return active } }))
  const prepared = await registry.prepare({ name: "remembered", args: {} })
  const hook = heldHook(ctx), dispatch = registry.dispatch(prepared)
  const refusal = expect(dispatch).rejects.toThrow(/approval.*changed/)
  await hook.arrived; active = false; hook.release(); await refusal
  expect(bodies).toBe(0); expect(validations).toBe(2)
})

for (const decision of ["allow", "ask"] as const) {
  it(`captures policy authority for an opaque ${decision === "ask" ? "guardian-approved" : "allowed"} tool without reusable evidence`, async () => {
    const ctx = createContext(), registry = createToolRegistry(ctx)
    let revision = "old", bodies = 0, guardians = 0
    registry.register({ name: "opaque", description: "", inputSchema: {}, execute: async () => { bodies++; return "executed" } })
    ctx.on("tools/pre-execute", () => ({ kind: decision, reason: "fixture" }))
    ctx.services.register("approval/authority", () => { const captured = revision; return () => revision === captured })
    ctx.services.register("approval/guardian", async () => { guardians++; return { outcome: "approve", rationale: "fixture" } })
    const prepared = await registry.prepare({ name: "opaque", args: {} })
    const hook = heldHook(ctx), dispatch = registry.dispatch(prepared)
    const refusal = expect(dispatch).rejects.toThrow(/authority|policy.*changed/)
    await hook.arrived; revision = "new"; hook.release(); await refusal
    expect(bodies).toBe(0); expect(guardians).toBe(decision === "ask" ? 1 : 0)
  })
}

it("runs hooks, body and finalization once when authority remains current", async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  let preHooks = 0, executeHooks = 0, bodies = 0, finalized = 0
  registry.register({ name: "current", description: "", inputSchema: {}, execute: async () => { bodies++; return "executed" } })
  ctx.on("tools/pre-execute", () => { preHooks++ })
  ctx.onCascade("tools/execute", async (_input, next) => { executeHooks++; await Promise.resolve(); return next() })
  ctx.on("tools/post-execute", () => { finalized++ })
  expect(await registry.execute({ name: "current", args: {} })).toEqual({ name: "current", output: "executed" })
  expect({ preHooks, executeHooks, bodies, finalized }).toEqual({ preHooks: 1, executeHooks: 1, bodies: 1, finalized: 1 })
})
