// M46b G3 (final): PTY host for case-023 — the MOUSE MATRIX at REAL-PTY level.
// The host drives the REAL app pipeline + the real tui-core InputParser (raw
// stdin → parser → queue) against a scripted two-turn stream; the test writes
// SGR 1006 mouse sequences to the pty master and the PRODUCTION path decodes
// them (parser → loop.onInput → G1 hover engine + scroll stream → G2 router).
//
// Scene "023" (the main matrix run, 80x24): a fullscreen TuiApp wired with
//   - engine TS ON from the start (createScrollbackEngine showTimestamps:true
//     — the hover timestamp-swap rows carry the local-constructed epochs:
//     new Date(y,m,d,h,mm,ss) — TZ-honest, every runtime renders the same
//     wall time),
//   - a RECORDER clipboard (the drag auto-copy payload lands in
//     <markerDir>/clipboard.json + marker "copied" — the injected-copy path,
//     spec §7 hard rule),
//   - a selection watcher (25ms poll; each engine selection change writes
//     <markerDir>/selection.json + marker "selection-changed" — the PTY test
//     has no renderer state for the selection: the box/flash PANTING is a
//     harmonization concern, the ENGINE set is the assertable truth),
//   - the permission overlay built LATE through the production seam
//     (bindPermissionOverlay, host-013 parity) when the test requests it via
//     marker "req-overlay": double-click fires → decision.json + "answered".
// The scripted stream is the case's deterministic scene (turn 1: user "hello",
// assistant two lines, execute "Run read data.txt" collapsed, read
// "notes.md", Edit block expanded with a 12-row diff; turn 2: user "again",
// assistant "tail" — 26 display lines, the scrollback scrolls at follow).
//
// Scene "023m" (minimal no-capture, 80x24): TuiApp in mode "minimal" over the
// REAL inline live-region engine — NO tui-core terminal at all (no alt
// screen, NO init/teardown sequences — the capture five-mode set is never
// emitted). The test asserts the captured byte stream contains no "?1000h".
//
// Errors: any throw → best-effort marker "host-failed" + message → exit 3.

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { createRenderer, createTerminal, createUnknownCapabilities, makeGlyphs, resolvePalette, InputParser } from "@i-harness/tui-core"
import type { TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { TuiApp, bindPermissionOverlay, createScrollbackEngine } from "../../src/index.ts"
import { createInlineLiveRegion } from "../../src/minimal/inline.ts"
import type { BackendClient, InputSource, PermissionSurface, PermissionState, TuiEvent } from "../../src/index.ts"
import type { Clipboard } from "../../src/app/clipboard.ts"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const MARKER_DIR = process.argv[2] ?? ""
const SCENE = process.argv[3] ?? "023"
const m = /^(\d+)x(\d+)$/.exec(process.argv[4] ?? "")
const size = m !== null ? { cols: Number(m[1]), rows: Number(m[2]) } : { cols: 80, rows: 24 }
const TUI_FROZEN_NOW = 44_444

function marker(name: string): void {
  mkdirSync(MARKER_DIR, { recursive: true })
  writeFileSync(`${MARKER_DIR}/${name}`, `${Date.now()}`)
}

async function pollMarker(name: string, timeoutMs = 25_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (existsSync(`${MARKER_DIR}/${name}`)) return
    if (Date.now() - t0 >= timeoutMs) throw new Error(`host poll: marker "${name}" never appeared`)
    await sleep(50)
  }
}

let epipe = false
let totalBytes = 0
let totalWrites = 0

function out(s: string): void {
  if (epipe) return
  try {
    writeSync(1, s)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "EPIPE") epipe = true
    else throw e
  }
  totalBytes += Buffer.byteLength(s)
  totalWrites += 1
  try {
    writeFileSync(`${MARKER_DIR}/bytes`, String(totalBytes))
    writeFileSync(`${MARKER_DIR}/writes`, String(totalWrites))
  } catch {
    /* ledger is best-effort */
  }
}

/** Fixed caps (host-011 parity — no live probe under a pty). */
const cap: TerminalCapabilityContext = {
  ...createUnknownCapabilities(),
  colorLevel: "truecolor",
  dark: true,
  synchronizedOutput: false,
  mouse: true,
  bracketedPaste: true,
  focusEvents: true,
  brand: "WindowsTerminal",
  legacyConsole: false,
}

/** host-017 parity: raw stdin → REAL tui-core InputParser → queue. The
 * pty-master mouse bytes are decoded HERE (SGR 1006 <b;x;yM|m). */
