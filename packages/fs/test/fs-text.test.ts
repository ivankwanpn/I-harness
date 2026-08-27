import { describe, expect, it } from "vitest"
import { normalizeLineEndings, detectLineEndings, restoreLineEndings, assertTextData, applyLiteralEdit } from "../src/text.ts"

describe("line endings", () => {
  it("normalizes CRLF to LF", () => {
    expect(normalizeLineEndings("a\r\nb\nc\r\nd")).toBe("a\nb\nc\nd")
  })
  it("detects CRLF from sample", () => {
    expect(detectLineEndings("a\r\nb\r\nc")).toBe("crlf")
    expect(detectLineEndings("a\nb\nc")).toBe("lf")
  })
  it("restores CRLF", () => {
    expect(restoreLineEndings("a\nb\nc", "crlf")).toBe("a\r\nb\r\nc")
  })
})

describe("assertTextData", () => {
  it("rejects binary (NUL byte)", () => {
    expect(() => assertTextData(new Uint8Array([0x68, 0x00, 0x69]))).toThrow(/binary|non-text/)
  })
  it("accepts UTF-8 text", () => {
    expect(assertTextData(new TextEncoder().encode("hi"))).toBe("hi")
  })
  it("rejects oversized", () => {
    expect(() => assertTextData(new TextEncoder().encode("x".repeat(100)), 10)).toThrow(/too large/i)
  })
})

describe("applyLiteralEdit", () => {
  it("replaces single occurrence", () => {
    const r = applyLiteralEdit("foo bar", "bar", "baz", false)
    expect(r).toEqual({ text: "foo baz", replacements: 1 })
  })
  it("reports ambiguous when multiple and not replaceAll", () => {
    const r = applyLiteralEdit("a b a", "a", "x", false)
    expect(r).toMatchObject({ error: "ambiguous", count: 2 })
  })
  it("replace_all replaces all", () => {
    const r = applyLiteralEdit("a b a", "a", "x", true)
    expect(r).toEqual({ text: "x b x", replacements: 2 })
  })
  it("reports not_found", () => {
    const r = applyLiteralEdit("abc", "zzz", "x", false)
    expect(r).toEqual({ error: "not_found" })
  })
})
