// M49 Task 7: the terminal cursor state machine — Show/MoveTo/Hide byte
// vocabulary, emitted ONLY on state change (zero-byte idle: an unchanged
// target returns "").
//
//   first Show+MoveTo  → `\x1b[?25h\x1b[{y+1};{x+1}H`   (1-based row/col)
//   unchanged target   → ""
//   move (visible)     → `\x1b[{y+1};{x+1}H`
//   hide               → `\x1b[?25l`
//
// `physical` (the renderer passes the cell-diff end position after a flush
// that wrote bytes) keeps the machine honest about the REAL terminal cursor:
// the diff displaced it, and a visible target not at the physical position
// must be re-asserted — the "cell diff wrote over the cursor cell → reset"
// rule. When the frame diff is empty the physical cursor is exactly where the
// last transition put it, so standalone transitions are exact.

/** The desired cursor cell (0-based) + visibility for the current frame. */
export interface CursorTarget {
  x: number
  y: number
  visible: boolean
}

export interface CursorState {
  /** Compute the minimal transition bytes for `target`. `physical` — the
   * position the cell diff just left the REAL cursor at (pass ONLY when the
   * flush wrote cell bytes; undefined = the previous transition's end). */
  transition(target: CursorTarget, physical?: { x: number; y: number }): string
  /** Resize/everything-unknown: the physical cursor is undefined → the next
   * visible transition always re-emits the MoveTo. */
  invalidate(): void
}

export function createCursorState(): CursorState {
  // Physical cursor position. (-1,-1) = unknown (startup / invalidated).
  let px = -1
  let py = -1
  let visible = false
  return {
    transition(target, physical) {
      if (physical !== undefined) {
        px = physical.x
        py = physical.y
      }
      let out = ""
      if (target.visible && !visible) out += "\x1b[?25h"
      if (!target.visible && visible) out += "\x1b[?25l"
      if (target.visible && (px !== target.x || py !== target.y)) {
        out += `\x1b[${target.y + 1};${target.x + 1}H`
      }
      visible = target.visible
      if (target.visible && out.length > 0) {
        // A CUP (or the Show which may sit alone at the same cell) moved the
        // physical cursor to the target — the next flatten of the frame
        // re-asserts from here. A Show-without-CUP leaves it unchanged.
        px = target.x
        py = target.y
      }
      return out
    },
    invalidate() {
      px = -1
      py = -1
    },
  }
}
