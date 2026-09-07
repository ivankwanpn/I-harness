// @i-harness/tui — G2 (M46a): navigation slash commands — /find /jump /history
// (/edit-prompt registered M49 Task 14 — the "Navigation/editor" group, spec
// §10.2: the REAL $EDITOR round-trip over the prompt draft).
// /jump builds the turn list from the ENGINE's turn anchors (one User block
// per turn — the lineBlock walk; ctx.jumpAnchors owns the engine walk and
// ctx.gotoLine jumps the viewport). /find activates the scrollback search
// (engine.search — the loop's search mode owns the pattern); an optional
// argument prefills the pattern. /history opens the existing prompt-history
// picker.

import type { SlashCommand } from "../types.ts"
import { jumpRows } from "../../../views/light-jump.ts"

export const navigationCommands: SlashCommand[] = [
  {
    name: "find",
    description: "Search the scrollback (type the pattern, Enter applies)",
    argumentHint: "[pattern]",
    run(ctx) {
      const pattern = ctx.arg.trim()
      ctx.startSearch(pattern === "" ? undefined : pattern)
    },
  },
  {
    name: "jump",
    description: "Jump to a turn (engine anchors; /jump <n> jumps directly)",
    argumentHint: "[n]",
    run(ctx) {
      const arg = ctx.arg.trim()
      const anchors = ctx.jumpAnchors()
      if (arg !== "") {
        if (!/^\d+$/.test(arg)) {
          ctx.toast(`jump: expected a turn number (1..${anchors.length}) or no arg`)
          return
        }
        const anchor = anchors[Number(arg) - 1]
        if (anchor === undefined) {
          ctx.toast(`jump: turn ${arg} out of range (1..${anchors.length})`)
          return
        }
        ctx.gotoLine(anchor.line)
        return
      }
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
  {
    // M49 Task 14 (spec §10.2 "Navigation/editor"): the $EDITOR round-trip —
    // a REAL local action (the loop's editorRoundTrip; the same seam minimal
    // Ctrl+G uses).
    name: "edit-prompt",
    description: "Edit the prompt draft in $EDITOR",
    run(ctx) {
      ctx.editPromptInEditor()
    },
  },
]
