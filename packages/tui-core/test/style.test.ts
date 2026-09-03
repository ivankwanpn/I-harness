// M36: ansi style — equality, minimal SGR diff, goldens.
import { describe, expect, it } from "vitest"
import { emitReset, emitSgrChange, SgrState, styleEquals } from "../src/ansi/style.ts"
import type { Style } from "../src/ansi/style.ts"

describe("styleEquals", () => {
  it("compares fg/bg structurally", () => {
    expect(styleEquals({}, {})).toBe(true)
    expect(styleEquals({ fg: { r: 1, g: 2, b: 3 } }, { fg: { r: 1, g: 2, b: 3 } })).toBe(true)
    expect(styleEquals({ fg: { r: 1, g: 2, b: 3 } }, { fg: { r: 1, g: 2, b: 4 } })).toBe(false)
    expect(styleEquals({ fg: { idx: 5 } }, { fg: { idx: 5 } })).toBe(true)
    expect(styleEquals({ fg: { idx: 5 } }, { fg: { r: 1, g: 2, b: 3 } })).toBe(false)
    expect(styleEquals({ fg: { idx: 5 } }, {})).toBe(false)
  })

  it("normalizes missing booleans to false", () => {
    expect(styleEquals({}, { bold: false })).toBe(true)
    expect(styleEquals({}, { bold: true })).toBe(false)
    expect(styleEquals({ bold: true, dim: false, underline: true }, { bold: true, underline: true })).toBe(true)
  })
})

describe("emitSgrChange", () => {
  it("same attrs → empty string", () => {
    const s = new SgrState()
    const target: Style = { bold: true, fg: { r: 255, g: 0, b: 0 } }
    expect(emitSgrChange(s, target)).toBe("\x1b[1m\x1b[38;2;255;0;0m")
    expect(emitSgrChange(s, target)).toBe("")
  })

  it("single-attr change emits only that SGR", () => {
    const s = new SgrState()
    emitSgrChange(s, { bold: true })
    expect(emitSgrChange(s, { bold: false })).toBe("\x1b[22m")
  })

  it("fg RGB → 38;2", () => {
    const s = new SgrState()
    expect(emitSgrChange(s, { fg: { r: 255, g: 0, b: 32 } })).toBe("\x1b[38;2;255;0;32m")
  })

  it("fg 256 index → 38;5", () => {
    const s = new SgrState()
    expect(emitSgrChange(s, { fg: { idx: 100 } })).toBe("\x1b[38;5;100m")
  })

  it("fg 16 → 3x/9x codes", () => {
    const s = new SgrState()
    expect(emitSgrChange(s, { fg: { idx: 1 } })).toBe("\x1b[31m")
    const s2 = new SgrState()
    expect(emitSgrChange(s2, { fg: { idx: 9 } })).toBe("\x1b[91m")
    const s3 = new SgrState()
    expect(emitSgrChange(s3, { fg: { idx: 15 } })).toBe("\x1b[97m")
  })

  it("bg has the 48/10x analog", () => {
    const s = new SgrState()
    expect(emitSgrChange(s, { bg: { r: 1, g: 2, b: 3 } })).toBe("\x1b[48;2;1;2;3m")
    const s2 = new SgrState()
    expect(emitSgrChange(s2, { bg: { idx: 1 } })).toBe("\x1b[41m")
    const s3 = new SgrState()
    expect(emitSgrChange(s3, { bg: { idx: 14 } })).toBe("\x1b[106m")
    const s4 = new SgrState()
    expect(emitSgrChange(s4, { bg: { idx: 90 } })).toBe("\x1b[48;5;90m")
  })

  it("attribute on/off codes", () => {
    const on: Array<[Style, string]> = [
      [{ bold: true }, "\x1b[1m"],
      [{ dim: true }, "\x1b[2m"],
      [{ italic: true }, "\x1b[3m"],
      [{ underline: true }, "\x1b[4m"],
      [{ strikethrough: true }, "\x1b[9m"],
      [{ invert: true }, "\x1b[7m"],
    ]
    const off: Array<[Style, string]> = [
      [{ bold: true }, "\x1b[22m"],
      [{ dim: true }, "\x1b[22m"],
      [{ italic: true }, "\x1b[23m"],
      [{ underline: true }, "\x1b[24m"],
      [{ strikethrough: true }, "\x1b[29m"],
    ]
    for (const [style, expected] of on) {
      const s = new SgrState()
      expect(emitSgrChange(s, style), JSON.stringify(style)).toBe(expected)
    }
    for (const [style, expected] of off) {
      const s = new SgrState()
      emitSgrChange(s, style)
      expect(emitSgrChange(s, {}), JSON.stringify(style)).toBe(expected)
    }
  })

  it("bold+dim share SGR 22 and repair in order", () => {
    const s = new SgrState()
    emitSgrChange(s, { bold: true })
    // bold off also clears dim before dim is re-set → final state correct
    expect(emitSgrChange(s, { dim: true })).toBe("\x1b[22m\x1b[2m")
  })

  it("fading a fg emits 39 (and removing bg emits 49)", () => {
    const s = new SgrState()
    emitSgrChange(s, { fg: { idx: 5 }, bg: { r: 0, g: 0, b: 0 } })
    expect(emitSgrChange(s, {})).toBe("\x1b[39m\x1b[49m")
  })

  it("full reset when inverse turns off, then re-applies", () => {
    const s = new SgrState()
    emitSgrChange(s, { invert: true, fg: { r: 255, g: 10, b: 20 } })
    expect(emitSgrChange(s, { bold: true })).toBe("\x1b[0m\x1b[1m")
    const s2 = new SgrState()
    emitSgrChange(s2, { invert: true })
    expect(emitSgrChange(s2, {})).toBe("\x1b[0m")
  })

  it("mutates the state to the target", () => {
    const s = new SgrState()
    emitSgrChange(s, { fg: { idx: 3 }, bold: true })
    expect(s.fg).toEqual({ idx: 3 })
    expect(s.bold).toBe(true)
    expect(s.emitted).toBe(true)
    emitSgrChange(s, {})
    expect(s.fg).toBeUndefined()
    expect(s.bold).toBe(false)
  })
})

describe("emitReset", () => {
  it("returns a full reset", () => {
    expect(emitReset()).toBe("\x1b[0m")
  })

  it("state.reset() zeroes everything incl. emitted", () => {
    const s = new SgrState()
    emitSgrChange(s, { fg: { idx: 1 }, italic: true })
    s.reset()
    expect(s.emitted).toBe(false)
    expect(s.fg).toBeUndefined()
    expect(s.italic).toBe(false)
    expect(s.matches({})).toBe(true)
  })
})
