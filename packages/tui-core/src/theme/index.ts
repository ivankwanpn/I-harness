// M36: palettes + quantization. Palette values are all RGB hex strings;
// quantizeColor maps an RGB to the terminal's color depth (truecolor passthrough
// / nearest-ansi256 of the computed 240-color cube + gray ramp / ansi16
// hue-family pinning / sfu monochrome by luminance). boost=true implements the
// Windows contrast lift on dark terminals when quantization is ansi16/ansi256.

import type { RgbOrIndex } from "../ansi/style.ts"
import type { TerminalCapabilityContext } from "../types.ts"
import { GROKDAY } from "./grokday.ts"
import { GROKNIGHT } from "./groknight.ts"

export interface Rgb {
  r: number
  g: number
  b: number
}

export type ThemeKind = "groknight" | "grokday"

export interface Palette {
  bgTerminal: string
  bgDark: string
  bgBase: string
  bgLight: string
  bgHover: string
  bgVisual: string
  textPrimary: string
  textSecondary: string
  gray: string
  grayBright: string
  grayDim: string
  accentUser: string
  accentAssistant: string
  accentSystem: string
  accentError: string
  accentSuccess: string
  accentPlan: string
  accentVerify: string
  accentFeedback: string
  accentModel: string
  command: string
  path: string
  running: string
  warning: string
  promptBorder: string
  promptBorderActive: string
  hoverBorder: string
  selectionBorder: string
  scrollbarBg: string
  scrollbarFg: string
  diffDeleteBg: string
  diffDeleteFg: string
  diffInsertBg: string
  diffInsertFg: string
  diffEqualFg: string
  mdHeading: readonly [string, string, string, string, string, string]
  mdCode: string
  mdTaskChecked: string
  mdTaskUnchecked: string
  mdMuted: string
  mdCodeBg: string
  mdText: string
  linkFg: string
  pasteBg: string
  pasteFg: string
}

export function hexToRgb(hex: string): Rgb {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  }
}

const luminance = (c: Rgb): number =>
  (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

function boosted(c: Rgb): Rgb {
  // Windows contrast lift away from bgBase (spec §4.3, approximate):
  // +16 on dark backgrounds, +40 on gray_dim, +8 on mid grays.
  const l = luminance(c)
  const lift = l < 0.2 ? 16 : l < 0.32 ? 40 : l < 0.6 ? 8 : 0
  if (lift === 0) return c
  return { r: clamp255(c.r + lift), g: clamp255(c.g + lift), b: clamp255(c.b + lift) }
}

// The 240-color candidate set (6×6×6 cube 16..231 + 24-step gray ramp 232..255),
// computed rather than hardcoded.
const ANSI256: Rgb[] = (() => {
  const levels = [0, 95, 135, 175, 215, 255]
  const out = new Array<Rgb>(240)
  let i = 0
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) out[i++] = { r, g, b }
    }
  }
  for (let g = 8; g <= 238; g += 10) out[i++] = { r: g, g, b: g }
  return out
})()

function nearest256(c: Rgb): number {
  let best = 0
  let bestD = Number.POSITIVE_INFINITY
  for (let i = 0; i < ANSI256.length; i++) {
    const cand = ANSI256[i]
    const d = (cand.r - c.r) ** 2 + (cand.g - c.g) ** 2 + (cand.b - c.b) ** 2
    if (d < bestD) {
      bestD = d
      best = i < 216 ? 16 + i : 232 + (i - 216)
    }
  }
  return best
}

function hueOf(c: Rgb, max: number, min: number): number {
  const d = max - min
  if (d === 0) return 0
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const maxv = max / 255
  const minv = min / 255
  const dd = maxv - minv
  let h: number
  if (maxv === r) h = ((g - b) / dd) % 6
  else if (maxv === g) h = (b - r) / dd + 2
  else h = (r - g) / dd + 4
  const deg = h * 60
  return deg < 0 ? deg + 360 : deg
}

function toAnsi16(c: Rgb, dark: boolean): number {
  const max = Math.max(c.r, c.g, c.b)
  const min = Math.min(c.r, c.g, c.b)
  const v = max
  const s = max === 0 ? 0 : (max - min) / max
  if (s < 0.15) {
    // gray family: black/white extremes 8/15, mid grays 8 on dark / 7 on light
    if (v >= 0.85 * 255) return 15
    if (v < 0.2 * 255) return 8
    return dark ? 8 : 7
  }
  const hue = hueOf(c, max, min)
  const base =
    hue >= 345 || hue < 20 ? 1
    : hue < 80 ? 3
    : hue < 150 ? 2
    : hue < 205 ? 6
    : hue < 255 ? 4
    : 5
  return dark ? base + 8 : base
}

/**
 * Quantize an RGB color to the terminal's color depth.
 * boost=true applies the Windows dark contrast lift for ansi16/ansi256.
 */
export function quantizeColor(rgb: Rgb, cap: TerminalCapabilityContext, boost = false): RgbOrIndex {
  const level = cap.colorLevel
  if (level === "truecolor") return { r: rgb.r, g: rgb.g, b: rgb.b }
  if (level === "monochrome") return { idx: luminance(rgb) < 0.5 ? 7 : 15 }
  const b = boost && cap.dark ? boosted(rgb) : rgb
  if (level === "ansi16") return { idx: toAnsi16(b, cap.dark) }
  return { idx: nearest256(b) }
}

/** dark → groknight, light → grokday; an explicit `kind` wins. */
export function resolvePalette(cap: TerminalCapabilityContext, kind?: ThemeKind): Palette {
  const effective = kind ?? (cap.dark ? "groknight" : "grokday")
  return effective === "groknight" ? GROKNIGHT : GROKDAY
}
