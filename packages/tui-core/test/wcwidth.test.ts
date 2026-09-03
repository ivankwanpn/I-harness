// M36: wcwidth — vendored column-width semantics (the exact contract table).
import { describe, expect, it } from "vitest"
import { clusterWidth, wcwidth } from "../src/wcwidth/index.ts"

const cp = (code: number): string => String.fromCodePoint(code)

describe("wcwidth", () => {
  it("matches the contract table", () => {
    const table: Array<[string, 0 | 1 | 2]> = [
      ["日", 2],
      ["a", 1],
      ["é", 1],
      ["•", 1],
      ["━", 2],
      ["Ａ", 2],
      ["😀", 2],
      ["́", 0],
      ["​", 0],
      ["⚠", 1],
      ["\x07", 0],
      ["中", 2],
      ["⊂", 1],
      ["┃", 1],
      ["❯", 1],
      ["╭", 1],
      ["█", 1],
      ["〜", 2],
    ]
    for (const [ch, expected] of table) {
      expect(wcwidth(ch), `wcwidth(${JSON.stringify(ch)})`).toBe(expected)
    }
  })

  it("returns 0 for controls, DEL and C1", () => {
    expect(wcwidth("\x00")).toBe(0)
    expect(wcwidth("\x07")).toBe(0)
    expect(wcwidth("\x1b")).toBe(0)
    expect(wcwidth("\x7f")).toBe(0)
    expect(wcwidth(cp(0x80))).toBe(0)
    expect(wcwidth(cp(0x9f))).toBe(0)
  })

  it("returns 0 across the zero-width ranges", () => {
    expect(wcwidth(cp(0x0300))).toBe(0)
    expect(wcwidth(cp(0x036f))).toBe(0)
    expect(wcwidth(cp(0x0483))).toBe(0)
    expect(wcwidth(cp(0x0489))).toBe(0)
    expect(wcwidth(cp(0x200b))).toBe(0)
    expect(wcwidth(cp(0x200f))).toBe(0)
    expect(wcwidth(cp(0x20d0))).toBe(0)
    expect(wcwidth(cp(0x20f0))).toBe(0)
    expect(wcwidth(cp(0xfe00))).toBe(0)
    expect(wcwidth(cp(0xfe0f))).toBe(0)
    expect(wcwidth(cp(0xe0000))).toBe(0)
    expect(wcwidth(cp(0xe0fff))).toBe(0)
  })

  it("returns 2 across the wide ranges", () => {
    expect(wcwidth(cp(0x1100))).toBe(2)
    expect(wcwidth(cp(0x115f))).toBe(2)
    expect(wcwidth(cp(0x2329))).toBe(2)
    expect(wcwidth(cp(0x232a))).toBe(2)
    expect(wcwidth(cp(0x2501))).toBe(2)
    expect(wcwidth(cp(0x2e80))).toBe(2)
    expect(wcwidth(cp(0x3000))).toBe(2)
    expect(wcwidth(cp(0x4e00))).toBe(2)
    expect(wcwidth(cp(0xa4cf))).toBe(2)
    expect(wcwidth(cp(0xa960))).toBe(2)
    expect(wcwidth(cp(0xa97f))).toBe(2)
    expect(wcwidth(cp(0xac00))).toBe(2)
    expect(wcwidth(cp(0xd7a3))).toBe(2)
    expect(wcwidth(cp(0xf900))).toBe(2)
    expect(wcwidth(cp(0xfaff))).toBe(2)
    expect(wcwidth(cp(0xfe10))).toBe(2)
    expect(wcwidth(cp(0xfe19))).toBe(2)
    expect(wcwidth(cp(0xfe30))).toBe(2)
    expect(wcwidth(cp(0xfe6f))).toBe(2)
    expect(wcwidth(cp(0xff00))).toBe(2)
    expect(wcwidth(cp(0xff60))).toBe(2)
    expect(wcwidth(cp(0xffe0))).toBe(2)
    expect(wcwidth(cp(0xffe6))).toBe(2)
    expect(wcwidth(cp(0x1f000))).toBe(2)
    expect(wcwidth(cp(0x1f02f))).toBe(2)
    expect(wcwidth(cp(0x1f300))).toBe(2)
    expect(wcwidth(cp(0x1f64f))).toBe(2)
    expect(wcwidth(cp(0x1f900))).toBe(2)
    expect(wcwidth(cp(0x1f9ff))).toBe(2)
    expect(wcwidth(cp(0x20000))).toBe(2)
    expect(wcwidth(cp(0x2fffd))).toBe(2)
    expect(wcwidth(cp(0x30000))).toBe(2)
    expect(wcwidth(cp(0x3fffd))).toBe(2)
  })

  it("keeps box-drawing narrow except the heavy horizontal", () => {
    expect(wcwidth(cp(0x2500))).toBe(1)
    expect(wcwidth(cp(0x2501))).toBe(2)
    expect(wcwidth(cp(0x2503))).toBe(1)
    expect(wcwidth(cp(0x2550))).toBe(1)
    expect(wcwidth(cp(0x256d))).toBe(1)
    expect(wcwidth(cp(0x257f))).toBe(1)
    expect(wcwidth(cp(0x2588))).toBe(1)
  })

  it("treats ambiguous characters as 1 (U+276F included)", () => {
    expect(wcwidth(cp(0x00a1))).toBe(1)
    expect(wcwidth(cp(0x2282))).toBe(1)
    expect(wcwidth(cp(0x276f))).toBe(1)
    expect(wcwidth(cp(0x26a0))).toBe(1)
  })

  it("returns 2 for U+301C (wcwidth-style wide in CJK context)", () => {
    expect(wcwidth(cp(0x301c))).toBe(2)
  })

  it("handles surrogates and nonprintables as 1", () => {
    expect(wcwidth("\ud800")).toBe(1)
    expect(wcwidth("\udfff")).toBe(1)
    expect(wcwidth("")).toBe(1)
  })
})

describe("clusterWidth", () => {
  it("uses the base character width, min 1", () => {
    expect(clusterWidth("中")).toBe(2)
    expect(clusterWidth("a")).toBe(1)
    expect(clusterWidth("é")).toBe(1)
    expect(clusterWidth("é")).toBe(1)
  })

  it("floors combining-only graphemes at 1", () => {
    expect(clusterWidth("́")).toBe(1)
    expect(clusterWidth("​́")).toBe(1)
  })
})
