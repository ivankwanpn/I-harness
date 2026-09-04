// @i-harness/tui — M39 G2: the FPS / scroll-debug HUD (spec §3.12 debugs:
// the 32-col `fps:...` panel; the 46-col 9-row scroll-debug HUD stays a
// later wheel). ZERO overhead by default: `TuiAppOptions.hud` allocates the
// meter; otherwise nothing exists and present() never draws the panel.
// The panel overlays the TOP-RIGHT 32-col band — drawn last in present (above
// everything). Band = text_secondary on the palette's bg_visual slot.
// Frame-interval sampling rides the loop's coalesced repaints (frame()), so
// the numbers measure the real render pump, not wall time.

import type { Palette, Renderer } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "../views/agent.ts"

/** Panel width (spec §3.12 — the FPS HUD is a 32-column panel). */
export const HUD_PANEL_W = 32

/**
 * Rolling frame-interval sampler. The loop ticks it once per frame(); stats()
 * returns the mean fps plus nearest-rank p50/p95 of the last `window`
 * intervals (milliseconds). Pure state — the app allocates one ONLY when the
 * HUD option is on.
 */
export class FpsMeter {
  private readonly window: number
  private samples: number[] = []
  private last = -1

  constructor(window = 120) {
    this.window = Math.max(8, window | 0)
  }

  /** Reset the window (the next tick only establishes the baseline). */
  start(): void {
    this.samples = []
    this.last = -1
  }

  /**
   * Record one frame at `now` (ms). Intervals longer than 2s are dropped —
   * a paused/stopped pump is not a frame-rate signal, and a single 60s gap
   * must not poison the p95 for a minute afterwards.
   */
  tick(now: number): void {
    if (this.last >= 0) {
      const dt = now - this.last
      if (dt >= 0 && dt <= 2000) {
        this.samples.push(dt)
        if (this.samples.length > this.window) {
          this.samples.splice(0, this.samples.length - this.window)
        }
      }
    }
    this.last = now
  }

  /** fps (rounded, mean of the window) + nearest-rank p50/p95 in ms. */
  stats(): { fps: number; p50: number; p95: number } {
    const s = this.samples
    if (s.length === 0) return { fps: 0, p50: 0, p95: 0 }
    const sorted = [...s].sort((a, b) => a - b)
    const rank = (q: number): number =>
      sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
    return {
      fps: Math.round(1000 / mean),
      p50: Math.round(rank(0.5)),
      p95: Math.round(rank(0.95)),
    }
  }
}

/** Per-frame HUD snapshot — what present() renders. */
export interface HudState {
  meter: FpsMeter
  /** Visible display lines (post-retain — the honest, marker-inclusive count). */
  lineCount: number
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  }
}

/**
 * Draw the top-right debug panel into the CELL buffer (the ViewDraw helpers —
 * views never import tui-core internals; hud.ts follows the same rule).
 * Row 0: `fps:{n} p50:{n}ms p95:{n}ms`; row 1: `scroll: {lineCount} lines`
 * (skipped while the scrollback is empty). The band fills the whole rect
 * width, text_secondary on bg_visual; last-drawn = above everything.
 */
export function renderHud(
  buf: Renderer["buffer"],
  hud: HudState,
  rect: Rect,
  draw: ViewDraw,
  palette: Palette,
): void {
  const { fps, p50, p95 } = hud.meter.stats()
  const rows =
    hud.lineCount > 0
      ? [`fps:${fps} p50:${p50}ms p95:${p95}ms`, `scroll: ${hud.lineCount} lines`]
      : [`fps:${fps} p50:${p50}ms p95:${p95}ms`]
  const fg = draw.color(palette.textSecondary)
  // ViewDraw.color only renders fg; the band's bg is painted as raw truecolor
  // (the debug panel is off by default — quantization is a later polish).
  const style: Style = { fg: fg.fg, bg: hexToRgb(palette.bgVisual) }
  const w = Math.min(rect.w, buf.width)
  const x = Math.max(0, rect.x)
  for (let r = 0; r < rows.length && rect.y + r < buf.height; r++) {
    draw.text(x, rect.y + r, rows[r].padEnd(w, " "), style, x + w)
  }
}
