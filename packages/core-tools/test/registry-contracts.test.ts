import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, isPolicyRefusal, type PreparedApprovalInput, type Tool, type ToolDispatchMetadata } from "../src/index.ts"

function gate() {
  let release!: () => void, enter!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  return { held, entered, release, enter }
}

it("passes the returned registry and the same frozen operation to approval and execution", async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  const original = { name: "snapshot", args: { nested: { value: "before" } } }
  const signal = new AbortController().signal
  let approvalInput!: PreparedApprovalInput, dispatchInput!: ToolDispatchMetadata
  registry.register({ name: original.name, description: "", inputSchema: {}, execute: async args => args })
  ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "snapshot" }))
  ctx.services.register("approval/prepared", (input: PreparedApprovalInput) => {
    approvalInput = input
    return { remembered: true, remember: { available: true } }
  })
  ctx.onCascade("tools/execute", async (input, next) => { dispatchInput = input as ToolDispatchMetadata; return next() })
  const prepared = await registry.prepare(original, signal, { sessionId: "trusted", callId: "call", callEventSeq: 7, resultConsumer: "code" })
  original.args.nested.value = "after"
  expect(approvalInput.registry).toBe(registry)
  expect(approvalInput.call).toBe(prepared.call)
  expect(Object.isFrozen(prepared.call)).toBe(true)
  expect(Object.isFrozen(prepared.call.args)).toBe(true)
  expect(Object.isFrozen((prepared.call.args as typeof original.args).nested)).toBe(true)
  expect(await registry.dispatch(prepared)).toEqual({ nested: { value: "before" } })
  expect(dispatchInput.registry).toBe(registry)
  expect(dispatchInput.args).toBe(prepared.call.args)
  expect(dispatchInput.exec).toBe(prepared.exec)
  expect(dispatchInput.validateBinding).toBe(approvalInput.validateBinding)
  expect(prepared.exec).toEqual({ abortSignal: signal, sessionId: "trusted", callId: "call", callEventSeq: 7, resultConsumer: "code" })
})

for (const approval of ["human", "guardian"] as const) {
  it(`captures authority before awaiting ${approval} approval`, async () => {
    const ctx = createContext(), registry = createToolRegistry(ctx), wait = gate()
    let revision = 1, bodies = 0
    const order: string[] = []
    registry.register({ name: "control", description: "", inputSchema: {}, execute: async () => { bodies++; return true } })
    ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "authority" }))
    ctx.services.register("approval/authority", () => {
      order.push("capture")
      const captured = revision
      return () => revision === captured
    })
    if (approval === "human") ctx.services.register("approval/answerer", async () => {
      order.push("human"); wait.enter(); await wait.held; return true
    })
    else ctx.services.register("approval/guardian", async () => {
      order.push("guardian"); wait.enter(); await wait.held; return { outcome: "approve", rationale: "reviewed" }
    })
    const preparing = registry.prepare({ name: "control", args: {} })
    await wait.entered
    expect(order).toEqual(["capture", approval])
    revision++
    wait.release()
    await expect(registry.dispatch(await preparing)).rejects.toMatchObject({ policyRefusal: true, message: expect.stringContaining("authority") })
    expect(bodies).toBe(0)
  })
}

it("invokes the body in the same turn as the final authority and guard checks", async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  const order: string[] = []
  let checks = 0
  registry.register({ name: "immediate", description: "", inputSchema: {}, execute: async () => { order.push("body"); return true } })
  ctx.guard("tools/execute", () => {
    checks++
    if (checks === 3) {
      order.push("final guard")
      queueMicrotask(() => { order.push("revoke"); registry.unregister("immediate") })
    }
    return undefined
  })
  expect(await registry.dispatch(await registry.prepare({ name: "immediate", args: {} }))).toBe(true)
  expect(order).toEqual(["final guard", "body", "revoke"])
})

it("leaves dispatch reuse and finalization ownership with the caller", async () => {
  const ctx = createContext(), registry = createToolRegistry(ctx)
  let bodies = 0, finalized = 0
  registry.register({ name: "repeat", description: "", inputSchema: {}, execute: async () => ++bodies })
  ctx.on("tools/post-execute", () => { finalized++ })
  const prepared = await registry.prepare({ name: "repeat", args: {} })
  expect(await registry.dispatch(prepared)).toBe(1)
  expect(await registry.dispatch(prepared)).toBe(2)
  expect(finalized).toBe(0)
  expect(await registry.finalize(prepared, 2)).toEqual({ name: "repeat", output: 2 })
  expect(await registry.finalize(prepared, 3)).toEqual({ name: "repeat", output: 3 })
  expect(finalized).toBe(2)
})

it("retains search return references, lazy metadata and all-name promotion validation", () => {
  const registry = createToolRegistry(createContext())
  const schema = { type: "object" }, tool: Tool = { name: "deferred", description: "before", inputSchema: schema, exposure: "deferred", execute: async () => true }
  registry.register(tool)
  expect(() => registry.promote([tool.name, "missing"])).toThrow("unknown tool: missing")
  expect(registry.schemas()).toEqual([])
  const matches = [{ name: "future", description: "found", inputSchema: schema, exposure: "deferred" as const }]
  const opts = { limit: 3 }
  registry.installSearch((query, received) => { expect(query).toBe("query"); expect(received).toBe(opts); return matches })
  expect(registry.search("query", opts)).toBe(matches)
  registry.register({ ...tool, name: "future" })
  registry.promote([tool.name])
  tool.description = "after"
  expect(registry.schemas()[0].description).toBe("after")
  expect(registry.schemas()[0].inputSchema).toBe(schema)
  expect(registry.schemas().map(entry => entry.name)).toEqual(["deferred", "future"])
  registry.unregister(tool.name)
  registry.register(tool)
  expect(registry.schemas().map(entry => entry.name)).toEqual(["future"])
})

it("fails closed on an unreadable refusal marker and accepts only true readable markers", () => {
  expect(isPolicyRefusal({ get policyRefusal() { throw new Error("unreadable") } })).toBe(true)
  expect(isPolicyRefusal({ policyRefusal: true })).toBe(true)
  expect(isPolicyRefusal({ policyRefusal: "true" })).toBe(false)
  expect(isPolicyRefusal(null)).toBe(false)
})
