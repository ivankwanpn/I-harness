// @i-harness/tui — M46c G1 (NEW FILE — G2 conflict boundary): the /timeline
// toggle command for the turn timeline rail (spec §3.12 時間線軌). Real knob:
// app.showTimeline (host option default OFF) — the rail only actually draws
// while the GATE also holds (pane width >= 60 && turns >= 2, time
// layers/timeline.ts). The command bundle lives in its own file so the G2
// registry merge (paste + workflow commands) stays one import line apart.

import type { SlashCommand } from "../types.ts"

export const timelineCommands: SlashCommand[] = [
  {
    name: "timeline",
    description: "Toggle the turn timeline rail (right columns)",
    run(ctx) {
      const next = !(ctx.app.showTimeline ?? false)
      ctx.app.showTimeline = next
      ctx.toast(next ? "timeline on" : "timeline off")
    },
  },
]
