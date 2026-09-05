// @i-harness/tui — G2 (M46a): approval slash commands — /always-approve /auto.
// Backend truth: the approval DEFAULTS are per-session assembly options
// (createSessionService approveAll — baked at assembly time; the web-host
// permission/guardian chain is the runtime ask/deny surface). The honest v1
// sets the app-level approval state (drives the mode label/toasts + the
// settings-modal Approval class lands G1-side) — NEVER a silent ok: the toast
// says exactly what changed. The wire-down approval policy seam arrives with
// the settings modal wiring (M46a G1 / spec §1).

import type { SlashCommand } from "../types.ts"

export const approvalCommands: SlashCommand[] = [
  {
    name: "always-approve",
    description: "Toggle always-approve (approval policy default)",
    run(ctx) {
      const next = !(ctx.app.autoApprove ?? false)
      ctx.setAutoApprove(next)
      ctx.toast(next ? "always-approve ON (asks suppressed; wire seam M46b)" : "always-approve off (asks enabled)")
    },
  },
  {
    name: "auto",
    aliases: ["always-approve"],
    description: "Toggle always-approve (alias of /always-approve)",
    run(ctx) {
      const next = !(ctx.app.autoApprove ?? false)
      ctx.setAutoApprove(next)
      ctx.toast(next ? "always-approve ON" : "always-approve off")
    },
  },
]
