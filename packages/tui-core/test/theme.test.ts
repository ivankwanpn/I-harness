// M36: theme — palettes (spec §5) + quantization + resolve.
import { describe, expect, it } from "vitest"
import { GROKDAY } from "../src/theme/grokday.ts"
import { GROKNIGHT } from "../src/theme/groknight.ts"
import { hexToRgb, quantizeColor, resolvePalette } from "../src/theme/index.ts"
import { createUnknownCapabilities } from "../src/types.ts"
import type { TerminalCapabilityContext } from "../src/types.ts"

const caps = (partial: Partial<TerminalCapabilityContext> = {}): TerminalCapabilityContext => ({
  ...createUnknownCapabilities(),
  ...partial,
})

describe("palettes", () => {
  it("groknight matches spec §5 exactly", () => {
    expect(GROKNIGHT).toMatchObject({
      bgTerminal: "#0a0a0a",
      bgDark: "#1c1c1c",
      bgBase: "#141414",
      bgLight: "#242424",
      bgHover: "#2c2c2c",
      bgVisual: "#363636",
      textPrimary: "#e1e1e1",
      textSecondary: "#c8c8c8",
      gray: "#6c6c6c",
      grayBright: "#787878",
      grayDim: "#585858",
      accentUser: "#c8c8c8",
      accentAssistant: "#bb9af7",
      accentSystem: "#7aa2f7",
      accentError: "#f7768e",
      accentSuccess: "#9ece6a",
      accentPlan: "#ffdb8d",
      accentVerify: "#bb9af7",
      accentFeedback: "#73daca",
      accentModel: "#1abc9c",
      command: "#e0af68",
      path: "#ff9e64",
      running: "#7dcfff",
      warning: "#e0af68",
      promptBorder: "#323237",
      promptBorderActive: "#505058",
      hoverBorder: "#1e1e22",
      selectionBorder: "#3c3c41",
      scrollbarBg: "#0c0c0c",
      scrollbarFg: "#242424",
      diffDeleteBg: "#420e14",
      diffDeleteFg: "#f7768e",
      diffInsertBg: "#063806",
      diffInsertFg: "#9ece6a",
      diffEqualFg: "#6c6c6c",
      mdHeading: ["#1abc9c", "#7aa2f7", "#9d7cd8", "#787878", "#6c6c6c", "#5a5a5a"],
      mdCode: "#3a95ab",
      mdTaskChecked: "#9ece6a",
      mdTaskUnchecked: "#c8c8c8",
      mdMuted: "#6c6c6c",
      mdCodeBg: "#1c1c1c",
      mdText: "#c8c8c8",
      linkFg: "#7aa6da",
      pasteBg: "#0c0c0c",
      pasteFg: "#c8c8c8",
    })
    expect(Object.isFrozen(GROKNIGHT)).toBe(true)
  })

  it("grokday covers the light slots", () => {
    expect(GROKDAY).toMatchObject({
      bgBase: "#eeeeee",
      bgLight: "#dedede",
      bgHover: "#d0d0d0",
      textPrimary: "#262626",
      textSecondary: "#444444",
      gray: "#767676",
      accentSystem: "#2f64d2",
      accentFeedback: "#0082aa",
      accentSuccess: "#378e23",
      accentAssistant: "#7d4bc6",
      accentError: "#cd3048",
      diffDeleteBg: "#f5dade",
      diffInsertBg: "#daf2dc",
    })
  })

  it("hexToRgb parses hex", () => {
    expect(hexToRgb("#3a95ab")).toEqual({ r: 58, g: 149, b: 171 })
    expect(hexToRgb("ffffff")).toEqual({ r: 255, g: 255, b: 255 })
  })
})

