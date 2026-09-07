// @i-harness/tui — G2 (M46a): the single-line input overlay binder for slash
// commands that prompt for text (/rename [title], /btw [question] — the arg
// form skips the overlay entirely). The loop's freeform capture owns the edit
// keys; the binder forwards accept/dismiss into the caller's handlers.

import type { AppAction } from "../../keys.ts"
import type { OverlaySeam } from "../../present.ts"
import { renderTextInput, textInputCaret } from "../../../views/text-input.ts"
import type { SlashCommand } from "../types.ts"
import { hasCapability } from "../types.ts"

export interface TextInputOptions {
  title: string
  initial?: string
  onSubmit(text: string): void
  onCancel(): void
}

/** OverlaySeam binder (kind "question" — the closed union's closest slot; the
 * runtime string routes Esc/Enter through overlayKeys — rewriteable per the
 * runtime-kind precedent of bindRewindOverlay). The freeform captures every
 * printable char/Backspace; Enter submits, Esc (or Ctrl-C) cancels. */
export function bindTextInput(opts: TextInputOptions): OverlaySeam {
  let text = opts.initial ?? ""
  const active = { value: true }
  const close = (submit: boolean): void => {
    if (!active.value) return
    active.value = false
    if (submit) opts.onSubmit(text)
    else opts.onCancel()
  }
  return {
    kind: "question",
    draw: (ctx, view, palette, glyphs) => {
      renderTextInput(ctx, { title: opts.title, text, cursor: text.length }, view, palette, glyphs)
    },
    // M49 Task 7: the input's caret cell (the view owns the geometry — the
    // same clusterWidth walk the draw uses).
    caret: (ctx) => textInputCaret(ctx, { title: opts.title, text, cursor: text.length }),
    act: (action: AppAction): void => {
      switch (action) {
        case "overlay-select": close(true); break
        case "overlay-dismiss": close(false); break
        default: break
      }
    },
    freeform: {
      active: () => active.value,
      append: (t) => { text += t },
      backspace: () => { text = text.slice(0, -1) },
      submit: () => close(true),
      abort: () => close(false),
    },
  }
}

// ------------------------------------------------------------------ vim-mode (spec §10.2 "Conditional editor/safety")

/** M49 Task 14 (spec §10.2): /vim-mode joins the visible set ONLY when a live
 * vim/editor-mode capability exists. The M49 TUI has none — registered behind
 * the "vim-mode" gate (never listed, never matched) with an honest run body;
 * no UI-state fake is kept in the visible set. */
export const editorSafetyCommands: SlashCommand[] = [
  {
    name: "vim-mode",
    description: "Vim-style editing mode (live editor capability)",
    visible: (ctx) => hasCapability(ctx, "vim-mode"),
    run(ctx) {
      ctx.toast("vim-mode: live editor capability not wired")
    },
  },
]
