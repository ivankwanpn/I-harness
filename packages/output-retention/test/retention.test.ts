import { describe, expect, it } from "vitest"
import { createTextRetainer, type TextRetainerOptions } from "../src/index.ts"

function retain(chunks: string[], opts: TextRetainerOptions) {
  const r = createTextRetainer(opts)
  for (const c of chunks) r.push(c)
  return r.finish()
}

// True if `s` contains a surrogate code unit that is not part of a well-formed pair.
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return true
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i += 1 // skip the paired low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true
    }
  }
  return false
}

describe("TextRetainer", () => {
  it("headTail keeps headRatio from the head and the rest from the tail, with exact omission", () => {
    const out = retain(["a".repeat(100), "b".repeat(100), "c".repeat(100)], { maxBytes: 100, mode: "headTail", headRatio: 0.5 })
    expect(out.text.length).toBe(100)
    expect(out.text.startsWith("a".repeat(50))).toBe(true)
    expect(out.text.endsWith("c".repeat(50))).toBe(true)
    expect(out.truncated).toBe(true)
    expect(out.omittedBytes).toBe(200)
  })

  it("head keeps only the first maxBytes", () => {
    const out = retain(["x".repeat(200)], { maxBytes: 50, mode: "head" })
    expect(out.text).toBe("x".repeat(50))
    expect(out.truncated).toBe(true)
    expect(out.omittedBytes).toBe(150)
  })

  it("within budget: no truncation, zero omitted", () => {
    const out = retain(["short"], { maxBytes: 100 })
    expect(out.text).toBe("short")
    expect(out.truncated).toBe(false)
    expect(out.omittedBytes).toBe(0)
  })

  it("empty input", () => {
    const out = retain([], { maxBytes: 100 })
    expect(out.text).toBe("")
    expect(out.truncated).toBe(false)
    expect(out.omittedBytes).toBe(0)
  })

  it("never splits a UTF-8 multi-byte character at the boundary", () => {
    const emoji = "😀".repeat(30) // 4 bytes each → 120 bytes
    const out = retain([emoji], { maxBytes: 10, mode: "head" })
    expect(Buffer.byteLength(out.text, "utf-8")).toBeLessThanOrEqual(10) // within budget
    expect(out.text.length % 4).toBe(0) // whole characters only
    expect(out.truncated).toBe(true)
    expect(out.omittedBytes).toBe(120 - Buffer.byteLength(out.text, "utf-8")) // exact omission
  })

  it("headTail boundary does not split a multi-byte char", () => {
    const emoji = "😀".repeat(20) // 80 bytes
    const out = retain([emoji], { maxBytes: 12, mode: "headTail", headRatio: 0.5 }) // 6 head + 6 tail
    expect(out.text.length % 4).toBe(0)
    expect(out.truncated).toBe(true)
  })

  it("never emits a lone surrogate when the byte budget splits a surrogate pair", () => {
    // 😀 is 4 bytes / 2 UTF-16 code units; "😀x" is 5 bytes. A 3-byte budget
    // fits neither the pair (4 bytes) nor a dangling high half alone.
    const out = retain(["😀x"], { maxBytes: 3, mode: "head" })
    expect(out.text).toBe("")
    expect(out.truncated).toBe(true)
    expect(out.omittedBytes).toBe(5)
  })

  it("headTail tail never starts with the low half of a surrogate pair", () => {
    const emoji = "😀".repeat(20) // 80 bytes / 40 code units
    // headBytes = floor(13 * 0.5) = 6, tailBytes = 7 → a naive tail slice
    // starts at code-unit index 33, the low half of an emoji.
    const out = retain([emoji], { maxBytes: 13, mode: "headTail", headRatio: 0.5 })
    expect(out.text.length % 4).toBe(0)
    expect(hasLoneSurrogate(out.text)).toBe(false)
    expect(out.truncated).toBe(true)
    expect(out.omittedBytes).toBe(80 - Buffer.byteLength(out.text, "utf-8"))
  })

  it("validates config fail-loud", () => {
    expect(() => createTextRetainer({ maxBytes: 0 })).toThrow(/maxBytes/)
    expect(() => createTextRetainer({ maxBytes: -5 })).toThrow(/maxBytes/)
    expect(() => createTextRetainer({ maxBytes: 10, headRatio: 0 })).toThrow(/headRatio/)
    expect(() => createTextRetainer({ maxBytes: 10, headRatio: 1.5 })).toThrow(/headRatio/)
    expect(() => createTextRetainer({ maxBytes: 10, mode: "bogus" as never })).toThrow(/mode/)
  })

  it("defaults: headTail with headRatio 0.5", () => {
    const out = retain(["a".repeat(20), "b".repeat(20)], { maxBytes: 10 })
    expect(out.text.startsWith("a".repeat(5))).toBe(true)
    expect(out.text.endsWith("b".repeat(5))).toBe(true)
  })
})
