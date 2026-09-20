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

  it("is TOTAL at a depth JSON.parse accepts — the walk is a frame list, not the JS stack (fix round 1)", () => {
    // Measured in the T1 review round: this walk raised RangeError at 3,600-3,700
    // nesting cold (~9,500 warm), while JSON.parse accepts at least 1,000,000.
    // 100_000 is ~10x the warm stack limit and 10x under what parse accepts. The
    // value is built here in memory from JSON text: JSON.stringify dies at the
    // stack limit, so it cannot be used to build (or print) a value this deep.
    const depth = 100_000
    const args = JSON.parse(`{"q":"x","extra":${"[".repeat(depth)}0${"]".repeat(depth)}}`) as unknown
    const schema: JsonSchemaNode = { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
    expect(() => validateJsonSchemaValue(schema, args)).not.toThrow()
    // `extra` is undeclared and additionalProperties is absent, so the deep
    // subtree is walked by the lossless check alone — the shape that died.
    expect(validateJsonSchemaValue(schema, args)).toEqual([])
  })

  it("is TOTAL on a deep DECLARED descent too — every level is a frame (fix round 1)", () => {
    // The case above only reaches the lossless walk. This one descends through
    // properties/required frames, so the validation walk itself is under test.
    // 40,000, not a marginal multiple: the DECLARED shape's warm stack limit is
    // measured at 3,000-4,000 (the ~9,500 often quoted is the PARSE shape's), and
    // JIT state swings ~2.6x — a host with a larger stack could let a recursive
    // driver survive 12,000 silently. 40,000 also keeps the memo-less mutant's
    // cost measurable: MEASURED, that mutant makes this test run ~6.0 min (two
    // validateJsonSchemaValue calls per test, and the cost is quadratic in depth),
    // so a larger depth would turn the pin's own run into the problem.
    const depth = 40_000
    let value: unknown = 0
    let schema: JsonSchemaNode = { type: "integer" }
    for (let i = 0; i < depth; i++) {
      value = { a: value }
      schema = { type: "object", properties: { a: schema }, required: ["a"] }
    }
    expect(() => validateJsonSchemaValue(schema, value)).not.toThrow()
    expect(validateJsonSchemaValue(schema, value)).toEqual([])
  })

  it("walks a shared-subtree DAG once, not once per path (fix round 2)", () => {
    // 2^40 PATHS over 40 unique nodes. Without the memo's within-call short-circuit
    // the walk doubles per level (measured: 12.8 ms at 2^16, 2,582 ms at 2^24), so
    // mutating it does not FAIL this test — it HANGS it: vitest applies its 5 s
    // timeout post-hoc to a synchronous body, so the run ends only when the walk
    // does. Probe that mutant at bounded levels instead. This case's value is
    // ISOLATION (the cross-call memo mutant leaves it green — that pin lives in
    // the DECLARED case above) and the exponential blowup, not sole detection.
    // JSON.parse cannot produce sharing — but a total function is named by its
    // contract, not by one caller.
    let node: unknown = 0
    for (let i = 0; i < 40; i++) node = { a: node, b: node }
    expect(() => validateJsonSchemaValue({ type: "object" }, node)).not.toThrow()
    expect(validateJsonSchemaValue({ type: "object" }, node)).toEqual([])
  })

  it("compares structured `enum` members by key SET, not by JSON text (fix round 1)", () => {
    // Measured in the T1 review round: {enum:[{a:1,b:2}]} against {b:2,a:1}
    // falsely reported, because the members' JSON TEXT was compared.
    expect(v({ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 })).toEqual([])
    expect(v({ enum: [[1, 2]] }, [1, 2])).toEqual([])
    // A member that really differs still reports.
    expect(v({ enum: [{ a: 1, b: 2 }] }, { a: 1, b: 3 })).toEqual(['"value" must be one of [{"a":1,"b":2}]'])
    expect(v({ enum: [{ a: 1 }] }, { a: 1, b: 2 })).toEqual(['"value" must be one of [{"a":1}]'])
  })

  it("reads only OWN members — the prototype chain is not a property (fix round 1)", () => {
    // Measured in the T1 review round: `properties: {toString: {type:"string"}}`
    // against `{}` falsely reported (Object.prototype.toString is not undefined),
    // and `required: ["toString"]` against `{}` silently did NOT report.
    expect(v({ type: "object", properties: { toString: { type: "string" } } }, {})).toEqual([])
    expect(v({ type: "object", required: ["toString"] }, {})).toEqual(['missing required property "value.toString"'])
    // An OWN toString is still read, and still checked.
    expect(v({ type: "object", properties: { toString: { type: "string" } } }, { toString: 1 })).toEqual(['"value.toString" must be a string'])
  })
})
