// M38a G2: minimal mode — the live-region content model (composeRegion), the
// print-once commit pipeline (MinimalCommits + commitDelta), the mode switch
// (relaunchArgs / parseModeArg / ModeSwitch), and a pseudo-integration of the
// TuiApp minimal path against a FAKE InlineLiveRegion + FAKE engine: events →
// engine.append → boundary commit (through the write sink) → setRegion +
// drawRegion. G1's real inline.ts is code-against-contract; tests never
// import it (returns undefined → fullscreen fallback is app-level behavior).

import { afterEach, describe, expect, it, vi } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, hexToRgb, quantizeColor, resolvePalette } from "@i-harness/tui-core"
import type { TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"
import type { InlineHost } from "../src/app/loop.ts"
import { composeRegion } from "../src/minimal/live-region.ts"
import type { LiveRegionState } from "../src/minimal/live-region.ts"
import { MinimalCommits, commitDelta } from "../src/minimal/commit.ts"
import { defaultRelaunchArgv, ModeSwitch, parseModeArg, relaunchArgs } from "../src/minimal/mode.ts"
import { createInlineLiveRegion, InlineLiveRegionImpl, sgrFromPalette } from "../src/minimal/inline.ts"
import { dispatchKey } from "../src/app/keys.ts"
import type { Kbd, KeymapState } from "../src/app/keys.ts"
import type { BackendClient, DisplayLine, ScrollbackEngine, SessionSummary, TuiEvent } from "../src/contracts.ts"
import type { RegionLine } from "../src/minimal/contracts.ts"
import { unsupportedSessionManagement } from "./backend-stub.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

// ------------------------------------------------------------------ fixtures

const line = (text: string): RegionLine => ({ runs: [{ text, style: "text" }] })

const base = (partial: Partial<LiveRegionState> = {}): LiveRegionState => ({
  tail: [],
  todos: [],
  status: line("status"),
  prompt: line("prompt"),
  info: line("info"),
  ...partial,
})

const userEv = (seq: number): TuiEvent => ({ type: "user", text: "hi", seq, ts: 0 })
const assistantEv = (seq: number, text = "chunk"): TuiEvent => ({ type: "assistant", text, seq, ts: 0 })
const turnEndEv = (seq: number): TuiEvent => ({ type: "turn", phase: "end", seq, ts: 0 })

/** ScrollbackEngine slice used by the commit pipeline (the real engine's
 * shape: append grows rows, viewport is a plain window). */
class FakeEngine {
  rows: DisplayLine[] = []

  appendLine(text: string, glyph?: string): void {
    this.rows.push({
      runs: [{ text, style: "text" }],
      blockIndex: this.rows.length,
      ...(glyph !== undefined ? { glyph } : {}),
    })
  }

  lineCount(): number {
    return this.rows.length
  }

  viewport(offset: number, height: number): DisplayLine[] {
    return this.rows.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, height))
  }
}

/** Full ScrollbackEngine the TuiApp requires. */
class FakeScrollback extends FakeEngine implements ScrollbackEngine {
  resetCalls = 0
  append(ev: TuiEvent): void {
    if (ev.type === "user") this.appendLine(ev.text)
    else if (ev.type === "assistant") this.appendLine(ev.text)
    else if (ev.type === "system") this.appendLine(ev.text)
  }
  lineBlock(): { title: string; runs: DisplayLine["runs"] } | undefined { return undefined }
  toggleFoldAt(): void {}
  toggleExpandAll(): void {}
  setSelection(): void {}
  selection(): { a: number; b: number } | undefined { return undefined }
  search(): number { return -1 }
  clearSearch(): void {}
  matches(): number[] { return [] }
  nextMatch(): number { return 0 }
  prevMatch(): number { return 0 }
  setWidth(): void {}
  reset(): void { this.resetCalls++; this.rows = [] }
}

/** Recording InlineHost — captures commits/region rows/draws; writes through
 * the app sink (ledger). */
class FakeInline implements InlineHost {
  commits: RegionLine[][] = []
  lastRegion: RegionLine[] = []
  draws = 0
  private commitN = 0

  commit(lines: RegionLine[], write: (s: string) => void): void {
    this.commitN++
    this.commits.push(lines)
    write(`[commit ${this.commitN}]\n`)
  }

  drawRegion(write: (s: string) => void): void {
    this.draws++
    write("[region]\n")
  }

  regionRows(): number { return 8 }
  resize(): void {}
  setRegion(lines: RegionLine[]): void { this.lastRegion = lines }
}

/** Pushable TuiEvent stream for the loop's backend pump. (M49 Task 11: the
 * events buffer is named `pendingEvents` — `queue` is now the BackendClient
 * queue-projection member.) */
class QueueBackend implements BackendClient {
  private pendingEvents: TuiEvent[] = []
  private wake: (() => void) | undefined
  private ended = false
  closed = false

  push(...evs: TuiEvent[]): void {
    this.pendingEvents.push(...evs)
    this.wake?.()
  }

  async *events(): AsyncIterable<TuiEvent> {
    for (;;) {
      while (this.pendingEvents.length > 0) yield this.pendingEvents.shift()!
      if (this.ended) return
      await new Promise<void>((r) => { this.wake = r })
    }
  }

  listSessions(): Promise<SessionSummary[]> { return Promise.resolve([]) }
  open(): Promise<void> { return Promise.resolve() }
  createSession(): Promise<string> { return unsupportedSessionManagement.createSession!() }
  forkSession(): Promise<string> { return unsupportedSessionManagement.forkSession!() }
  modelState(): ReturnType<BackendClient["modelState"]> {
    return unsupportedSessionManagement.modelState()
  }
  setSessionModel(
    selection: Parameters<NonNullable<BackendClient["setSessionModel"]>>[0],
  ): ReturnType<NonNullable<BackendClient["setSessionModel"]>> {
    return unsupportedSessionManagement.setSessionModel!(selection)
  }
  submit(): Promise<void> { return Promise.resolve() }
  steer(): Promise<void> { return Promise.resolve() }
  cancel(): Promise<void> { return Promise.resolve() }
  seqCursor(): number { return -1 }
  replay(): Promise<TuiEvent[]> { return Promise.resolve([]) }
  status(): { running: boolean; queued: number } { return { running: false, queued: 0 } }
  close(): Promise<void> {
    this.closed = true
    this.ended = true
    this.wake?.()
    return Promise.resolve()
  }
}

