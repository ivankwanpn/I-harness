// @i-harness/tui — G2 (M46a): new surfaces — /usage /tutorial /goal.
// /usage = the token meter (BackendClient.context — activeTokens projection
// + the context window; the get_context_remaining semantics — remaining +
// % — computed over the real numbers). /tutorial = static topic list overlay
// (terminal setup / keys / rewind / minimal — the content lives in
// views/light-tutorial.ts). /goal = the goal event label (the detail overlay
// rides the goal event stream — honest v1).

import type { SlashCommand } from "../types.ts"
import { usageRows, USAGE_EMPTY } from "../../../views/light-usage.ts"
import { goalRows } from "../../../views/light-goal.ts"
import { tutorialIndexRows, tutorialContentRows, TUTORIAL_TOPICS } from "../../../views/light-tutorial.ts"

export const surfaceCommands: SlashCommand[] = [
  {
    name: "usage",
    description: "Context usage for THIS session only (no account quota)",
    run: async (ctx) => {
      // M49 Task 14 (spec §10.2 "Local info"): LOCAL context/session usage
      // only — the panel self-labels ("this session"); account/subscription
      // quota is never shown (no such capability — explicit omission).
      const usage = await ctx.backend.context?.().catch(() => undefined)
      if (usage === undefined) {
        ctx.openPanel({ kind: "usage", title: "Usage · this session", rows: [{ label: USAGE_EMPTY.trim() }] })
        return
      }
      ctx.openPanel({ kind: "usage", title: "Usage · this session", rows: usageRows(usage) })
    },
  },
  {
    name: "tutorial",
    description: "Topic list (terminal setup / keys / rewind / minimal)",
    run: (ctx) => {
      openTutorialIndex(ctx)
    },
  },
  {
    name: "goal",
    description: "Current goal (from the goal event stream)",
    run: (ctx) => {
      ctx.openPanel({ kind: "goal", title: "Goal", rows: goalRows(ctx.app.status.goal) })
    },
  },
]

export function openTutorialIndex(ctx: Parameters<SlashCommand["run"]>[0]): void {
  ctx.openPanel({
    kind: "tutorial",
    title: "Tutorial",
    rows: tutorialIndexRows(),
    onSelect: (i) => {
      const topic = TUTORIAL_TOPICS[i]
      if (topic === undefined) return
      ctx.openPanel({
        kind: "tutorial",
        title: `Tutorial — ${topic.title}`,
        rows: tutorialContentRows(topic),
        onSelect: () => openTutorialIndex(ctx),
      })
    },
  })
}
