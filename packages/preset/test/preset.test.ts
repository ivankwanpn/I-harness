import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool, type ToolRegistry } from "@i-harness/core-tools"
import { parsePreset, mountPreset } from "../src/index.ts"

describe("preset", () => {
  it("parses a preset definition", () => {
    const preset = parsePreset(JSON.stringify({
      name: "default",
      systemPrompt: "You are a coding agent.",
      tools: ["read", "edit"],
    }))
    expect(preset.name).toBe("default")
    expect(preset.tools).toEqual(["read", "edit"])
  })

  it("parses an optional model selector", () => {
    const preset = parsePreset(JSON.stringify({
      name: "default",
      systemPrompt: "p",
      tools: ["read"],
      model: "mock",
    }))
    expect(preset.model).toBe("mock")
  })

  it("rejects a preset missing required fields", () => {
    expect(() => parsePreset(JSON.stringify({ name: "x" }))).toThrow(/name, systemPrompt, tools required/)
    expect(() => parsePreset("not json")).toThrow()
  })

  it("mounts a preset into a child scope with its tools", () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    const t: Tool = { name: "read", description: "", inputSchema: {}, execute: async () => ({}) }
    reg.register(t)
    const provider = { resolve: (name: string) => name === "read" ? t : null }
    const child = mountPreset(ctx, { name: "default", systemPrompt: "p", tools: ["read"] }, provider)
    expect(child).toBeDefined()
  })

  it("registers the preset's resolved tools into the child scope", () => {
    const ctx = createContext()
    const t: Tool = { name: "read", description: "", inputSchema: {}, execute: async () => ({}) }
    const provider = { resolve: (name: string) => name === "read" ? t : null }
    const child = mountPreset(ctx, { name: "default", systemPrompt: "p", tools: ["read"] }, provider)
    const childReg = child.services.get<ToolRegistry>("tools/registry")
    expect(childReg.schemas().map((s) => s.name)).toEqual(["read"])
    // preset metadata is exposed on the child scope (per-agent configuration)
    expect(child.services.get<{ name: string }>("preset").name).toBe("default")
  })

  it("throws on an unknown tool — fail loud, not silent (audit F10-1)", () => {
    const ctx = createContext()
    const provider = { resolve: () => null }
    expect(() =>
      mountPreset(ctx, { name: "default", systemPrompt: "p", tools: ["nope"] }, provider),
    ).toThrow(/preset 'default' requires unknown tool: nope/)
  })
})