const kbd = (partial: Partial<Kbd> & { code: string }): Kbd => ({
  key: "",
  ctrl: false,
  alt: false,
  shift: false,
  ...partial,
})

const minimalKeyState = (partial: Partial<KeymapState> = {}): KeymapState => ({
  focused: "prompt",
  promptText: "",
  multiLine: false,
  turnRunning: false,
  armedQuit: false,
  searchActive: false,
  minimal: true,
  ...partial,
})

// ------------------------------------------------------------------ 1. composeRegion

describe("composeRegion — region content model (spec §1.1)", () => {
  it("orders tail · todos · status · prompt; info row only when showInfo", () => {
    const r = composeRegion(
      base({ tail: [line("t1"), line("t2")], todos: [line("todo")] }),
      10,
    )
    expect(r).toEqual([line("t1"), line("t2"), line("todo"), line("status"), line("prompt")])
    expect(r).not.toContain(line("info"))

    const r2 = composeRegion(base({ tail: [line("t1")] }), 10, { showInfo: true })
    expect(r2).toEqual([line("t1"), line("status"), line("prompt"), line("info")])
  })

  it("truncates the tail to fit — keeps the LAST lines; status+prompt always visible", () => {
    const tail = [line("a"), line("b"), line("c"), line("d"), line("e")]
    const r = composeRegion(base({ tail }), 4)
    expect(r).toEqual([line("d"), line("e"), line("status"), line("prompt")])
  })

  it("todo rows squeeze the tail (both keep their LAST lines; total ≤ maxRows)", () => {
    const r = composeRegion(
      base({ tail: [line("a"), line("b"), line("c"), line("d")], todos: [line("t1"), line("t2")] }),
      5,
    )
    expect(r).toEqual([line("d"), line("t1"), line("t2"), line("status"), line("prompt")])
    // tighter: the early todo is dropped, the tail collapses to nothing.
    const r2 = composeRegion(
      base({ tail: [line("a"), line("b"), line("c"), line("d")], todos: [line("t1"), line("t2")] }),
      4,
    )
    expect(r2).toEqual([line("t1"), line("t2"), line("status"), line("prompt")])
  })

  it("idle minimum 2 rows; tiny regions keep the prompt (bottom row wins); <=0 = none", () => {
    expect(composeRegion(base(), 2)).toEqual([line("status"), line("prompt")])
    expect(composeRegion(base({ tail: [line("t")] }), 1)).toEqual([line("prompt")])
    expect(composeRegion(base(), 0)).toEqual([])
  })
})

// ------------------------------------------------------------------ 2. MinimalCommits

describe("MinimalCommits — print-once delta cursor", () => {
  it("commits every engine row exactly once; pendingDelta empty after the delta", () => {
    const eng = new FakeEngine()
    const c = new MinimalCommits(eng)
    eng.appendLine("u1", "◆")
    expect(c.onEvent(userEv(1))).toBe(true)
    const d1 = c.pendingDelta()
    expect(d1).toHaveLength(1)
    expect(d1[0].runs[0].text).toBe("u1")
    expect(d1[0].glyph).toBe("◆") // DisplayLine glyph passthrough
    eng.appendLine("a1")
    eng.appendLine("a2")
    expect(c.onEvent(assistantEv(2))).toBe(false)
    const d2 = c.pendingDelta() // the app-level commit (idle/boundary)
    expect(d2.map((l) => l.runs[0].text)).toEqual(["a1", "a2"])
    expect(c.pendingDelta()).toEqual([]) // nothing left to commit
    eng.appendLine("t1")
    expect(c.onEvent(turnEndEv(3))).toBe(true)
    expect(c.pendingDelta()).toHaveLength(1)
    expect(c.pendingDelta()).toEqual([]) // after the 3rd commit — empty
  })

  it("trigger table: turn/end + compaction + user/system true; streaming rows false", () => {
    const c = new MinimalCommits(new FakeEngine())
    expect(c.onEvent({ type: "turn", phase: "start", seq: 1, ts: 0 })).toBe(false)
    expect(c.onEvent({ type: "turn", phase: "end", seq: 2, ts: 0 })).toBe(true)
    expect(c.onEvent({ type: "compaction", phase: "start", seq: 3, ts: 0 })).toBe(true)
    expect(c.onEvent({ type: "compaction", phase: "end", seq: 4, ts: 0 })).toBe(true)
    expect(c.onEvent(userEv(5))).toBe(true)
    expect(c.onEvent({ type: "user/edit", text: "e", seq: 6, ts: 0 })).toBe(true)
    expect(c.onEvent(assistantEv(7))).toBe(false)
    expect(c.onEvent({ type: "thinking", text: "t", seq: 8, ts: 0 })).toBe(false)
    expect(c.onEvent({ type: "tool", callId: "c", name: "bash", kind: "execute", status: "running", seq: 9, ts: 0 })).toBe(false)
    expect(c.onEvent({ type: "todo", items: [], seq: 10, ts: 0 })).toBe(false)
    expect(c.onEvent({ type: "system", text: "s", seq: 11, ts: 0 })).toBe(true)
  })

  it("500ms tail-flush: an uncommitted stream commits on idle (fake timers)", () => {
    vi.useFakeTimers()
    const eng = new FakeEngine()
    const c = new MinimalCommits(eng) // real now() — mocked by vitest
    eng.appendLine("chunk1")
    expect(c.onEvent(assistantEv(1, "chunk1"))).toBe(false)
    eng.appendLine("chunk2")
    expect(c.onEvent(assistantEv(2, "chunk2"))).toBe(false)
    expect(c.idleFlushDue(Date.now())).toBe(false) // 0ms old
    vi.advanceTimersByTime(499)
    expect(c.idleFlushDue(Date.now())).toBe(false)
    vi.advanceTimersByTime(1)
    expect(c.idleFlushDue(Date.now())).toBe(true) // 500ms threshold reached
    expect(c.pendingDelta()).toHaveLength(2)
    expect(c.idleFlushDue(Date.now())).toBe(false) // nothing pending anymore
  })

  it("displayToRegion passthrough drops scrollback-only metadata; commitDelta wires the sink", () => {
    const eng = new FakeEngine()
    eng.appendLine("u1")
    const c = new MinimalCommits(eng)
    expect(c.onEvent(userEv(1))).toBe(true)
    const written: string[] = []
    commitDelta({ commit: (lines, write) => write(`Δ${lines.length}`) }, c.pendingDelta(), (s) => written.push(s))
    expect(written).toEqual(["Δ1"])
    commitDelta({ commit: (lines, write) => write(`Δ${lines.length}`) }, [], (s) => written.push(s))
    expect(written).toEqual(["Δ1"]) // empty delta is a no-op (print-once)
  })
})

