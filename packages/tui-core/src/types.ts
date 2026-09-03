// Shared contracts between tui-core modules (G1 render core / G2 terminal io).
// Consumer files in groups G1/G2 may import ONLY from here (no cross-subgroup imports).

export type ColorLevel = "truecolor" | "ansi256" | "ansi16" | "monochrome"

export interface TerminalCapabilityContext {
  /** Terminal color depth. */
  colorLevel: ColorLevel
  /** Background polarity (OSC 11 / OS heuristic). Default dark. */
  dark: boolean
  /** kitty keyboard protocol available (DECRPM 27). */
  kitty: boolean
  /** Mouse SGR mode (1006) accepted. */
  mouse: boolean
  /** Bracketed paste (2004) accepted. */
  bracketedPaste: boolean
  /** Focus events (1004) accepted. */
  focusEvents: boolean
  /** Synchronized output (2026) accepted. */
  synchronizedOutput: boolean
  /** Brand string from XTVERSION / DA1 heuristics (e.g. "WindowsTerminal" | "xterm" | "kitty" | "wezterm"). */
  brand: string
  /** Multiplexer detected via environment. */
  multiplexer: "zellij" | "tmux" | "none"
  /** Legacy Windows ConHost (no modern ANSI). */
  legacyConsole: boolean
}

export function createUnknownCapabilities(): TerminalCapabilityContext {
  // Probe failure / test-rig default: everything off, 16-color, legacy-agnostic.
  return {
    colorLevel: "ansi16",
    dark: true,
    kitty: false,
    mouse: false,
    bracketedPaste: false,
    focusEvents: false,
    synchronizedOutput: false,
    brand: "unknown",
    multiplexer: "none",
    legacyConsole: false,
  }
}
