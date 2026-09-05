// @i-harness/tui — M46b G1: the mouse-reporting slash command.
//
// `/toggle-mouse-reporting` — grok's opt-in surface (m46a occupied the slot as
// a HIDDEN skip entry; this impl REPLACES it). Semantics per the delta:
//   - INERT when the feature is off (`[ui] mouse_reporting_toggle` / the
//     GROK_MOUSE_REPORTING_TOGGLE env force): the command stays hidden AND
//     cannot execute (visible-gate is a hard gate in the registry);
//   - when on: flips `app.mouse.enabled` — the app's whole mouse path (capture
//     gate → hover machinery + scroll stream). OFF hands mouse back to the
//     terminal for native click-drag (grok's doc phrase); ON restores in-app
//     hover/scroll. The scroll-stream reset rides the engine.reset on the
//     state (the command cannot reach the loop's normalizer — visible-side
//     users reuse the Ctrl+R binding for the identical toggle).

import type { SlashCommand, SlashContext } from "../types.ts"

export function toggleMouseReportingCommand(): SlashCommand {
  return {
    name: "toggle-mouse-reporting",
    description: "Toggle terminal mouse capture (native copy/paste vs in-app hover/scroll)",
    visible: (ctx: SlashContext) => ctx.mouseReportingToggle === true,
    run: (ctx: SlashContext) => {
      const mouse = ctx.app.mouse
      if (mouse === undefined) {
        ctx.toast("mouse capture: no mouse path")
        return
      }
      mouse.enabled = !mouse.enabled
      mouse.engine.clear()
      mouse.hovered = new Set()
      ctx.toast(mouse.enabled ? "Mouse reporting on" : "Mouse reporting off")
    },
  }
}

/** The M46b G1 mouse commands (the registry spread slot). */
export function mouseCommands(): SlashCommand[] {
  return [toggleMouseReportingCommand()]
}