// ------------------------------------------------------------------ 2b. M51 T1 shrink re-anchor

describe("M51 T1 — commit cursor re-anchors after an engine shrink", () => {
  const rowsOf = (delta: RegionLine[]): string[] =>
    delta.map((l) => l.runs.map((r) => r.text).join(""))

  /** 7 finished assistant blocks × 300 rows = 2100 rows over 14 blocks (≤16,
   * so the Fenwick never grows — this pins the cursor defect alone). */
  const fill2100 = (engine: ReturnType<typeof createScrollbackEngine>, seq: { n: number }): void => {
    for (let b = 0; b < 7; b++) {
      const text = Array.from({ length: 300 }, (_, i) => `S${b}-${i}`).join("\n")
      engine.append({ type: "assistant", text, seq: seq.n++, ts: 0 })
      engine.append({ type: "turn", phase: "end", seq: seq.n++, ts: 0 })
    }
  }

  it("retain(): the first row after the shrink commits — never a mid-block resume", () => {
    const engine = createScrollbackEngine({ width: 80 })
    const commits = new MinimalCommits(engine, { now: () => 0 })
    const seq = { n: 0 }
    fill2100(engine, seq)
    expect(engine.lineCount()).toBe(2100)
    expect(commits.pendingDelta()).toHaveLength(2100) // fully committed

    expect(engine.retain!({ maxLines: 1500 }).trimmedBlocks).toBeGreaterThan(0)
    expect(engine.lineCount()).toBe(1501) // kept tail + marker
    // The anim pump observes the shrink before new content arrives: re-anchor
    // the cursor, flush nothing (print-once).
    expect(commits.idleFlushDue(1000)).toBe(false)

    engine.append({ type: "user", text: "NEW-TURN", seq: seq.n++, ts: 0 })
    engine.append({
      type: "assistant",
      text: Array.from({ length: 610 }, (_, i) => `NEW-${i}`).join("\n"),
      seq: seq.n++, ts: 0,
    })
    const rows = rowsOf(commits.pendingDelta())
    // the new turn's FIRST row through its last — never a mid-block resume
    expect(rows).toEqual([
      "❯ NEW-TURN",
      ...Array.from({ length: 610 }, (_, i) => `NEW-${i}`),
    ])
    expect(rows).not.toContain("S6-0") // retained prefix is never re-emitted
    expect(commits.pendingDelta()).toEqual([]) // nothing left (print-once)
  })

  it("M52 L1: an uncommitted tail smaller than the trim is NOT stranded", () => {
    const engine = createScrollbackEngine({ width: 80 })
    const commits = new MinimalCommits(engine, { now: () => 0 })
    const seq = { n: 0 }
    fill2100(engine, seq)
    expect(engine.lineCount()).toBe(2100)
    expect(commits.pendingDelta()).toHaveLength(2100) // committed prefix

    // 300 rows stream in WITHOUT a boundary commit (an open assistant block).
    engine.append({
      type: "assistant",
      text: Array.from({ length: 300 }, (_, i) => `U${i}`).join("\n"),
      seq: seq.n++, ts: 0,
    })
    expect(engine.lineCount()).toBe(2400)

    // The resize auto-retain (TuiApp.maybeAutoRetain: >2000 → 1500) fires
    // while those 300 rows are still uncommitted: 2400 → 1501 (net −899).
    expect(engine.retain!({ maxLines: 1500 }).trimmedBlocks).toBeGreaterThan(0)
    expect(engine.lineCount()).toBe(1501)

    // retain trims the LEADING rows, so the cursor shifts down by the same
    // 899 (2100 → 1201) — the uncommitted tail keeps its identity and is the
    // only delta. Re-anchoring to the total instead would strand it forever.
    expect(rowsOf(commits.pendingDelta())).toEqual(Array.from({ length: 300 }, (_, i) => `U${i}`))
    expect(commits.pendingDelta()).toEqual([]) // nothing left (print-once)
  })

  it("M52 L1: a clamp that stops the trim short reports the NET shrink (no re-emitted rows)", () => {
    const engine = createScrollbackEngine({ width: 80 })
    const commits = new MinimalCommits(engine, { now: () => 0 })
    const seq = { n: 0 }
    fill2100(engine, seq) // 7 closed 300-row assistant blocks
    // A RUNNING tool block is mutable, so retain()'s horizon clamps back to it
    // even though the budget walk wanted to stop at the tail — the trim keeps
    // [tool, assistant, user, tail], and `kept` (the walk's count) no longer
    // describes what actually stays.
    engine.append({ type: "tool", callId: "t1", name: "bash", kind: "execute", status: "running", seq: seq.n++, ts: 0 })
    engine.append({
      type: "assistant",
      text: Array.from({ length: 100 }, (_, i) => `MID-${i}`).join("\n"),
      seq: seq.n++, ts: 0,
    })
    expect(engine.lineCount()).toBe(2201)
    expect(commits.pendingDelta()).toHaveLength(2201) // committed through MID-99

    engine.append({ type: "user", text: "GO", seq: seq.n++, ts: 0 })
    engine.append({
      type: "assistant",
      text: Array.from({ length: 1600 }, (_, i) => `BIG-${i}`).join("\n"),
      seq: seq.n++, ts: 0,
    })
    expect(engine.lineCount()).toBe(3802)
    expect(engine.retain!({ maxLines: 1500 }).trimmedBlocks).toBeGreaterThan(0)
    expect(engine.lineCount()).toBe(1703) // net −2099 (NOT the walk's −2201)

    // The committed prefix maps to display rows [0, 102): marker + the running
    // tool row + MID-0..MID-99. Cursor 2201 → 102; reporting the walk's `kept`
    // would over-state the shrink by 102, drop the cursor to the max(1, …)
    // floor and re-emit the tool + MID rows (print-once violation).
    const rows = rowsOf(commits.pendingDelta())
    expect(rows).toEqual(["❯ GO", ...Array.from({ length: 1600 }, (_, i) => `BIG-${i}`)])
    expect(rows.some((r) => r.includes("MID-"))).toBe(false)
    expect(commits.pendingDelta()).toEqual([]) // nothing left
  })

  it("M52 L1: a SECOND retain (previous marker) reports the true net shrink — first tail row not dropped", () => {
    // The marker row is part of the display total but NOT of sumBefore(): with
    // a previous retain (cur > 0) the net shrink is `suppressed` (the old
    // marker is absorbed), not `suppressed - 1`. This is the normal path —
    // maybeAutoRetain re-fires on every resize once the session is trimmed.
    const engine = createScrollbackEngine({ width: 80 })
    const commits = new MinimalCommits(engine, { now: () => 0 })
    const seq = { n: 0 }
    fill2100(engine, seq)
    expect(commits.pendingDelta()).toHaveLength(2100) // committed
    expect(engine.retain!({ maxLines: 1500 }).trimmedBlocks).toBe(3) // retain #1 (cur = 0)
    expect(engine.lineCount()).toBe(1501) // marker + blocks 3..13
    expect(commits.idleFlushDue(1000)).toBe(false) // cursor = 1501 (fully committed)

    // Grow past the budget again: 7 more closed 300-row blocks → 3601.
    for (let b = 7; b < 14; b++) {
      const text = Array.from({ length: 300 }, (_, i) => `S${b}-${i}`).join("\n")
      engine.append({ type: "assistant", text, seq: seq.n++, ts: 0 })
      engine.append({ type: "turn", phase: "end", seq: seq.n++, ts: 0 })
    }
    expect(engine.lineCount()).toBe(3601)
    expect(commits.pendingDelta()).toHaveLength(2100) // committed → cursor 3601

    // The uncommitted tail: an OPEN assistant block (200 rows).
    engine.append({
      type: "assistant",
      text: Array.from({ length: 200 }, (_, i) => `T1-${i}`).join("\n"),
      seq: seq.n++, ts: 0,
    })
    expect(engine.lineCount()).toBe(3801)

    // retain #2 (cur = 3): blocks 3..18 (2400 rows) collapse into the marker —
    // 3801 → 1401, an ACTUAL shrink of 2400 == suppressed (the previous marker
    // is absorbed, so it is NOT `suppressed - 1`).
    expect(engine.retain!({ maxLines: 1500 }).trimmedBlocks).toBe(16)
    expect(engine.lineCount()).toBe(1401)

    // Cursor 3601 → 1201 (marker + blocks 19..27). Reporting `suppressed - 1`
    // would start at 1202 and silently DROP the first uncommitted row.
    const rows = rowsOf(commits.pendingDelta())
    expect(rows[0]).toBe("T1-0")
    expect(rows).toEqual(Array.from({ length: 200 }, (_, i) => `T1-${i}`))
    expect(commits.pendingDelta()).toEqual([]) // nothing left
  })

  it("rewind: the cursor re-anchors and the new turn commits from its first row", () => {
    const engine = createScrollbackEngine({ width: 80 })
    const commits = new MinimalCommits(engine, { now: () => 0 })
    let seq = 0
    for (let i = 0; i < 10; i++) {
      engine.append({ type: "user", text: `u${i}-0\nu${i}-1\nu${i}-2`, seq: seq++, ts: 0 })
    }
    expect(engine.lineCount()).toBe(30)
    expect(commits.pendingDelta()).toHaveLength(30)

    engine.append({ type: "rewind", targetTurn: 3, anchorSeq: 5, mode: "all", seq: seq++, ts: 0 })
    expect(engine.lineCount()).toBe(16) // 5 kept blocks × 3 rows + the marker
    expect(commits.idleFlushDue(1000)).toBe(false) // shrink → re-anchor, no flush

    engine.append({ type: "user", text: "R-NEW", seq: seq++, ts: 0 })
    engine.append({ type: "assistant", text: "R0\nR1\nR2\nR3\nR4", seq: seq++, ts: 0 })
    expect(rowsOf(commits.pendingDelta())).toEqual([
      "❯ R-NEW", "R0", "R1", "R2", "R3", "R4",
    ])
    expect(commits.pendingDelta()).toEqual([])
  })
})

