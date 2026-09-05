// @i-harness/tui — M46b G1: the Mouse settings category (spec §4 knobs).
//
// The REAL 7-knob row set (grok's `ui.*` mouse vocabulary; the M46a "soon"
// placeholder row is replaced by views/settings.ts):
//   scroll_speed       1-100 → 0.1×..6× (50 = 1.0×)      [int stepper]
//   scroll_mode        auto | wheel | trackpad           [cycle]
//   scroll_lines       1-10 (default 3; per-terminal brands in charge) [int stepper]
//   invert_scroll      on/off                            [toggle]
//   keep_text_selection flash | hold | word_select       [cycle]
//   word_separators    a seed string (grok's default set) [edit/blob row: value display]
//   mouse_reporting_toggle on/off (opt-in — Ctrl+R + /toggle-mouse-reporting) [toggle]
//
// Row value formatting + cycles are pure here; the modal binder (settings.ts)
// persists through the settings store. Brand default table (the "unset" state
// display + the loop profile math) lives in scroll-stream.ts — this file owns
// the SETTINGS SURFACE vocabulary only.

import type {
  SettingsKeepTextSelection,
  SettingsScrollMode,
} from "@i-harness/settings"
import type { SettingsKnobRow } from "../views/settings.ts"
import type { SettingsSnapshot } from "../views/settings.ts"
import { speedToMultiplier } from "./scroll-stream.ts"

export const MOUSE_ON = "on"
export const MOUSE_OFF = "off"

/** scroll_speed displayed as a multiplier (50 → "1.0x"). */
export function speedDisplay(speed: number): string {
  const m = speedToMultiplier(Math.max(1, Math.min(100, speed)))
  return `${m.toFixed(1)}x`
}

export const SCROLL_MODES: SettingsScrollMode[] = ["auto", "wheel", "trackpad"]

export function nextScrollMode(mode: SettingsScrollMode): SettingsScrollMode {
  const i = SCROLL_MODES.indexOf(mode)
  return SCROLL_MODES[(i + 1) % SCROLL_MODES.length]!
}

export const KEEP_TEXT_SELECTION_MODES: SettingsKeepTextSelection[] = ["flash", "hold", "word_select"]

export function nextKeepTextSelection(mode: SettingsKeepTextSelection): SettingsKeepTextSelection {
  const i = KEEP_TEXT_SELECTION_MODES.indexOf(mode)
  return KEEP_TEXT_SELECTION_MODES[(i + 1) % KEEP_TEXT_SELECTION_MODES.length]!
}

/** The Mouse category rows (in grok's order speed → mode → lines → invert →
 * selection → separators → reporting toggle). `snap.mouse*` come from the
 * extended SettingsSnapshot (views/settings.ts). */
export function mouseKnobRows(snap: SettingsSnapshot): SettingsKnobRow[] {
  return [
    {
      label: "scroll_speed",
      value: `${snap.mouseScrollSpeed} (${speedDisplay(snap.mouseScrollSpeed)})`,
      kind: "cycle",
    },
    { label: "scroll_mode", value: snap.mouseScrollMode, kind: "cycle" },
    {
      label: "scroll_lines",
      // The registry/knob default is 3 while unset — the per-terminal profile
      // stays in charge (grok's own display honesty).
      value: `${snap.mouseScrollLines}`,
      kind: "cycle",
    },
    { label: "invert_scroll", value: snap.mouseInvertScroll ? MOUSE_ON : MOUSE_OFF, kind: "toggle" },
    { label: "keep_text_selection", value: snap.mouseKeepTextSelection, kind: "cycle" },
    {
      label: "word_separators",
      // The separator set is opaque; the modal shows the grok default or the
      // user's string truncated (the row kind stays a cycle — no editor yet:
      // editing the raw set is an M46b+/future text-input surface).
      value: snap.mouseWordSeparators.length > 24
        ? `${snap.mouseWordSeparators.slice(0, 24)}…`
        : snap.mouseWordSeparators,
      kind: "cycle",
    },
    { label: "mouse_reporting_toggle", value: snap.mouseReportingToggle ? MOUSE_ON : MOUSE_OFF, kind: "toggle" },
  ]
}

/** Bounds the stepper rows honor (grok 1-100 / 1-10). */
export const MOUSE_SPEED_MIN = 1
export const MOUSE_SPEED_MAX = 100
export const MOUSE_LINES_MIN = 1
export const MOUSE_LINES_MAX = 10

/** Steppers: cycle rows advance by ±1; the settings modal applies ±1 (the
 * grok mid-range policy: Up/Down ±1, Left/Right ±5 — the modal's nav actions
 * are the cycle driver; keeping the ±1 path here keeps the tests hermetic). */
export function stepScrollSpeed(value: number, delta: 1 | -1): number {
  return Math.max(MOUSE_SPEED_MIN, Math.min(MOUSE_SPEED_MAX, value + delta))
}

export function stepScrollLines(value: number, delta: 1 | -1): number {
  return Math.max(MOUSE_LINES_MIN, Math.min(MOUSE_LINES_MAX, value + delta))
}
