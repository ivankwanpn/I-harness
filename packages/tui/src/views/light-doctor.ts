// @i-harness/tui — G2 (M46a): /doctor light panel — the terminal capability
// context report. M47 G2: the report is now LIVE — the command re-runs the
// probe against the terminal behind a paint-suspend (the loop owns the
// window, ≤800ms); the row mapper stays the honest capability-context →
// report rows, and the probe-reply GRAMMAR the live run decodes (mirrored
// from tui-core's probe scan) lives HERE next to the report.

import type { TerminalCapabilityContext } from "@i-harness/tui-core"
import type { LightPanelRow } from "./light-panel.ts"

/** The capability context → report rows (field = value). */
export function doctorRows(cap: TerminalCapabilityContext): LightPanelRow[] {
  return [
    { label: "terminal", detail: cap.brand === "" ? "unknown" : cap.brand },
    { label: "color", detail: cap.colorLevel },
    { label: "dark", detail: cap.dark ? "yes" : "no" },
    { label: "multiplexer", detail: cap.multiplexer },
    { label: "mouse", detail: cap.mouse ? "supported" : "no" },
    { label: "bracketed paste", detail: cap.bracketedPaste ? "yes" : "no" },
    { label: "focus events", detail: cap.focusEvents ? "yes" : "no" },
    { label: "kitty keyboard", detail: cap.kitty ? "yes" : "no" },
    { label: "synchronized output", detail: cap.synchronizedOutput ? "yes" : "no" },
    { label: "legacy console", detail: cap.legacyConsole ? "yes" : "no" },
  ]
}

// ------------------------------------------------------------------ M47 G2: live probe grammar

/** The live probe's suspend-state rows — the panel renders these while the
 * paint-suspend holds (the run's answers replace them on settle). */
export function doctorProbingRows(): LightPanelRow[] {
  return [{ label: "Probing…" }]
}

/** sRGB luminance (BT.709) of a 0-255 channel — mirrors tui-core's
 * sRGBLuminance (probe/index.ts is the same math; not re-exported there). */
function lum(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** The live probe's XTVERSION DCS payload (`>|name-version`) → brand
 * (mirrors probe/index.ts brandFromXtversion — exactly the same names). */
export function doctorLiveBrand(payload: string): string | null {
  const name = payload.replace(/^>?\|/, "").toLowerCase()
  if (name.includes("kitty")) return "kitty"
  if (name.includes("wezterm")) return "wezterm"
  if (name.includes("iterm2")) return "iTerm2"
  if (name.includes("xterm")) return "xterm"
  return null
}

/** The live probe's OSC 11 payload (`11;rgb:RR/GG/BB` — the parser's onOsc
 * delivers it with the number prefix) → dark (mirrors probe/index.ts
 * parseOsc11). Non-matching payloads → null (not an answer). */
export function doctorLiveDark(payload: string): boolean | null {
  const m = /^(?:\d+;)?rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})/.exec(payload)
  if (m === null) return null
  const parts = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h.slice(0, 2), 16))
  for (const v of parts) if (!Number.isFinite(v)) return null
  const r = parts[0]!, g = parts[1]!, b = parts[2]!
  return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b) < 0.5
}
