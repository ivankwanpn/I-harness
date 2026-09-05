// @i-harness/tui — G2 (M46a): navigation slash commands — /find /jump /history.
// /jump builds the turn list from the ENGINE's turn anchors (one User block
// per turn — the lineBlock walk; ctx.jumpAnchors owns the engine walk and
// ctx.gotoLine jumps the viewport). /find activates the scrollback search
// (engine.search — the loop's search mode owns the pattern). /history opens
// the existing prompt-history picker.

import type { SlashCommand } from "../types.ts"
import { jumpRows } from "../../../views/light-jump.ts"

export const navigationCommands: SlashCommand[] = [
  {
    name: "find",
    description: "Search the scrollback (type the pattern, Enter applies)",
    run(ctx) {
      ctx.startSearch()
    },
  },
  {
    name: "jump",
    description: "Jump to a turn (engine anchors)",
    run(ctx) {
      const anchors = ctx.jumpAnchors()
      ctx.openPanel({
        kind: "jump",
        title: "Jump to turn",
        rows: jumpRows(anchors),
        cursor: Math.max(0, anchors.length - 1),
        onSelect: (i) => ctx.gotoLine(anchors[i]!.line),
      })
    },
  },
  {
    name: "history",
    description: "Open the prompt history panel",
    run(ctx) {
      ctx.openHistoryPanel()
    },
  },
]