function wireInput(): { source: InputSource; endInput: () => void } {
  const parser = new InputParser()
  const queue: InputEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const pushEvent = (ev: InputEvent): void => {
    queue.push(ev)
    wake?.()
  }
  process.stdin.setRawMode?.(true)
  process.stdin.on("data", (chunk: unknown) => {
    const data: Uint8Array | string =
      typeof chunk === "string" ? chunk
      : chunk instanceof Uint8Array ? chunk
        : new Uint8Array(0)
    for (const ev of parser.push(data, cap)) pushEvent(ev)
    if (drainTimer !== undefined) clearTimeout(drainTimer)
    drainTimer = setTimeout(() => {
      drainTimer = undefined
      for (const ev of parser.drain()) pushEvent(ev)
    }, 40)
  })
  const source: InputSource = {
    async *next(): AsyncIterable<InputEvent> {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!
        if (ended) return
        await new Promise<void>((res) => { wake = res })
      }
    },
  }
  const endInput = (): void => {
    ended = true
    wake?.()
    wake = undefined
  }
  return { source, endInput }
}

/** Hold-open (never-ending) iterator shared by both scenes. */
async function* hold(): AsyncIterable<TuiEvent> {
  for (;;) await sleep(1000)
}

/** The main scene generator: the two-turn 26-line matrix scene (600ms pacing
 * — one frame per event on the frozen clock). */
async function* mainEvents(): AsyncIterable<TuiEvent> {
  const T0 = new Date(2026, 8, 5, 18, 45, 32).getTime()
  const T1 = T0 + 60_000
  const events: TuiEvent[] = [
    { type: "turn", phase: "start", seq: 1, ts: T0 },
    { type: "user", text: "hello", seq: 2, ts: T0 },
    { type: "assistant", text: "two lines\nthird line", seq: 3, ts: T0 + 1000 },
    { type: "tool", callId: "r1", name: "read data.txt", kind: "execute", status: "done", output: "data-1\ndata-2\ndata-3\ndata-4\ndata-5\ndata-6", summary: "read data.txt", seq: 4, ts: T0 + 2000 },
    { type: "tool", callId: "n1", name: "notes.md", kind: "read", status: "done", output: "note-1\nnote-2\nnote-3", summary: "notes.md", seq: 5, ts: T0 + 3000 },
    { type: "tool", callId: "e1", name: "patch.txt", kind: "edit", status: "done", output: "+a1\n+a2\n+a3\n+a4\n+a5\n+a6\n-b1\n-b2\n-b3\n-b4\n-b5\n-b6", summary: "patch.txt", seq: 6, ts: T0 + 4000 },
    { type: "turn", phase: "end", seq: 7, ts: T0 + 5000 },
    { type: "turn", phase: "start", seq: 8, ts: T1 },
    { type: "user", text: "again", seq: 9, ts: T1 + 3000 },
    { type: "assistant", text: "tail", seq: 10, ts: T1 + 4000 },
    { type: "turn", phase: "end", seq: 11, ts: T1 + 5000 },
  ]
  for (const ev of events) {
    await sleep(600)
    yield ev
  }
  for await (const ev of hold()) yield ev
}

function scriptedBackend(events: () => AsyncIterable<TuiEvent>): BackendClient {
  return {
    async *events(): AsyncIterable<TuiEvent> {
      for await (const ev of events()) yield ev
    },
    listSessions: async () => [],
    open: async () => {},
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
  }
}

