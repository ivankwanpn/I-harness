import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "../src/index.ts"
import { validateJsonSchemaValue, type JsonSchemaNode } from "../src/json-schema.ts"

describe("createToolRegistry.register — the assertion is a local contract", () => {
  it("refuses to register a LOCAL tool whose schema is outside the subset", () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    expect(() => tools.register({
      name: "bad", description: "", inputSchema: { type: "string", format: "date" }, execute: async () => ({}),
    })).toThrow(/not a supported keyword/)
  })

  it("registers a FOREIGN schema that is outside the subset — an MCP server's dialect is not ours", () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    expect(() => tools.register({
      name: "remote", description: "", inputSchemaForeign: true,
      inputSchema: { type: "object", properties: { d: { type: "string", format: "date" } } },
      execute: async () => ({}),
    })).not.toThrow()
    expect(tools.get("remote")).toBeDefined()
  })
})

// The other half of §3.8, and the reason both asserts have to exist: the foreign
// marker skips the ASSERT layer, never the VALUE layer. A remote schema must
// keep being checked for every keyword this repo DOES know — otherwise the
// marker would be a hole rather than a dialect boundary.
describe("a foreign schema skips the assertion, not the value layer", () => {
  it("still reports what it recognises, and stays silent about the server's dialect", () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    // The shape an SDK-built server sends: draft-07 `$schema` and `format` are
    // outside the subset; `type`, `properties` and `required` are inside it.
    const inputSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { text: { type: "string", format: "date" } },
      required: ["text"],
    }
    expect(() => tools.register({
      name: "remote", description: "", inputSchemaForeign: true, inputSchema, execute: async () => ({}),
    })).not.toThrow()
    expect(tools.get("remote")?.inputSchema).toBe(inputSchema)
    const schema = inputSchema as JsonSchemaNode
    expect(validateJsonSchemaValue(schema, { text: 5 })).toEqual(['"value.text" must be a string'])
    expect(validateJsonSchemaValue(schema, {})).toEqual(['missing required property "value.text"'])
    expect(validateJsonSchemaValue(schema, { text: "2026-09-21" })).toEqual([])
  })
})
