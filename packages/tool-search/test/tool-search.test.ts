import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool, type ToolSchema } from "@i-harness/core-tools"
import { registerToolSearch, toolSearchName } from "../src/index.ts"

function makeDeferred(name: string, description: string, hint?: string): Tool {
  return { name, description, inputSchema: {}, exposure: "deferred", searchHint: hint, execute: async () => ({}) }
}

describe("tool_search registration", () => {
  it("registers the tool_search tool as direct", () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    registerToolSearch(ctx, reg)
    const tool = reg.get(toolSearchName)
    expect(tool).toBeDefined()
    expect(tool!.exposure).toBe("direct")
    expect(reg.schemas().map((s) => s.name)).toContain(toolSearchName)
  })

  it("executing tool_search promotes deferred matches into schemas()", async () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    reg.register(makeDeferred("grep", "search text in files", "find patterns"))
    reg.register({ name: "read", description: "read a file", inputSchema: {}, execute: async () => ({}) })
    registerToolSearch(ctx, reg)

    const result = await reg.execute({ name: toolSearchName, args: { query: "patterns" } })
    const output = result.output as { matches: ToolSchema[]; totalDeferred: number }
    expect(output.matches.map((m) => m.name)).toEqual(["grep"])
    expect(output.totalDeferred).toBe(1)
    // promoted: next schemas() includes grep
    // NOTE: schemas() preserves registration order (direct + promoted deferred
    // filtered in place) — the brief's original assertion assumed a
    // direct-then-promoted ordering that core-tools (Task 1) does not provide.
    expect(reg.schemas().map((s) => s.name)).toEqual(["grep", "read", toolSearchName])
  })

  it("select: query promotes exactly the selected tools", async () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    reg.register(makeDeferred("grep", "search text"))
    reg.register(makeDeferred("write", "write a file"))
    registerToolSearch(ctx, reg)

    const result = await reg.execute({ name: toolSearchName, args: { query: "select:grep" } })
    const output = result.output as { matches: ToolSchema[] }
    expect(output.matches.map((m) => m.name)).toEqual(["grep"])
    // registration order: grep (deferred, promoted), write (deferred, not promoted), tool_search (direct)
    expect(reg.schemas().map((s) => s.name)).toEqual(["grep", toolSearchName])
  })

  it("hidden tools never appear in matches or schemas()", async () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "secret", description: "hidden thing", inputSchema: {}, exposure: "hidden", execute: async () => ({}) })
    registerToolSearch(ctx, reg)
    const result = await reg.execute({ name: toolSearchName, args: { query: "hidden" } })
    const output = result.output as { matches: ToolSchema[] }
    expect(output.matches).toEqual([])
    expect(reg.schemas().map((s) => s.name)).toEqual([toolSearchName])
  })

  it("validation errors propagate as execution failures", async () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    registerToolSearch(ctx, reg)
    await expect(reg.execute({ name: toolSearchName, args: { query: "" } })).rejects.toThrow(/empty/i)
  })

  it("CLI-style: tool_search output carries matches AND schemas() gains the promoted tool", async () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    reg.register({
      name: "grep",
      description: "search text in files",
      inputSchema: {},
      exposure: "deferred",
      searchHint: "find patterns",
      isReadOnly: true,
      execute: async () => ({ matches: [] }),
    })
    registerToolSearch(ctx, reg)

    const result = await reg.execute({ name: toolSearchName, args: { query: "search patterns" } })
    const output = result.output as { matches: { name: string }[] }
    expect(output.matches.map((m) => m.name)).toContain("grep")
    expect(reg.schemas().map((s) => s.name)).toContain("grep") // promoted
  })
})
