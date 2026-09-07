// @i-harness/tui — G2 (M46a): run/rewind slash commands — /rewind /compact
// /plan /view-plan /queue /tasks /btw.
// M49 Task 14 (spec §10.2):
//  - /rewind /compact are "Conditional session" — cap-gated live capabilities
//    (backend.rewind / backend.compact); absent ⇒ hidden (never a toast-fake
//    in the visible set).
//  - /plan /view-plan are "plan-mode" gated — the M49 TUI backend has NO live
//    switching/guardian capability, so they are NOT visible and their run
//    states the requirement (the M46a UI-state-only implementation is out of
//    the visible set, per spec §10.2: "M49不得保留目前只改 UI state的假實作").
//  - /queue //tasks toggle the REAL panes (honest empty/unavailable states).

import type { SlashCommand } from "../types.ts"
import { hasCapability } from "../types.ts"

export const runCommands: SlashCommand[] = [
  {
    name: "rewind",
    description: "Rewind the session (open the rewind picker)",
    visible: (ctx) => hasCapability(ctx, "rewind"),
    run(ctx) {
      ctx.openRewind()
    },
  },
  {
    name: "compact",
    description: "Compact the conversation now (shadow + summary)",
    argumentHint: "[instructions]",
    visible: (ctx) => hasCapability(ctx, "compact"),
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
    // Spec §10.2: /plan appears only with a live backend switching/guardian
    // capability. The M49 TUI backend does not have one — the command stays
    // hidden and the run states the requirement (never the M46a UI-state fake).
    name: "plan",
    description: "Plan mode (live backend switching capability)",
    visible: (ctx) => hasCapability(ctx, "plan-mode"),
    run(ctx) {
      ctx.toast("plan: live backend switching capability not wired")
    },
  },
  {
    name: "view-plan",
    description: "View the plan (live backend switching capability)",
    visible: (ctx) => hasCapability(ctx, "plan-mode"),
    run(ctx) {
      ctx.toast("plan: live backend switching capability not wired")
    },
  },
  {
    name: "queue",
    description: "Toggle the queue pane",
    run(ctx) {
      if (ctx.queue === undefined) {
        ctx.toast("queue: pane seam absent")
        return
      }
      ctx.queue()
    },
  },
  {
    name: "tasks",
    description: "Toggle the tasks pane",
    run(ctx) {
      if (ctx.tasks === undefined) {
        ctx.toast("tasks: pane seam absent")
        return
      }
      ctx.tasks()
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
