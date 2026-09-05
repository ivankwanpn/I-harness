// @i-harness/tui — M46b G1: the HitArea registry + HoverEngine (spec §2 —
// the grok真源 HitArea mechanism).
//
// The engine is the pure-geometry half of the hover machinery:
//   - views register/report the rects they DRAW each frame via
//     `beginFrame()` + `addArea(rect, id, label?)` (or the `hit()` shorthand,
//     which also returns whether the area is currently hovered — the view uses
//     that boolean to flip its visual in the same call, no second lookup);
//   - `update(col,row)` settles which areas the pointer is over (in/out) and
//     returns whether the SET changed — the dirty flag. Hover repaints ONLY on
//     a changed set (no 30fps hover pump — spec §7 red line);
//   - G2's click router calls `hitAt(col,row)` against the CURRENT frame's
//     areas (topmost = the last registered — the most specific target wins);
//   - NO per-frame pump: the loop tracks the last Moved coordinate;
//     present() calls update() with it once per frame.
//
// Coordinate note: mouse events arrive in terminal coordinates (col/row 1-based
// from the wire); the app maps them to its view coordinates by subtracting
// 1 (buf cells are 0-based). Callers pass APP coordinates; the engine never
// subtracts — the loop owns that mapping (the same place the wheel used to be
// decoded, ahead of any rect math).

/** View-space rect (0-based, exclusive x+w / y+h). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** One registerable hit target: the rect + the semantic id + the settled hover
 * flag (`update()` stamps it). G2 reads the rects via `hitAt` / `hovered()`. */
export interface HitArea {
  rect: Rect
  id: string
  /** Semantic label (e.g. "cwd-copy", the hover swap key for the renderer). */
  label?: string
  hovered: boolean
}

function inRect(col: number, row: number, r: Rect): boolean {
  return r.w > 0 && r.h > 0 && col >= r.x && col < r.x + r.w && row >= r.y && row < r.y + r.h
}

function setEq(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

export class HoverEngine {
  /** Areas registered by the views in THIS frame (beginFrame resets). */
  private frameAreas: HitArea[] = []
  /** The settled hovered-ids set — the result of the last update(). */
  private settled = new Set<string>()

  /** Start a frame: clears the registration slot (views register after). */
  beginFrame(): void {
    this.frameAreas = []
  }

  /** Register a hit area for this frame (the rect the view just drew). */
  addArea(rect: Rect, id: string, label?: string): HitArea {
    const area: HitArea = { rect, id, label, hovered: this.settled.has(id) }
    this.frameAreas.push(area)
    return area
  }

  /** Register + return the settled-hovered flag in one call — the view's
   * hover-visual switch. The engine never repaints on its own; the caller
   * styles its row from the return value (bg blend / swap / underline). */
  hit(rect: Rect, id: string, label?: string): boolean {
    return this.addArea(rect, id, label).hovered
  }

  /** Settle in/out against the current frame's areas. Returns true when the
   * hovered-id set CHANGED (the dirty flag — repaint only then). */
  update(col: number, row: number): boolean {
    const next = new Set<string>()
    for (const a of this.frameAreas) {
      if (inRect(col, row, a.rect)) next.add(a.id)
    }
    const changed = !setEq(next, this.settled)
    this.settled = next
    for (const a of this.frameAreas) a.hovered = this.settled.has(a.id)
    return changed
  }

  /** The settled hovered set (present copies it into `app.mouse.hovered`). */
  hoveredSet(): ReadonlySet<string> {
    return this.settled
  }

  /** The registered areas the pointer is over — the views' rects + semantics
   * (G2's panel-row hovers read the area for the clicked row). */
  hovered(): HitArea[] {
    return this.frameAreas.filter((a) => a.hovered)
  }

  /** G2's click router: the TOPMOST area containing (col,row) — the last
   * registered wins (most specific). Undefined = no hit (default routing). */
  hitAt(col: number, row: number): HitArea | undefined {
    for (let i = this.frameAreas.length - 1; i >= 0; i--) {
      const a = this.frameAreas[i]!
      if (inRect(col, row, a.rect)) return a
    }
    return undefined
  }

  /** Clear everything (mouse path disabled / toggled off). */
  clear(): void {
    this.frameAreas = []
    this.settled.clear()
  }
}
