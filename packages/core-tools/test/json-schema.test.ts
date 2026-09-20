import { describe, expect, it } from "vitest"
import { validateJsonSchemaValue, type JsonSchemaNode } from "../src/json-schema.ts"

const v = (schema: JsonSchemaNode, value: unknown, path = "value") => validateJsonSchemaValue(schema, value, path)

describe("validateJsonSchemaValue — the value layer (spec §3.1)", () => {
  it("returns [] for a conforming value and does not coerce", () => {
    const schema: JsonSchemaNode = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] }
    expect(v(schema, { n: 3 })).toEqual([])
    // No coercion of any kind: a string where an integer belongs is a violation
    // even though Number("3") works. The validator reports; it never repairs.
    expect(v(schema, { n: "3" })).toEqual(['"value.n" must be an integer'])
  })

  it("distinguishes integer from number (§3.3)", () => {
    expect(v({ type: "integer" }, 3)).toEqual([])
    expect(v({ type: "number" }, 3)).toEqual([])
    expect(v({ type: "integer" }, 3.5)).toEqual(['"value" must be an integer'])
    expect(v({ type: "number" }, 3.5)).toEqual([])
  })

  it("rejects non-JSON numbers — NaN, Infinity and -0 are not JSON (§3.3)", () => {
    for (const bad of [NaN, Infinity, -Infinity, -0]) {
      expect(v({ type: "number" }, bad)).toEqual(['"value" must be a finite JSON number'])
    }
  })

  it("names the path: a nested property and an array element", () => {
    const schema: JsonSchemaNode = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    }
    expect(v(schema, { tags: ["a", 1] })).toEqual(['"value.tags[1]" must be a string'])
  })

  it("reports a missing required property by name, and `undefined` counts as missing", () => {
    const schema: JsonSchemaNode = { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    expect(v(schema, {})).toEqual(['missing required property "value.path"'])
    // A present-but-undefined member is missing: the same rule this repo ruled
    // on for `undefined`-valued KEYWORDS (§3.5), applied to values.
    expect(v(schema, { path: undefined })).toEqual(['missing required property "value.path"'])
  })

  it("supports a type ARRAY (§3.4) — subagent/src/tools.ts:77's shape", () => {
    const schema: JsonSchemaNode = { type: ["string", "number"] }
    expect(v(schema, "3")).toEqual([])
    expect(v(schema, 3)).toEqual([])
    expect(v(schema, true)).toEqual(['"value" must be one of "string", "number"'])
    expect(v(schema, {})).toEqual(['"value" must be one of "string", "number"'])
  })

  it("treats an `undefined`-valued keyword as ABSENT (§3.5 — plan-mode/src/index.ts:25's shape)", () => {
    // `{ properties: undefined }` means "no properties declared", so any object
    // conforms — the same rule as W4's F1 (a field CARRYING a value, not a key
    // existing), one level up.
    const schema = { type: "object", properties: undefined, required: undefined } as unknown as JsonSchemaNode
    expect(v(schema, {})).toEqual([])
    expect(v(schema, { anything: 1 })).toEqual([])
  })

  it("supports `additionalProperties` as a boolean AND as a schema (§3.6.1)", () => {
    const closed: JsonSchemaNode = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false }
    expect(v(closed, { a: "x" })).toEqual([])
    expect(v(closed, { a: "x", b: 1 })).toEqual(['"value.b" is not a declared property (additionalProperties: false)'])
    // workflow/src/tool.ts:73's shape: a map of string→string.
    const map: JsonSchemaNode = { type: "object", additionalProperties: { type: "string" } }
    expect(v(map, { any: "x", name: "y" })).toEqual([])
    expect(v(map, { any: 1 })).toEqual(['"value.any" must be a string'])
  })

  it("supports enum, minimum, maximum and maxItems — the three keywords dsh has no support for", () => {
    expect(v({ type: "string", enum: ["a", "b"] }, "a")).toEqual([])
    expect(v({ type: "string", enum: ["a", "b"] }, "c")).toEqual(['"value" must be one of ["a","b"]'])
    expect(v({ type: "number", minimum: 1 }, 0)).toEqual(['"value" must be >= 1'])
    expect(v({ type: "number", maximum: 20 }, 21)).toEqual(['"value" must be <= 20'])
    expect(v({ type: "array", items: { type: "string" }, maxItems: 2 }, ["a", "b", "c"])).toEqual(['"value" must have at most 2 items'])
  })

  it("requires objects and arrays to be LOSSLESS JSON (§3.3)", () => {
    expect(v({ type: "object" }, { fn: () => {} })).toEqual(['"value" must be a lossless JSON object'])
    expect(v({ type: "array" }, [1, , 3] as unknown[])).toEqual(['"value" must be a dense lossless JSON array'])
  })

  it("is TOTAL — never throws, for any value against any schema", () => {
    const schemas: unknown[] = [
      { type: "object" }, { type: "array" }, { type: "string" }, { type: ["string", "number"] },
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", additionalProperties: { type: "string" } }, {},
    ]
    const values: unknown[] = [undefined, null, 0, -0, NaN, "", "x", true, {}, [], { a: 1 }, Object.create(null), new Map()]
    for (const s of schemas) for (const val of values) {
      expect(() => validateJsonSchemaValue(s as JsonSchemaNode, val)).not.toThrow()
    }
  })
})
