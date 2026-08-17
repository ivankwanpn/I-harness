import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { createToolRegistry, type Tool } from "../src/index.ts"

function makeCtx(): PluginContext {
  return createContext()
}

describe("tool registry", () => {
  it("registers tools and lists schemas", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    const read: Tool = {
      name: "read",
      description: "read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: async ({ path }: { path: string }) => ({ content: `file:${path}` }),
    }
    reg.register(read)
    expect(reg.schemas().map((s) => s.name)).toEqual(["read"])
  })

  it("throws on same-layer duplicate tool name (audit F03-5)", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    const t: Tool = { name: "x", description: "", inputSchema: {}, execute: async () => ({}) }
    reg.register(t)
    expect(() => reg.register({ ...t })).toThrow(/duplicate/i)
  })

  it("get(name) returns the registered tool metadata and undefined for unknown", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    const t: Tool = { name: "t", description: "", inputSchema: {}, isReadOnly: true, execute: async () => ({}) }
    reg.register(t)
    expect(reg.get("t")).toBe(t)
    expect(reg.get("nope")).toBeUndefined()
  })

  it("shadows tool in child scope and restores on unmount", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "t", description: "root", inputSchema: {}, execute: async () => ({ who: "root" }) })
    const child = ctx.scope.mount()
    const reg2 = createToolRegistry(child)
    reg2.register({ name: "t", description: "child", inputSchema: {}, execute: async () => ({ who: "child" }) })
    expect(reg2.schemas().map((s) => s.name)).toEqual(["t"])
    child.scope.unmount()
    expect(reg.schemas().map((s) => s.name)).toEqual(["t"])
  })
})

describe("execution pipeline", () => {
  it("executes a tool through the pipeline", async () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    const t: Tool = { name: "echo", description: "", inputSchema: {}, execute: async (args: { m?: string }) => ({ out: args.m ?? "" }) }
    reg.register(t)
    const result = await reg.execute({ name: "echo", args: { m: "hi" } })
    expect(result.output).toEqual({ out: "hi" })
  })

  it("rejects a malformed pre-execute decision before dispatch (audit F03-1)", async () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    let bodyRan = false
    reg.register({ name: "t", description: "", inputSchema: {}, execute: async () => { bodyRan = true; return {} } })
    // a pre-execute listener returns a NON-vocabulary decision object
    ctx.on("tools/pre-execute", () => ({ kind: "anything" }))
    await expect(reg.execute({ name: "t", args: {} })).rejects.toThrow(/decision/i)
    expect(bodyRan).toBe(false)
  })

  it("runs monotonic guards unconditionally before dispatch (audit F03-1)", async () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    let guardRan = false
    ctx.guard("tools/execute", () => {
      guardRan = true
      return "denied"
    })
    reg.register({ name: "t", description: "", inputSchema: {}, execute: async () => ({}) })
    await expect(reg.execute({ name: "t", args: {} })).rejects.toThrow(/denied/)
    expect(guardRan).toBe(true)
  })

  it("honors approval seam fail-closed for non-readOnly tools", async () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    let asked = false
    ctx.on("tools/pre-execute", () => {
      asked = true
      return { kind: "ask", reason: "needs approval" }
    })
    reg.register({ name: "t", description: "", inputSchema: {}, execute: async () => ({}) })
    // no approval answerer registered → fail closed → deny
    await expect(reg.execute({ name: "t", args: {} })).rejects.toThrow(/approval|denied/i)
    expect(asked).toBe(true)
  })

  it("does NOT execute when a registered answerer returns { approved: false } (regression: contract mismatch)", async () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    let bodyRan = false
    reg.register({ name: "t", description: "", inputSchema: {}, execute: async () => { bodyRan = true; return {} } })
    ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "needs approval" }))
    registerApprovalAnswerer(ctx, async () => ({ approved: false }))
    // a user denial must be honored — the tool must NOT execute (audit F05-5 fail-closed)
    await expect(reg.execute({ name: "t", args: {} })).rejects.toThrow(/denied/i)
    expect(bodyRan).toBe(false)
  })

  it("executes when a registered answerer returns { approved: true }", async () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    let bodyRan = false
    reg.register({ name: "t", description: "", inputSchema: {}, execute: async () => { bodyRan = true; return {} } })
    ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "needs approval" }))
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
    const result = await reg.execute({ name: "t", args: {} })
    expect(result.output).toEqual({})
    expect(bodyRan).toBe(true)
  })

  it("treats non-object pre-execute returns as malformed decisions (audit F03-1)", async () => {
    for (const bad of ["deny", false, null] as const) {
      const ctx = makeCtx()
      const reg = createToolRegistry(ctx)
      let bodyRan = false
      reg.register({ name: "t", description: "", inputSchema: {}, execute: async () => { bodyRan = true; return {} } })
      // a producer returns a non-object ("deny", false, null) → malformed
      ctx.on("tools/pre-execute", () => bad)
      await expect(reg.execute({ name: "t", args: {} })).rejects.toThrow(/decision/i)
      expect(bodyRan).toBe(false)
    }
  })

  it("allows when a pre-execute return is an object without a kind (tool executes)", async () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "t", description: "", inputSchema: {}, execute: async (args: { m?: string }) => ({ out: args.m ?? "" }) })
    // producer returns the raw ToolCall payload — object without `kind` → no decision
    ctx.on("tools/pre-execute", (payload: unknown) => payload)
    const result = await reg.execute({ name: "t", args: { m: "hi" } })
    expect(result.output).toEqual({ out: "hi" })
  })
})