// --------------------------------------------------- 2c. M54 A1 sticky-pin commit

describe("M54 A1 — the sticky latest-user pin is never committed", () => {
  const rowsOf = (delta: RegionLine[]): string[] =>
    delta.map((l) => l.runs.map((r) => r.text).join(""))

  it("commits the real rows (system, assistant tail) — no duplicate user row, no stranded tail", () => {
    const engine = createScrollbackEngine({ width: 80 })
    const commits = new MinimalCommits(engine, { now: () => 0 })
    let seq = 0

    engine.append({ type: "user", text: "GO", seq: seq++, ts: 0 })
    expect(rowsOf(commits.pendingDelta())).toEqual(["❯ GO"])

    // Once the commit window starts past the user block, viewport() pins the
    // collapsed user header on top of the window (sticky:true). The raw window
    // would be a COPY of an already-committed row plus one fewer real row.
    engine.append({ type: "system", text: "ctx", seq: seq++, ts: 0 })
    expect(engine.viewport(1, 1).map((l) => l.sticky === true)).toEqual([true])
    expect(rowsOf(commits.pendingDelta())).toEqual(["ctx"]) // NOT ["❯ GO"]

    // Same with a taller window: the pin is stripped and the window widened so
    // the LAST row (A2) is still committed.
    engine.append({ type: "assistant", text: "A0\nA1\nA2", seq: seq++, ts: 0 })
    engine.append({ type: "turn", phase: "end", seq: seq++, ts: 0 })
    expect(engine.viewport(2, 3).map((l) => l.sticky === true)).toEqual([true, false, false])
    const rows = rowsOf(commits.pendingDelta())
    expect(rows).toEqual(["A0", "A1", "A2"])
    expect(rows).not.toContain("❯ GO") // no already-committed row re-emitted
    expect(commits.pendingDelta()).toEqual([]) // print-once: nothing left
  })

  it("keeps the pin when the window starts BEFORE the latest user block (no false strip)", () => {
    const engine = createScrollbackEngine({ width: 80 })
    const commits = new MinimalCommits(engine, { now: () => 0 })
    let seq = 0
    engine.append({ type: "user", text: "GO", seq: seq++, ts: 0 })
    engine.append({ type: "assistant", text: "A0\nA1", seq: seq++, ts: 0 })
    // The whole delta is still above the pin point: rows are committed verbatim,
    // including the user row itself (it is NOT sticky in this window).
    expect(engine.viewport(0, 3).map((l) => l.sticky === true)).toEqual([false, false, false])
    expect(rowsOf(commits.pendingDelta())).toEqual(["❯ GO", "A0", "A1"])
    expect(commits.pendingDelta()).toEqual([])
  })
})

