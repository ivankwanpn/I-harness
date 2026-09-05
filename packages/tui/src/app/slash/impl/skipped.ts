// @i-harness/tui — G2 (M46a): the SKIP list (registered HIDDEN — visible
// false — so the registry inventory is complete + testable; spec §2: these
// are documented as skipped instead of omitted). Grok's builtin surface vs
// our backend-supported map. Each entry carries the honest reason:
//  - account surfaces (share/login/logout/feedback/recall): no grok-account
//    equivalent in i-harness (login-gate menu honest omission per spec).
//  - /import-claude /remember: no Claude import / memory-store surface.
//  - /loop: the CLI `loop` feature is app-level; the TUI keeps its prompt.
//  - /voice /imagine*: no audio/image pipeline.
//  - /gboom /cd /fork: no dashboard identity / no session cwd change / no
//    fork surface (attachments M46b+).
//  - /edit-prompt /expand /toggle-mouse-reporting /timeline /debug /
//    /scroll-debug: M46b (mouse-reporting has a KEYBIND slot, see keys.ts).
//  - /dashboard /context /settings: M46a G1 owns the settings modal +
//    dashboard surfaces (registered here to stay grep-able).

import type { SlashCommand } from "../types.ts"

function hidden(name: string, reason: string): SlashCommand {
  return {
    name,
    description: reason,
    visible: () => false,
    run: () => {
      // Hidden commands never run (visible gate blocks match/listing too).
    },
  }
}

export const skippedCommands: SlashCommand[] = [
  hidden("share", "no account surface in the TUI (skip-list)"),
  hidden("login", "no grok-account login gate (skip-list)"),
  hidden("logout", "no grok-account login gate (skip-list)"),
  hidden("import-claude", "no Claude import surface (skip-list)"),
  hidden("remember", "no memory-store surface (skip-list)"),
  hidden("recap", "no recap/recall surface (skip-list)"),
  hidden("loop", "the CLI 'loop' feature (app-level, not the TUI prompt)"),
  hidden("voice", "no audio pipeline (skip-list)"),
  hidden("imagine", "no image pipeline (skip-list)"),
  hidden("imagine-video", "no video pipeline (skip-list)"),
  hidden("gboom", "no dashboard/video surface (skip-list)"),
  hidden("cd", "no session cwd change surface (skip-list)"),
  hidden("fork", "no fork surface (skip-list)"),
  hidden("dashboard", "dashboard is the welcome/agent screen (spec §1)"),
  hidden("context", "context surface rides the settings modal (M46a G1 — the visible /settings command owns the name)"),
  hidden("edit-prompt", "$EDITOR prompt editing lands M46b (minimal Ctrl+G slot exists)"),
  hidden("expand", "expand/minimal full-view lands M46b"),
  hidden("toggle-mouse-reporting", "mouse reporting opt-in lands M46b (Ctrl+R slot)"),
  hidden("timeline", "timeline view lands M46b (rewind anchor data rides the M42 store)"),
  hidden("debug", "debug HUD is F3-free (the HUD flag; scroll-debug M46b)"),
  hidden("scroll-debug", "scroll debug lands M46b (debug HUD flag exists)"),
]