describe("quantizeColor", () => {
  it("truecolor passes through", () => {
    expect(quantizeColor({ r: 255, g: 128, b: 0 }, caps({ colorLevel: "truecolor" }))).toEqual({
      r: 255,
      g: 128,
      b: 0,
    })
  })

  it("ansi256 nearest of the computed cube + gray ramp", () => {
    // #3a95ab → cube (95,135,175) → 16 + 36*1 + 6*2 + 3 = 67
    expect(quantizeColor(hexToRgb("#3a95ab"), caps({ colorLevel: "ansi256" }))).toEqual({ idx: 67 })
    // exact gray ramp entry
    expect(quantizeColor({ r: 8, g: 8, b: 8 }, caps({ colorLevel: "ansi256" }))).toEqual({ idx: 232 })
    expect(quantizeColor({ r: 238, g: 238, b: 238 }, caps({ colorLevel: "ansi256" }))).toEqual({ idx: 255 })
  })

  it("ansi16 pins hue families with light variants when not dark", () => {
    expect(quantizeColor(hexToRgb("#9ece6a"), caps({ colorLevel: "ansi16", dark: true }))).toEqual({ idx: 10 })
    expect(quantizeColor(hexToRgb("#9ece6a"), caps({ colorLevel: "ansi16", dark: false }))).toEqual({ idx: 2 })
    // red family (#f7768e) → 9 on dark, 1 on light
    expect(quantizeColor(hexToRgb("#f7768e"), caps({ colorLevel: "ansi16", dark: true }))).toEqual({ idx: 9 })
    expect(quantizeColor(hexToRgb("#f7768e"), caps({ colorLevel: "ansi16", dark: false }))).toEqual({ idx: 1 })
    // blue (#2f64d2) → 12 on dark, 4 on light
    expect(quantizeColor(hexToRgb("#2f64d2"), caps({ colorLevel: "ansi16", dark: true }))).toEqual({ idx: 12 })
    // cyan (#0082aa) → 6 on light (family cyan)
    expect(quantizeColor(hexToRgb("#0082aa"), caps({ colorLevel: "ansi16", dark: false }))).toEqual({ idx: 6 })
  })

  it("ansi16 gray/black/white mapping", () => {
    expect(quantizeColor({ r: 108, g: 108, b: 108 }, caps({ colorLevel: "ansi16", dark: true }))).toEqual({ idx: 8 })
    expect(quantizeColor({ r: 108, g: 108, b: 108 }, caps({ colorLevel: "ansi16", dark: false }))).toEqual({ idx: 7 })
    expect(quantizeColor({ r: 0, g: 0, b: 0 }, caps({ colorLevel: "ansi16", dark: true }))).toEqual({ idx: 8 })
    expect(quantizeColor({ r: 255, g: 255, b: 255 }, caps({ colorLevel: "ansi16", dark: true }))).toEqual({ idx: 15 })
  })

  it("monochrome uses luminance (7/15)", () => {
    expect(quantizeColor({ r: 10, g: 10, b: 10 }, caps({ colorLevel: "monochrome" }))).toEqual({ idx: 7 })
    expect(quantizeColor({ r: 200, g: 200, b: 200 }, caps({ colorLevel: "monochrome" }))).toEqual({ idx: 15 })
  })

  it("boost lifts dark background tones on ansi256/ansi16 (dark only)", () => {
    const dark = caps({ colorLevel: "ansi256", dark: true })
    const noBoost = quantizeColor(hexToRgb("#2c2c2c"), dark)
    const boosted = quantizeColor(hexToRgb("#2c2c2c"), dark, true)
    expect(boosted).not.toEqual(noBoost)
    expect(noBoost).toEqual({ idx: 236 }) // (44,44,44) → gray 48
    expect(boosted).toEqual({ idx: 237 }) // (60,60,60) → gray 58
    // no-op on light terminals
    expect(
      quantizeColor(hexToRgb("#2c2c2c"), caps({ colorLevel: "ansi256", dark: false }), true),
    ).toEqual(noBoost)
    // no-op on truecolor
    expect(
      quantizeColor(hexToRgb("#2c2c2c"), caps({ colorLevel: "truecolor", dark: true }), true),
    ).toEqual({ r: 44, g: 44, b: 44 })
  })

  it("ansi16 boost applies the lift but keeps the hue family", () => {
    const dark = caps({ colorLevel: "ansi16", dark: true })
    expect(quantizeColor(hexToRgb("#9ece6a"), dark, true)).toEqual({ idx: 10 })
    // a lifted gray stays the gray family (8 on dark)
    expect(quantizeColor({ r: 44, g: 44, b: 44 }, dark, true)).toEqual({ idx: 8 })
  })
})

describe("resolvePalette", () => {
  it("dark → groknight, light → grokday", () => {
    expect(resolvePalette(caps({ dark: true }))).toBe(GROKNIGHT)
    expect(resolvePalette(caps({ dark: false }))).toBe(GROKDAY)
  })

  it("explicit kind wins over polarity", () => {
    expect(resolvePalette(caps({ dark: false }), "groknight")).toBe(GROKNIGHT)
    expect(resolvePalette(caps({ dark: true }), "grokday")).toBe(GROKDAY)
  })
})
