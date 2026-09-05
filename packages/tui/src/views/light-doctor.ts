// @i-harness/tui — G2 (M46a): /doctor light panel — the terminal capability
// context report. Reusing the tui-core probe: the app started already probed
// (probeCapabilities at host startup — before the TUI owns the terminal);
// re-running a LIVE probe mid-session would interleave raw escape queries with
// TUI frames (the probe's answers would corrupt the cell stream), so the
// honest report is the session's capability context (the last probe result) —
// the same fields `grok doctor` prints.

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
