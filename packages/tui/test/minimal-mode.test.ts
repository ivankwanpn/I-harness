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
import { ModeSwitch, parseModeArg, relaunchArgs } from "../src/minimal/mode.ts"
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