// --------------------------------------------------- 2d. M55 readDelta guard

describe("M55 — readDelta widening: multi-row pin + defensive termination", () => {
  const rowsOf = (delta: RegionLine[]): string[] =>
    delta.map((l) => l.runs.map((r) => r.text).join(""))

  it("a MULTI-ROW sticky pin (wrapped user block) widens over several reads — the real row commits, nothing duplicates", () => {
    const engine = createScrollbackEngine({ width: 24 })
    const commits = new MinimalCommits(engine, { now: () => 0 })
    let seq = 0
    const long = "W".repeat(160)
    engine.append({ type: "user", text: long, seq: seq++, ts: 0 })
    const userRows = engine.lineCount()
    // The collapsed user header wraps over several display rows at this width,
    // so the pin is MULTI-ROW — the widening loop must run several rounds.
    expect(userRows).toBeGreaterThan(3)
    // The user block itself commits once, in full (all wrapped rows).
    expect(rowsOf(commits.pendingDelta())).toHaveLength(userRows)
    expect(commits.pendingDelta()).toEqual([])

    // The next row starts PAST the user block: viewport() pins the whole
    // multi-row collapsed header (all sticky) and the pin consumes the window.
    engine.append({ type: "system", text: "ctx", seq: seq++, ts: 0 })
    expect(engine.viewport(userRows, 1).map((l) => l.sticky === true)).toEqual([true])
    const delta = rowsOf(commits.pendingDelta())
    expect(delta).toEqual(["ctx"]) // widened read returns the real row, pin stripped
    expect(delta.join("\n")).not.toContain("W") // no already-committed pin row re-emitted
    expect(commits.pendingDelta()).toEqual([]) // print-once: nothing left
  })

  it("a contract-violating engine whose viewport never grows terminates (no hang)", () => {
    // A broken engine: viewport() ignores the requested height and always
    // returns the SAME sticky-pinned window — the widening loop would spin
    // forever. The read counter turns the pre-guard failure into a fast,
    // deterministic error instead of a vitest timeout.
    const rows: DisplayLine[] = [
      { runs: [{ text: "❯ GO", style: "text" }], blockIndex: 0, sticky: true },
      { runs: [{ text: "A0", style: "text" }], blockIndex: 1 },
    ]
    let reads = 0
    const engine = {
      viewport: (): DisplayLine[] => {
        reads += 1
        if (reads > 25) throw new Error("readDelta did not terminate (viewport read 25x)")
        return rows
      },
      lineCount: () => 2,
    }
    const commits = new MinimalCommits(engine)
    // Best effort: the real (non-sticky) rows read so far, never a hang.
    expect(rowsOf(commits.pendingDelta())).toEqual(["A0"])
    expect(reads).toBe(2) // the guard stops on the first non-growing read
  })
})

// ------------------------------------------------------------------ 3. mode switching

describe("relaunchArgs / parseModeArg — same-session relaunch (spec §1)", () => {
  it("round-trips minimal ↔ fullscreen and replaces the existing --mode", () => {
    const argv = ["--prompt", "hi", "--minimal", "--mode", "fullscreen", "--workspace", "w"]
    const args = relaunchArgs("minimal", argv)
    expect(args).toEqual(["--prompt", "hi", "--workspace", "w", "--mode", "minimal"])
    expect(parseModeArg(args)).toBe("minimal")
    const back = relaunchArgs("fullscreen", args)
    expect(back).toEqual(["--prompt", "hi", "--workspace", "w"])
    expect(parseModeArg(back)).toBe(undefined)
  })

  it("never mangles --model (exact --mode match only)", () => {
    const args = relaunchArgs("minimal", ["--model", "claude-sonnet-4", "--workspace", "w"])
    expect(args).toEqual(["--model", "claude-sonnet-4", "--workspace", "w", "--mode", "minimal"])
  })

  it("parseModeArg: --minimal flag and --mode=(value) forms", () => {
    expect(parseModeArg(["--minimal"])).toBe("minimal")
    expect(parseModeArg(["--fullscreen"])).toBe("fullscreen")
    expect(parseModeArg(["--mode", "minimal"])).toBe("minimal")
    expect(parseModeArg(["--mode=fullscreen"])).toBe("fullscreen")
    expect(parseModeArg([])).toBe(undefined)
  })
})

