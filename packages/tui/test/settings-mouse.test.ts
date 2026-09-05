// M46b G1: the Mouse settings knobs — the 7-row set (grok vocabulary),
// defaults, cycles, display formatting (speed multiplier), and the opt-in
// mouse-reporting-toggle gating (settings default off; env force-on is the
// host's resolution — the registry command hides while the feature is off).

import { describe, expect, it } from "vitest"
import { normalizeSettings, SETTINGS_DEFAULT_WORD_SEPARATORS } from "@i-harness/settings"
import {
  mouseKnobRows,
  nextScrollMode,
  nextKeepTextSelection,
  speedDisplay,
  stepScrollLines,
  stepScrollSpeed,
  MOUSE_SPEED_MAX,
  MOUSE_SPEED_MIN,
  MOUSE_LINES_MAX,
  MOUSE_LINES_MIN,
} from "../src/app/settings-mouse.ts"
import { speedToMultiplier } from "../src/app/scroll-stream.ts"
import { toggleMouseReportingCommand } from "../src/app/slash/impl/mouse.ts"
import type { SettingsSnapshot } from "../src/views/settings.ts"

const snap = (over: Partial<SettingsSnapshot> = {}): SettingsSnapshot => ({
  theme: "system",
  transcriptMode: "normal",
  timestamps: false,
  compact: false,
  guardian: false,
  alwaysApprove: true,
  activeProviderId: "",
  activeProviderName: "",
  defaultModel: { provider: "", model: "" },
  mouseScrollSpeed: 50,
  mouseScrollMode: "auto",
  mouseScrollLines: 3,
  mouseInvertScroll: false,
  mouseKeepTextSelection: "flash",
  mouseWordSeparators: SETTINGS_DEFAULT_WORD_SEPARATORS,
  mouseReportingToggle: false,
  ...over,
})

describe("settings-mouse knobs (M46b G1)", () => {
  it("the 7 rows, their order and their defaults", () => {
    const rows = mouseKnobRows(snap())
    expect(rows.map((r) => r.label)).toEqual([
      "scroll_speed", "scroll_mode", "scroll_lines", "invert_scroll",
      "keep_text_selection", "word_separators", "mouse_reporting_toggle",
    ])
    expect(rows[0]!.value).toBe("50 (1.0x)")
    expect(rows[1]!.value).toBe("auto")
    expect(rows[2]!.value).toBe("3")
    expect(rows[3]!.value).toBe("off")
    expect(rows[4]!.value).toBe("flash")
    // The separator set is opaque on the modal row — truncated to 24 + …
    expect(rows[5]!.value).toBe(`${SETTINGS_DEFAULT_WORD_SEPARATORS.slice(0, 24)}…`)
    expect(rows[6]!.value).toBe("off")
  })

  it("speed display mirrors the multiplier (1→0.1x, 100→6.0x)", () => {
    expect(speedDisplay(1)).toBe("0.1x")
    expect(speedDisplay(50)).toBe("1.0x")
    expect(speedDisplay(100)).toBe("6.0x")
    expect(speedToMultiplier(75)).toBeCloseTo(3.5, 5)
  })

  it("cycles: scroll_mode auto→wheel→trackpad→auto; keep_text_selection flash→hold→word_select→flash", () => {
    expect(nextScrollMode("auto")).toBe("wheel")
    expect(nextScrollMode("wheel")).toBe("trackpad")
    expect(nextScrollMode("trackpad")).toBe("auto")
    expect(nextKeepTextSelection("flash")).toBe("hold")
    expect(nextKeepTextSelection("hold")).toBe("word_select")
    expect(nextKeepTextSelection("word_select")).toBe("flash")
  })

  it("steppers clamp to the grok bounds (1-100 / 1-10)", () => {
    expect(stepScrollSpeed(50, 1)).toBe(51)
    expect(stepScrollSpeed(100, 1)).toBe(MOUSE_SPEED_MAX)
    expect(stepScrollSpeed(1, -1)).toBe(MOUSE_SPEED_MIN)
    expect(stepScrollLines(3, 1)).toBe(4)
    expect(stepScrollLines(10, 1)).toBe(MOUSE_LINES_MAX)
    expect(stepScrollLines(1, -1)).toBe(MOUSE_LINES_MIN)
  })

  it("a 100-speed snap shows the multiplier + an off toggle reads back", () => {
    const rows = mouseKnobRows(snap({ mouseScrollSpeed: 100, mouseReportingToggle: true }))
    expect(rows[0]!.value).toBe("100 (6.0x)")
    expect(rows[6]!.value).toBe("on")
  })

  it("the settings-store defaults normalize to the grok defaults (off toggle, 50/auto/3)", () => {
    const s = normalizeSettings(undefined)
    expect(s.tui.prefs.scrollSpeed).toBe(50)
    expect(s.tui.prefs.scrollMode).toBe("auto")
    expect(s.tui.prefs.scrollLines).toBe(3)
    expect(s.tui.prefs.invertScroll).toBe(false)
    expect(s.tui.prefs.keepTextSelection).toBe("flash")
    expect(s.tui.prefs.wordSeparators).toBe(SETTINGS_DEFAULT_WORD_SEPARATORS)
    expect(s.tui.prefs.mouseReportingToggle).toBe(false)
    // loose values degrade to the defaults (the same discipline as every pref).
    const dirty = normalizeSettings({ tui: { prefs: { scrollSpeed: 999, scrollLines: 0, mouseReportingToggle: "yes", scrollMode: "lol" } } } as never)
    expect(dirty.tui.prefs.scrollSpeed).toBe(50)
    expect(dirty.tui.prefs.scrollLines).toBe(3)
    expect(dirty.tui.prefs.scrollMode).toBe("auto")
    expect(dirty.tui.prefs.mouseReportingToggle).toBe(false)
  })

  it("/toggle-mouse-reporting is hidden + inert while the feature is off, visible+executable when on", () => {
    const cmd = toggleMouseReportingCommand()
    const offCtx = { app: undefined as never, mouseReportingToggle: false } as never
    const onCtx = { mouseReportingToggle: true, app: undefined as never } as never
    expect(cmd.visible!(offCtx)).toBe(false)
    expect(cmd.visible!(onCtx)).toBe(true)
    // run with the feature on flips app.mouse.enabled + clears the engine.
    const app = {
      mouse: {
        enabled: true,
        hovered: new Set(["row-1"]),
        engine: { clearCount: 0, clear: function (this: { clearCount: number }): void { this.clearCount++ } },
      },
    }
    const toastTexts: string[] = []
    cmd.run!({ app, mouseReportingToggle: true, toast: (t: string) => toastTexts.push(t) } as never)
    expect(app.mouse.enabled).toBe(false)
    expect(app.mouse.hovered.size).toBe(0)
    expect(app.mouse.engine.clearCount).toBe(1)
    expect(toastTexts).toEqual(["Mouse reporting off"])
  })
})
