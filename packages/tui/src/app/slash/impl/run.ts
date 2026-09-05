// @i-harness/tui — G2 (M46a): run/rewind slash commands — /rewind /compact
// /plan /view-plan /queue /tasks /btw.
// Backend truth: /rewind rides the BackendClient.rewind bridge (M43 — absent
// on hosts without a rewind store ⇒ honest toast, never a silent no-op);
// /compact rides BackendClient.compact (session-executor assembly.compactNow —
// the M33 session-compact seam; the CLI's registerCommand surface is
// assembly-backed and the TUI bridge is the same call). /plan + /view-plan
// show the LAST ASSISTANT BLOCK in the light-panel viewer (the plan text).

import type { SlashCommand } from "../types.ts"

export const runCommands: SlashCommand[] = [
  {
    name: "rewind",
    description: "Rewind the session (open the rewind picker)",
    run(ctx) {
      ctx.openRewind()
    },
  },
  {
    name: "compact",
    description: "Compact the conversation now (shadow + summary)",
    argumentHint: "[instructions]",
    run: async (ctx) => {
      if (ctx.backend.compact === undefined) {
        ctx.toast("compact: backend seam absent (session-compact not wired)")
        return
      }
      try {
        const r = await ctx.backend.compact(ctx.arg.trim() === "" ? undefined : ctx.arg.trim())
        ctx.toast(r.compacted ? "compacted" : "compacted: nothing to compact")
      } catch (error) {
        ctx.toast(`compact failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  },
  {
    name: "plan",
    description: "Plan mode on (review bar arms) + view the plan",
    run(ctx) {
      ctx.app.mode = "plan"
      ctx.app.status.plan = true
      ctx.app.prompt.plan = true
      ctx.openPanel({
        kind: "goal",
        title: "Plan",
        rows: ctx.planRows(),
      })
    },
  },
  {
    name: "view-plan",
    description: "View the plan (the last assistant block)",
    run(ctx) {
      ctx.openPanel({
        kind: "goal",
        title: "Plan",
        rows: ctx.planRows(),
      })
    },
  },
  {
    name: "queue",
    description: "Toggle the queue pane",
    run(ctx) {
      ctx.togglePane("queue")
    },
  },
  {
    name: "tasks",
    description: "Toggle the tasks pane",
    run(ctx) {
      ctx.togglePane("tasks")
    },
  },
  {
    name: "btw",
    description: "Interject a sidebar question",
    argumentHint: "[question]",
    run(ctx) {
      const question = ctx.arg.trim()
      if (question.length > 0) {
        ctx.toggleBtwWith(question)
        return
      }
      ctx.openBtwInput()
    },
  },
]