describe("defaultRelaunchArgv — absolute source loader; dist re-execs the bundle", () => {
  const realExecArgv = process.execArgv
  const realDist = process.env.I_HARNESS_DIST
  afterEach(() => {
    process.execArgv = realExecArgv
    if (realDist === undefined) delete process.env.I_HARNESS_DIST
    else process.env.I_HARNESS_DIST = realDist
  })

  // F6 (m55 follow-up, same defect class as F1): the bare `tsx` specifier is
  // resolved by node from the SPAWN cwd. The relaunch inherits the parent cwd
  // (a global-install launch runs in the user's project folder), so a bare
  // loader fails there. The argv assertion is the pin — a full relaunch spawns
  // a real TUI host and is not exercisable in a unit test (the harness case-015
  // / dist self-check cover the real spawn).
  it("reuses the parent's absolute --import loader when present (global ih shim)", () => {
    const loader = "file:///C:/global-install/node_modules/tsx/dist/loader.mjs"
    process.execArgv = ["--conditions", "node", "--import", loader, "--conditions", "development"]
    const argv = defaultRelaunchArgv(["--workspace", "w", "--mode", "minimal"])
    expect(argv.slice(0, 2)).toEqual(["--import", loader])
    expect(argv.slice(2)).toEqual([process.argv[1] ?? "index.ts", "--workspace", "w", "--mode", "minimal"])
  })

  it("resolves tsx to an ABSOLUTE file URL when the parent carries no loader (never bare tsx)", () => {
    process.execArgv = ["--conditions", "node", "--conditions", "development"]
    const argv = defaultRelaunchArgv(["--workspace", "w"])
    expect(argv[0]).toBe("--import")
    expect(argv[1]).toMatch(/^file:\/\/\/.*\/tsx\/dist\/loader\.mjs$/)
    expect(argv[1]).not.toBe("tsx")
  })

  it("DIST re-execs the bundle with NO loader (branch unchanged)", () => {
    process.env.I_HARNESS_DIST = "1"
    process.execArgv = ["--import", "file:///C:/global-install/node_modules/tsx/dist/loader.mjs"]
    const argv = defaultRelaunchArgv(["--workspace", "w"])
    expect(argv).toEqual([process.argv[1] ?? "index.ts", "--workspace", "w"])
  })
})

describe("ModeSwitch.onSlash", () => {
  it("recognizes /minimal and /fullscreen → spawns the self-relaunch; /model is NOT a mode", () => {
    const spawned: Array<{ args: string[]; mode: string }> = []
    const sw = new ModeSwitch({
      argv: ["--workspace", "w", "--minimal"],
      spawn: (args, mode) => spawned.push({ args, mode }),
    })
    expect(sw.onSlash("/minimal")).toBe(true)
    expect(sw.onSlash("/fullscreen")).toBe(true)
    expect(sw.onSlash("/model")).toBe(false)
    expect(sw.onSlash("/help")).toBe(false)
    expect(sw.onSlash("/minimal ")).toBe(true) // trimmed match
    expect(spawned).toEqual([
      { args: ["--workspace", "w", "--mode", "minimal"], mode: "minimal" },
      { args: ["--workspace", "w"], mode: "fullscreen" },
      { args: ["--workspace", "w", "--mode", "minimal"], mode: "minimal" },
    ])
  })

  it("persists the flipped screen mode through the optional hook (durable tui.prefs.screenMode)", () => {
    const persisted: string[] = []
    const sw = new ModeSwitch({ argv: [], spawn: () => {}, persist: (mode) => persisted.push(mode) })
    expect(sw.onSlash("/minimal")).toBe(true)
    expect(sw.onSlash("/fullscreen")).toBe(true)
    expect(sw.onSlash("/model")).toBe(false)
    expect(persisted).toEqual(["minimal", "fullscreen"])
  })
})