/** The main fullscreen scene: the whole matrix + the late permission overlay. */
async function main023(): Promise<void> {
  execSync("chcp.com 65001>NUL", { stdio: "ignore" })

  const terminal = createTerminal({ stream: { write: (s: string): boolean => { out(s); return true } }, cap })
  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols, showTimestamps: true })
  const input = wireInput()

  /** The RECORDER clipboard — the injected copy path (spec §7 hard rule):
   * every copy lands in <markerDir>/clipboard.json + marker "copied". */
  const clipboard: Clipboard = {
    copy: (text: string): void => {
      writeFileSync(`${MARKER_DIR}/clipboard.json`, text)
      marker("copied")
    },
  }

  marker("scene-ready")
  marker("events-seeded")

  let frameN = 0
  /** Dev aid: TUI_DUMP_DIR=<dir> writes <frame-N>.txt rows for the yaml authors. */
  function dumpRows(n: number): void {
    const dumpDir = process.env.TUI_DUMP_DIR
    if (dumpDir === undefined || dumpDir === "") return
    const inner = renderer as unknown as { db: { front: { cells: Array<{ text: string }>; width: number } } }
    const { cells, width } = inner.db.front
    const height = cells.length / width
    const rows: string[] = []
    for (let y = 0; y < height; y++) {
      let line = ""
      for (let x = 0; x < width; x++) line += cells[y * width + x].text
      rows.push(line.replace(/\0/g, ""))
    }
    writeFileSync(join(dumpDir, `frame-${n}.txt`), rows.join("\n"))
  }

  const app = new TuiApp({
    renderer,
    backend: scriptedBackend(mainEvents),
    engine,
    capabilities: cap,
    palette: resolvePalette(cap, "groknight"),
    glyphs: makeGlyphs(true),
    clipboard,
    // M46c G1: scene "023t" opts the timeline rail on (the mini-case asserts
    // the rail ticks/chevrons + /timeline toggle at this exact geometry).
    showTimeline: SCENE === "023t",
    write: (s: string) => {
      out(s)
      const n = ++frameN
      marker(`frame-${n}`)
      dumpRows(n)
    },
    now: () => TUI_FROZEN_NOW,
    input: input.source,
  })

  /** The engine-selection witness (the PTY has no renderer state for the
   * selection: the box/flash painting is a harmonization concern — the ENGINE
   * set is the truth the test asserts). Writes on every change. */
  let lastSel = ""
  const selWatch = setInterval(() => {
    const s = app.state().engine.selection()
    const text = s === undefined ? "" : JSON.stringify(s)
    if (text !== lastSel) {
      lastSel = text
      if (text !== "") {
        writeFileSync(`${MARKER_DIR}/selection.json`, text)
        marker("selection-changed")
      }
    }
  }, 25)

  terminal.init()
  void app.start()

  // === late permission overlay (host-013 parity, the seam's direct path).
  // Scene "023t" (the timeline mini-case) skips it — no modal on the rail
  // frames; the other scenes keep the exact host-013 flow.
  if (SCENE !== "023t") {
  await pollMarker("req-overlay")
  const surf: PermissionSurface = {
    id: "p1",
    kind: "bash",
    title: "echo hi",
    detail: "running bash: echo hi",
    scopes: ["command"],
    freeform: true,
  }
  const state: PermissionState = { cursor: 0, scopeIndex: 0, freeformText: "" }
  app.state().overlay = bindPermissionOverlay(surf, state, {
    onDecision: (d) => {
      writeFileSync(`${MARKER_DIR}/decision.json`, JSON.stringify(d))
      marker("answered")
    },
    onClose: () => {
      app.state().overlay = undefined
      app.dispatch("none")
    },
  })
  marker("overlay-p1")
  app.dispatch("none")
  }

  await pollMarker("request-exit")
  clearInterval(selWatch)
  input.endInput()
  await sleep(300) // consume any final frame
  terminal.teardown()
  marker("teardown-wrote")
  process.exit(0)
}

/** The minimal no-capture scene: mode "minimal" + the REAL inline engine —
 * NO tui-core terminal (never an init/teardown, never the five-mode set). */
async function main023m(): Promise<void> {
  execSync("chcp.com 65001>NUL", { stdio: "ignore" })

  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols })
  const inline = createInlineLiveRegion(size.cols, size.rows)

  const events: TuiEvent[] = [
    { type: "user", text: "hello", seq: 1, ts: 0 },
    { type: "system", text: "context: minimal run", seq: 2, ts: 100 },
    { type: "assistant", text: "minimal line", seq: 3, ts: 200 },
    { type: "turn", phase: "end", seq: 4, ts: 300 },
  ]
  const backend: BackendClient = {
    async *events(): AsyncIterable<TuiEvent> {
      for (const ev of events) {
        await sleep(600)
        yield ev
      }
      for await (const ev of hold()) yield ev
    },
    listSessions: async () => [],
    open: async () => {},
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
  }

  marker("scene-ready")
  marker("events-seeded")

  const app = new TuiApp({
    renderer,
    backend,
    engine,
    capabilities: cap,
    palette: resolvePalette(cap),
    glyphs: makeGlyphs(true),
    mode: "minimal",
    inline,
    write: (s: string) => {
      out(s)
      marker(`frame-${++frameNm}`)
    },
    now: () => TUI_FROZEN_NOW,
  })

  void app.start()
  await pollMarker("request-exit")
  await sleep(500) // settle window + teardown (no terminal — nothing to tear down)
  marker("teardown-wrote")
  process.exit(0)
}

let frameNm = 0

async function main(): Promise<void> {
  if (SCENE === "023m") await main023m()
  else await main023()
}

main().catch((e: unknown) => {
  try {
    marker("host-failed")
    writeFileSync(`${MARKER_DIR}/host-failed-message`, String(e))
  } catch {
    /* nothing more to report */
  }
  process.exit(3)
})
