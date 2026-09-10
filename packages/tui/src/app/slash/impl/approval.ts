// @i-harness/tui — G2 (M46a): approval slash commands — /always-approve /auto.
// M49 Task 14 (spec §10.2 "Conditional editor/safety" + §10.2 note): these
// appear ONLY when a LIVE guardian/approval backend capability exists. The
// M49 TUI backend has no live guardian capability — the commands are
// registered with the "guardian" gate (NOT in the visible set; the M46a
// UI-state-only mutation is removed — no fake default flip, per
// "M49不得保留目前只改 UI state的假實作").

import type { SlashCommand } from "../types.ts"
import { hasCapability } from "../types.ts"

/** M59: the ONE stance flip — /always-approve and /auto both drive the
 * runtime seam (the same flip the third Shift+Tab stop performs). */
function applyStance(ctx: Parameters<SlashCommand["run"]>[0], on: boolean): void {
  if (ctx.setAlwaysApprove === undefined) {
    ctx.toast("always-approve: live guardian capability not wired")
    return
  }
  ctx.setAlwaysApprove(on)
  ctx.toast(`always-approve: ${on ? "on" : "off"}`)
}

export const approvalCommands: SlashCommand[] = [
  {
    name: "always-approve",
    description: "Always-approve (live guardian capability)",
    visible: (ctx) => hasCapability(ctx, "guardian"),
    run(ctx) {
      applyStance(ctx, true)
    },
  },
  {
    name: "auto",
    description: "Always-approve toggle (live guardian capability)",
    visible: (ctx) => hasCapability(ctx, "guardian"),
    run(ctx) {
      applyStance(ctx, true)
    },
  },
]
