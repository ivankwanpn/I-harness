// G2 screen-mode policy — CLI > config > auto (exact rule order).
//
// Auto rules: zellij → inline (native pane), tmux → inline, legacy console →
// minimal, else fullscreen. `reason` names the rule that fired; when M36's
// missing inline/minimal engines force a downgrade the reason becomes the
// fallback marker "pending-inline-engine (M37)" — `fallback` is the mode the
// caller must actually render.
import type { TerminalCapabilityContext } from "../types.ts"

export type ScreenMode = "fullscreen" | "inline" | "minimal"

export interface ScreenModeResolution {
  mode: ScreenMode
  fallback: ScreenMode
  reason: string
}

export function resolveScreenMode(input: {
  cli?: ScreenMode
  config?: ScreenMode
  cap: TerminalCapabilityContext
}): ScreenModeResolution {
  const { cli, config, cap } = input
  let mode: ScreenMode
  let reason: string
  if (cli !== undefined) {
    mode = cli
    reason = "cli"
  } else if (config !== undefined) {
    mode = config
    reason = "config"
  } else if (cap.multiplexer === "zellij") {
    mode = "inline"
    reason = "auto:zellij"
  } else if (cap.multiplexer === "tmux") {
    mode = "inline"
    reason = "auto:tmux"
  } else if (cap.legacyConsole) {
    mode = "minimal"
    reason = "auto:legacy"
  } else {
    mode = "fullscreen"
    reason = "auto:default"
  }

  // M36 has no inline/minimal engine — the caller renders the fallback.
  if (mode === "inline" || mode === "minimal") {
    return { mode, fallback: "fullscreen", reason: "pending-inline-engine (M37)" }
  }
  return { mode, fallback: "fullscreen", reason }
}
