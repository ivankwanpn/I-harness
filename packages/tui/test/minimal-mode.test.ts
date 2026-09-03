// M38a G2: minimal mode — the live-region content model (composeRegion), the
// print-once commit pipeline (MinimalCommits + commitDelta), the mode switch
// (relaunchArgs / parseModeArg / ModeSwitch), and a pseudo-integration of the
// TuiApp minimal path against a FAKE InlineLiveRegion + FAKE engine: events →
// engine.append → boundary commit (through the write sink) → setRegion +
// drawRegion. G1's real inline.ts is code-against-contract; tests never
// import it (returns undefined → fullscreen fallback is app-level behavior).

import { afterEach, describe, expect, it, vi } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import type { InlineHost } from "../src/app/loop.ts"
import { composeRegion } from "../src/minimal/live-region.ts"
import type { LiveRegionState } from "../src/minimal/live-region.ts"
import { MinimalCommits, commitDelta } from "../src/minimal/commit.ts"
import { ModeSwitch, parseModeArg, relaunchArgs } from "../src/minimal/mode.ts"
import { dispatchKey } from "../src/app/keys.ts"
import type { Kbd, KeymapState } from "../src/app/keys.ts"
import type { BackendClient, DisplayLine, ScrollbackEngine, SessionSummary, TuiEvent } from "../src/contracts.ts"
import type { RegionLine } from "../src/minimal/contracts.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

/** Pushable TuiEvent stream for the loop's backend pump. */
class QueueBackend implements BackendClient {
  private queue: TuiEvent[] = []
  private wake: (() => void) | undefined
  private ended = false
  closed = false

  push(...evs: TuiEvent[]): void {
    this.queue.push(...evs)
    this.wake?.()
  }

  async *events(): AsyncIterable<TuiEvent> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift()!
      if (this.ended) return
      await new Promise<void>((r) => { this.wake = r })
    }
  }

  listSessions(): Promise<SessionSummary[]> { return Promise.resolve([]) }
  open(): Promise<void> { return Promise.resolve() }
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
    expect(r[r.length - 2].runs[0].text).toBe("mock-model") // status row (single part: no chips yet)
    // Every byte through the app sink (ledger saw commit + region writes).
    expect(writes.join("")).toContain("[commit 1]")
    expect(writes.join("")).toContain("[commit 2]")
    expect(writes.join("")).toContain("[region]")
    await backend.close()
    await run
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
