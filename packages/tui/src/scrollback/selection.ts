// @i-harness/tui — scrollback G1: selection state (display-line coordinates).
// Anchor+focus pairs; clamped to [0, lineCount-1] at set time. Direction is
// preserved (a/b kept as passed, no normalization).

export class SelectionState {
  private sel: { a: number; b: number } | undefined

  /** Clamp + store. Line count is the only geometry the engine knows. */
  set(a: number, b: number, lineCount: number): void {
    if (!Number.isFinite(a) || !Number.isFinite(b) || lineCount <= 0) return
    const hi = lineCount - 1
    const clamp = (v: number): number => Math.max(0, Math.min(hi, Math.trunc(v)))
    this.sel = { a: clamp(a), b: clamp(b) }
  }

  clear(): void {
    this.sel = undefined
  }

  get(): { a: number; b: number } | undefined {
    return this.sel
  }
}