describe("catalog", () => {
  it("generates a catalog and completeness gate fails on missing tool", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "a", description: "", inputSchema: {}, execute: async () => ({}) })
    const catalog = reg.genToolCatalog()
    expect(catalog.map((s) => s.name)).toEqual(["a"])
    // completeness gate: every registered tool must appear
    expect(() => reg.verifyToolCatalog([{ name: "a", description: "", inputSchema: {}, execute: async () => ({}) }], catalog)).not.toThrow()
    expect(() => reg.verifyToolCatalog([{ name: "a" }, { name: "b" }] as Tool[], catalog)).toThrow(/missing/i)
  })

  it("verify-tool-catalog gate fails loud (audit F03-7)", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "a", description: "", inputSchema: {}, execute: async () => ({}) })
    const catalog = reg.genToolCatalog()
    // completeness gate: registered tool must appear; missing → throw
    expect(() => reg.verifyToolCatalog([{ name: "a" }, { name: "ghost" }] as Tool[], catalog)).toThrow(/missing.*ghost/i)
  })
})

describe("exposure and promoted search", () => {
  it("schemas() includes direct tools and excludes deferred/hidden by default", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "read", description: "read a file", inputSchema: {}, exposure: "direct", execute: async () => ({}) })
    reg.register({ name: "write", description: "write a file", inputSchema: {}, exposure: "deferred", execute: async () => ({}) })
    reg.register({ name: "secret", description: "hidden", inputSchema: {}, exposure: "hidden", execute: async () => ({}) })
    const names = reg.schemas().map((s) => s.name)
    expect(names).toEqual(["read"])
  })

  it("exposure defaults to direct when omitted", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "x", description: "", inputSchema: {}, execute: async () => ({}) })
    expect(reg.schemas()[0]!.exposure).toBe("direct")
  })

  it("search throws before installSearch", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    expect(() => reg.search("read")).toThrow(/no search engine installed/i)
  })

  it("installSearch + search promotes matches into schemas()", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "read", description: "read a file", inputSchema: {}, exposure: "direct", execute: async () => ({}) })
    reg.register({ name: "grep", description: "search text", inputSchema: {}, exposure: "deferred", searchHint: "find patterns", execute: async () => ({}) })
    reg.installSearch((query, _opts) => {
      // fake engine: "grep" matches query "grep"
      return query.includes("grep")
        ? [{ name: "grep", description: "search text", inputSchema: {}, exposure: "deferred" as const }]
        : []
    })
    const matches = reg.search("grep")
    expect(matches.map((m) => m.name)).toEqual(["grep"])
    // promoted: deferred tool now appears in schemas()
    expect(reg.schemas().map((s) => s.name)).toEqual(["read", "grep"])
  })

  it("hidden tools stay out of schemas() even after promotion", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "secret", description: "", inputSchema: {}, exposure: "hidden", execute: async () => ({}) })
    reg.installSearch((_q, _o) => [{ name: "secret", description: "", inputSchema: {}, exposure: "hidden" as const }])
    reg.search("secret")
    expect(reg.schemas()).toEqual([])
  })

  it("deferred tool with no match stays out of schemas()", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "grep", description: "search text", inputSchema: {}, exposure: "deferred", execute: async () => ({}) })
    reg.installSearch(() => [])
    reg.search("nothing")
    expect(reg.schemas()).toEqual([])
  })

  it("deferredSearchIndex returns raw deferred metadata with searchHint", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "grep", description: "search text", inputSchema: {}, exposure: "deferred", searchHint: "find patterns", execute: async () => ({}) })
    reg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    expect(reg.deferredSearchIndex()).toEqual([{ name: "grep", description: "search text", inputSchema: {}, searchHint: "find patterns" }])
    expect(reg.deferredToolCount()).toBe(1)
  })
})