describe("minimal palette-derived ANSI (M49 Task 8 — no fixed color table)", () => {
  it("sgrFromPalette derives SGR from the ACTIVE palette slots (truecolor + ansi256 + ansi16)", () => {
    const tn = resolvePalette(cap, "tokyo-night")
    const tc = sgrFromPalette(tn, cap)
    expect(tc["accent-user"]).toBe(`\x1b[38;2;122;162;247m`) // tokyonight BLUE #7aa2f7
    expect(tc["accent-error"]).toBe(`\x1b[38;2;247;118;142m`) // RED #f7768e
    expect(tc["link"]).toContain("\x1b[38;2;122;162;247m") // link_fg + underline
    expect(tc["link"]).toContain("\x1b[4m")
    expect(tc["bold"]).toBe("\x1b[1m")
    expect(tc["muted"]).toBe("\x1b[2m")
    expect(tc["text"]).toBe("")
    // ansi256: values pass through the existing quantizer (nearest cube).
    const p256 = quantizeColor(hexToRgb(tn.accentUser), { ...cap, colorLevel: "ansi256" })
    const t256 = sgrFromPalette(tn, { ...cap, colorLevel: "ansi256" })
    expect(t256["accent-user"]).toBe(`\x1b[38;5;${(p256 as { idx: number }).idx}m`)
    // ansi16: bright-family pinning (9X on a dark terminal).
    const t16 = sgrFromPalette(tn, { ...cap, colorLevel: "ansi16" })
    expect(t16["accent-user"]).toMatch(/^\x1b\[9[0-6]m$/)
  })

  it("the region paints with palette-derived SGR when the engine is built with the override", () => {
    const sgr = sgrFromPalette(resolvePalette(cap, "tokyo-night"), cap)
    const eng = createInlineLiveRegion(46, 24, { sgr }) as InlineLiveRegionImpl
    eng.setRegionLines([
      { runs: [{ text: "Q ", style: "accent-user" }, { text: "hello", style: "bold" }] },
    ])
    let bytes = ""
    eng.drawRegion((s) => { bytes += s })
    // the single region line sits bottom-anchored (46x24 → region rows 15..24).
    expect(bytes).toContain(`\x1b[24;1H\x1b[0m\x1b[38;2;122;162;247mQ \x1b[0m\x1b[1mhello\x1b[K`)
    // the palette-derived SGR replaced the fixed 36m cyan accent.
    expect(bytes).not.toContain("\x1b[36mQ")
  })
})

// ------------------------------------------------------------------ 4. pseudo-integration

describe("TuiApp minimal path (fake InlineLiveRegion + fake engine)", () => {
  const makeApp = (inline: FakeInline, backend: QueueBackend, modeSwitch?: (cmd: string) => boolean) => {
    const app = new TuiApp({
      renderer: createRenderer({ cols: 80, rows: 24, cap }),
      backend,
      engine: new FakeScrollback(),
      capabilities: cap,
      palette,
      glyphs: GLYPHS,
      write: () => {},
      mode: "minimal",
      inline,
      ...(modeSwitch !== undefined ? { modeSwitch } : {}),
    })
    return app
  }

  it("events → engine.append + boundary commit → setRegion + drawRegion, all through the sink", async () => {
    const inline = new FakeInline()
    const backend = new QueueBackend()
    const writes: string[] = []
    const engine = new FakeScrollback()
    const app = new TuiApp({
      renderer: createRenderer({ cols: 80, rows: 24, cap }),
      backend,
      engine,
      capabilities: cap,
      palette,
      glyphs: GLYPHS,
      write: (s) => writes.push(s),
      mode: "minimal",
      inline,
    })
    const run = app.start()
    expect(app.state().screen).toBe("minimal") // the region screen, not welcome/agent
    backend.push(
      { type: "user", text: "hi", seq: 1, ts: 0 },
      { type: "assistant", text: "howdy", seq: 2, ts: 0 },
      { type: "turn", phase: "end", seq: 3, ts: 0 },
    )
    await sleep(60)
    // Print-once: user committed immediately; the assistant chunk delayed to
    // the turn/end boundary (2 commits, no duplicate rows).
    expect(inline.commits).toHaveLength(2)
    expect(inline.commits[0]).toMatchObject([{ runs: [{ text: "hi" }] }])
    expect(inline.commits[1]).toMatchObject([{ runs: [{ text: "howdy" }] }])
    // Region rows: composed → setRegion (tail window + status + prompt rows).
    expect(inline.draws).toBeGreaterThan(0)
    const r = inline.lastRegion
    expect(r.length).toBeGreaterThanOrEqual(2)
    expect(r[r.length - 1]).toMatchObject({ runs: [{ text: "", style: "text" }], glyph: "❯" }) // prompt row, bottom, focused
    expect(r[r.length - 2].runs[0].text).toBe("unconfigured") // status row (single part: no chips yet)
    // Every byte through the app sink (ledger saw commit + region writes).
    expect(writes.join("")).toContain("[commit 1]")
    expect(writes.join("")).toContain("[commit 2]")
    expect(writes.join("")).toContain("[region]")
    await backend.close()
    await run
  })

  it("session/open resets session-derived fullscreen state before low-seq history", async () => {
    const backend = new QueueBackend()
    const engine = createScrollbackEngine({ width: 80 })
    const app = new TuiApp({
      renderer: createRenderer({ cols: 80, rows: 24, cap }),
      backend,
      engine,
      capabilities: cap,
      palette,
      glyphs: GLYPHS,
      write: () => {},
      sessionId: "initial",
    })
    const run = app.start()
    try {
      backend.push(
        { type: "user", text: "old history", seq: 100, ts: 0 },
        { type: "title", title: "old title", seq: 101, ts: 0 },
        { type: "plan", phase: "on", seq: 102, ts: 0 },
        { type: "todo", items: [{ id: "old", text: "old todo", status: "pending" }], seq: 103, ts: 0 },
        { type: "goal", label: "old goal", state: "active", seq: 104, ts: 0 },
        { type: "turn", phase: "start", seq: 105, ts: 0 },
      )
      await sleep(40)
      const state = app.state()
      state.prompt.text = "old draft"
      state.prompt.cursor = state.prompt.text.length
      state.history = ["old prompt"]
      state.historyIndex = 1
      state.status.contextUsed = 42
      state.status.contextTotal = 100
      state.status.tasks = { running: 1, labels: ["old task"] }
      state.status.queue = 2
      state.panes.add("todo")
      state.scroll = { offset: 7, follow: false, selectionAnchor: 3 }
      state.search = { active: true, text: "old", matches: [0], current: 1 }
      state.dimFrom = 4

      backend.push(
        { type: "session/open", sessionId: "next", seq: -1, ts: 1 } as TuiEvent,
        { type: "user", text: "new history", seq: 0, ts: 2 },
      )
      await sleep(40)

      expect(engine.viewport(0, 10).map((line) => line.runs.map((run) => run.text).join(""))).toEqual(["❯ new history"])
      expect(state.prompt.text).toBe("")
      expect(state.history).toEqual([])
      expect(state.title).toBe("untitled")
      expect(state.mode).toBe("normal")
      expect(state.status.plan).toBe(false)
      expect(state.status.todo).toEqual({ done: 0, total: 0 })
      expect(state.status.goal).toBeUndefined()
      expect(state.status.tasks).toEqual({ running: 0, labels: [] })
      expect(state.status.contextUsed).toBeUndefined()
      expect(state.status.contextTotal).toBeUndefined()
      expect(state.status.queue).toBe(0)
      expect(state.paneData).toBeUndefined()
      expect(state.panes.size).toBe(0)
      expect(state.turn).toBeUndefined()
      expect(state.search).toBeUndefined()
      expect(state.scroll).toEqual({ offset: 0, follow: true })
      expect(state.dimFrom).toBeUndefined()
      state.prompt.text = "/session-info"
      state.prompt.cursor = state.prompt.text.length
      app.dispatch("submit")
      await sleep(20)
      expect(state.lightPanel?.rows.find((row) => row.label === "id")?.detail).toBe("next")
    } finally {
      await backend.close()
      await run
    }
  })

  it("session/open invokes an engine reset capability before replacement history", async () => {
    const backend = new QueueBackend()
    const engine = new FakeScrollback()
    const app = new TuiApp({
      renderer: createRenderer({ cols: 80, rows: 24, cap }),
      backend,
      engine,
      capabilities: cap,
      palette,
      glyphs: GLYPHS,
      write: () => {},
    })
    const run = app.start()
    try {
      backend.push(
        { type: "user", text: "old", seq: 100, ts: 0 },
        { type: "session/open", sessionId: "next", seq: -1, ts: 1 },
        { type: "user", text: "new", seq: 0, ts: 2 },
      )
      await sleep(40)
      expect(engine.resetCalls).toBe(1)
      expect(engine.viewport(0, 10).map((line) => line.runs[0]?.text)).toEqual(["new"])
    } finally {
      await backend.close()
      await run
    }
  })

  it("session/open ignores an old context probe and refreshes the new session", async () => {
    const oldContext = deferred<{ used: number; total: number }>()
    const newContext = deferred<{ used: number; total: number }>()
    const backend = new QueueBackend() as QueueBackend & Pick<BackendClient, "context">
    let probes = 0
    backend.context = async () => (++probes === 1 ? oldContext.promise : newContext.promise)
    const app = new TuiApp({
      renderer: createRenderer({ cols: 80, rows: 24, cap }),
      backend,
      engine: createScrollbackEngine({ width: 80 }),
      capabilities: cap,
      palette,
      glyphs: GLYPHS,
      write: () => {},
    })
    const run = app.start()
    try {
      await sleep(10)
      expect(probes).toBe(1)
      backend.push({ type: "session/open", sessionId: "next", seq: -1, ts: 1 } as TuiEvent)
      await sleep(10)
      oldContext.resolve({ used: 99, total: 100 })
      await sleep(20)
      expect(app.state().status.contextUsed).toBeUndefined()
      expect(probes).toBe(2)
      newContext.resolve({ used: 2, total: 100 })
      await sleep(20)
      expect(app.state().status.contextUsed).toBe(2)
    } finally {
      newContext.resolve({ used: 2, total: 100 })
      await backend.close()
      await run
    }
  })

  it("keeps the session picker open and owns a failed backend open", async () => {
    const backend = new QueueBackend()
    backend.open = async () => { throw new Error("session locked") }
    const app = new TuiApp({
      renderer: createRenderer({ cols: 80, rows: 24, cap }),
      backend,
      engine: createScrollbackEngine({ width: 80 }),
      capabilities: cap,
      palette,
      glyphs: GLYPHS,
      write: () => {},
      listSessions: async () => [{ id: "locked", title: "Locked", updatedAt: 1, turnCount: 2 }],
    })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on("unhandledRejection", onUnhandled)
    try {
      app.dispatch("sessions")
      await sleep(10)
      expect(app.state().sessions?.loading).toBe(false)
      app.dispatch("overlay-select")
      await sleep(20)
      expect(unhandled).toEqual([])
      expect(app.state().sessions?.loading).toBe(false)
      expect(app.state().sessions).toBeDefined()
      expect(app.state().toasts.some((toast) => toast.text.includes("session locked"))).toBe(true)
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("submitting `/minimal` relays to the mode switch (relaunch handled, loop quits)", async () => {
    const inline = new FakeInline()
    const backend = new QueueBackend()
    const relayed: string[] = []
    const app = makeApp(inline, backend, (cmd) => {
      if (cmd === "/minimal") {
        relayed.push(cmd)
        return true
      }
      return false
    })
    const run = app.start()
    app.state().prompt.text = "/minimal"
    app.state().prompt.cursor = "/minimal".length
    app.dispatch("submit")
    await sleep(40)
    expect(relayed).toEqual(["/minimal"]) // recognized and handed to ModeSwitch
    expect(backend.closed).toBe(true) // the current process quits after the spawn
    await run
  })

  it("minimal keymap: Enter submits, Esc is a no-op guard, Ctrl+Q quits, no scrollback", () => {
    expect(dispatchKey(kbd({ code: "Enter" }), minimalKeyState())).toBe("submit")
    expect(dispatchKey(kbd({ code: "Esc" }), minimalKeyState({ promptText: "draft" }))).toBe("none")
    expect(dispatchKey(kbd({ code: "char", key: "q", ctrl: true }), minimalKeyState())).toBe("quit")
    expect(dispatchKey(kbd({ code: "char", key: "c", ctrl: true }), minimalKeyState())).toBe("none")
    expect(dispatchKey(kbd({ code: "Up" }), minimalKeyState())).toBe("none")
    expect(dispatchKey(kbd({ code: "Down" }), minimalKeyState())).toBe("none")
    expect(dispatchKey(kbd({ code: "Tab" }), minimalKeyState())).toBe("none") // no focus-scrollback in minimal
    // fullscreen keymap unchanged when minimal is off
    expect(dispatchKey(kbd({ code: "Esc" }), minimalKeyState({ minimal: false, promptText: "draft" }))).toBe("cancel-turn")
  })
})
