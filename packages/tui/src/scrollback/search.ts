// @i-harness/tui — scrollback G1: regex search over display-line coordinates.
// Single compiled RegExp; matches kept in display-line order. `update` reruns
// the full scan — the engine calls it only while a search is active (lazy
// recompute on append). Highlighting is the Presenter's job: match lines are
// exposed as numbers; col information is kept per line for G2 (matchCols).

export class SearchState {
  private re: RegExp | undefined
  private matchLines: number[] = []
  private colLines: number[] = []
  private sources: string[] = []

  /** Compile + scan; returns match count or -1 for a bad pattern. */
  set(pattern: string, lines: string[]): number {
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch {
      this.clear()
      return -1
    }
    this.re = re
    this.sources = lines
    this.rescan()
    return this.matchLines.length
  }

  /** Recompute matches against the latest sources (called on append). */
  update(lines: string[]): void {
    this.sources = lines
    if (this.re === undefined) return
    this.rescan()
  }

  clear(): void {
    this.re = undefined
    this.matchLines = []
    this.colLines = []
    this.sources = []
  }

  isActive(): boolean {
    return this.re !== undefined
  }

  private rescan(): void {
    const re = this.re
    if (re === undefined) {
      this.matchLines = []
      this.colLines = []
      return
    }
    const finds: number[] = []
    const colfinds: number[] = []
    for (let i = 0; i < this.sources.length; i++) {
      re.lastIndex = 0
      const m = re.exec(this.sources[i])
      if (m !== null && m.index >= 0) {
        finds.push(i)
        colfinds.push(m.index)
      }
    }
    this.matchLines = finds
    this.colLines = colfinds
  }

  matches(): number[] {
    return this.matchLines
  }

  colOf(line: number): number | undefined {
    const i = this.matchLines.indexOf(line)
    return i >= 0 ? this.colLines[i] : undefined
  }

  /** Next match strictly after `from`, wrapping to the first (no match → -1). */
  next(from: number): number {
    if (this.matchLines.length === 0) return -1
    for (const m of this.matchLines) {
      if (m > from) return m
    }
    return this.matchLines[0]
  }

  /** Previous match strictly before `from`, wrapping to the last (no match → -1). */
  prev(from: number): number {
    if (this.matchLines.length === 0) return -1
    for (let i = this.matchLines.length - 1; i >= 0; i--) {
      if (this.matchLines[i] < from) return this.matchLines[i]
    }
    return this.matchLines[this.matchLines.length - 1]
  }
}
