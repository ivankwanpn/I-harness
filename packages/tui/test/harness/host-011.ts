// M37a G4: PTY host for cases 011/014 — spawned as the child of a REAL pty and
// drives a deterministic TUI scene through the REAL app pipeline:
// TuiApp.start() pumps a SCRIPTED in-process fake BackendClient (NOT the
// embedded service — the event script is the input; no mock LLM timing) into
// engine.append + present + renderer.commit + flush → writeSync(1). This is
// exactly apps/tui's wiring minus the terminal/physics.
//
// Determinism:
//   - capabilities are FIXED (no live probe — ConPTY replies are not parsed).
//   - clock is FROZEN (now: () => TUI_FROZEN_NOW): while a turn runs the 30fps
//     anim pump repaints IDENTICAL frames → flush("") → zero-byte idle holds
//     even mid-stream (a wall clock would repaint spinners/timers).
//   - pacing lives in the events generator (a sleep BEFORE each yield), so each
//     event paints exactly one frame; the write sink marks "frame-N" for every
//     non-empty flush. Paints are queued microtasks, so a paint always lands
//     before the generator's next macrotask sleep.
//
// Scenes: argv[3] = "011" | "014"; argv[4]/argv[5] = size1/size2.
//   case-011: 6 frames (user / system / tool running / tool done / assistant /
//             turn end), 700ms idle windows between frames.
//   case-014: 7 frames; size change between f5 (turn end) and f6 (assistant):
//             600ms — INTERNAL renderer+engine resize — 600ms — f6 (full paint
//             at size2 via the renderer's resize full-paint flag) — 700ms — f7.
//             The turn is IDLE across the resize window so the anim pump CANNOT
//             paint a stray full frame between the resize and the test's
//             virtual.resize (a running turn would repaint the resized grid
//             mid-window, breaking zero-byte idle and racing the tester).
//             The row-level resize proof = argv[5] (size2).
//
// Errors: any throw → best-effort marker "host-failed" + message → exit 3.

import { execSync } from "node:child_process"
import { writeFileSync, writeSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { createRenderer, createTerminal, createUnknownCapabilities, makeGlyphs, resolvePalette } from "@i-harness/tui-core"
import type { TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp, createScrollbackEngine } from "../../src/index.ts"
import type { BackendClient, TuiEvent } from "../../src/index.ts"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function parseSize(raw?: string): { cols: number; rows: number } {
  const m = /^(\d+)x(\d+)$/.exec(raw ?? "")
  if (!m) return { cols: 46, rows: 24 }
  return { cols: Number(m[1]), rows: Number(m[2]) }
}

const MARKER_DIR = process.argv[2] ?? ""
const SCENE = process.argv[3] ?? "011"
const size1 = parseSize(process.argv[4])
const size2 = parseSize(process.argv[5])
const TUI_FROZEN_NOW = 13_334 // spinner frame index 4 (⠼), flat 0:00 clock

function marker(name: string): void {
  mkdirSync(MARKER_DIR, { recursive: true })
  writeFileSync(`${MARKER_DIR}/${name}`, `${Date.now()}`)
}

let epipe = false
let totalBytes = 0
let totalWrites = 0

/** writeSync wrapper: EPIPE on a dead pty is swallowed; anything else rethrows.
 * Every byte the host emits passes here — a cumulative ledger is written to
 * <markerDir>/bytes + <markerDir>/writes so the referee's `assert-byte-budget`
 * can prove the whole run emitted EXACTLY init + N frames + teardown.
 * Byte/write COUNTS are immutable under pty delivery chunking (unlike
 * time-window sampling, which ConPTY's multi-second chunk gaps make racy). */
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

/** Fixed capabilities — no live probe (ConPTY replies are not parsed by us). */
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

// ------------------------------------------------------------------ the scene

/** Deterministic event script — THE scene (spec case-011): user "hello",
 * runtime-context system line, tool running "Run read data.txt", tool done
 * with output, assistant "It says hello.", turn end. `read data.txt` is an
 * EXECUTE tool (folding.ts: execute tools always render an output excerpt,
 * so running→done is a visible change). case-014 splits the same stream
 * around one turn-end → resize → assistant → turn-end sequence. */
function sceneEvents(scene: string): TuiEvent[] {
  const evs: TuiEvent[] = [
    { type: "user", text: "hello", seq: 1, ts: 0 },
    { type: "system", text: "context: workspace i-harness-main", seq: 2, ts: 100 },
    { type: "tool", callId: "r1", name: "read data.txt", kind: "execute", status: "running", summary: "read data.txt", seq: 3, ts: 200 },
    { type: "tool", callId: "r1", name: "read data.txt", kind: "execute", status: "done", output: "data.txt exists", summary: "read data.txt", seq: 4, ts: 300 },
    { type: "assistant", text: "It says hello.", seq: 5, ts: 400 },
    { type: "turn", phase: "end", seq: 6, ts: 500 },
  ]
  if (scene === "011") return evs
  // case-014: turn-end lands BEFORE the resize so the anim pump is off across
  // the resize window (parity with the header note); the assistant answers
  // after the resize and closes with a second turn-end. Arrival order MUST be
  // seq-ascending (the engine ignores `seq <= lastSeq`). The system line is
  // SHORT: at 34x18 the drawer clips content to cols-10 — a long line would be
  // wrap-truncated mid-row (engine wrap width vs drawer clip mismatch, an
  // upstream G1/G2 calibration), which would obscure this case's pure
  // resize-invariant proof.
  return [
    evs[0]!, // user (1)
    { type: "system", text: "context: workspace ok", seq: 2, ts: 100 }, // short — fits 34x18
    evs[2]!, // tool running (3)
    evs[3]!, // tool done (4)
    { type: "turn", phase: "end", seq: 5, ts: 500 },
    { type: "assistant", text: "It says hello.", seq: 6, ts: 1000 },
    { type: "turn", phase: "end", seq: 7, ts: 1100 },
  ]
}

/** Pacing: `beforeMs` sleep before each event; `resize` (optional) is applied
 * to the app's renderer+engine at `resizeAtMs` into that window (right before
 * the event's frame — the resize full-paint). `resizeAtMs` defaults to the
 * END of the window (i.e. after the whole sleep); with a plain `beforeMs`
 * the resize lands right before the yield. */
interface Step {
  beforeMs: number
  resize?: { cols: number; rows: number }
  resizeAtMs?: number
}

function sceneSteps(scene: string): Step[] {
  if (scene === "014") {
    return [
      { beforeMs: 0 },      // f1 user
      { beforeMs: 800 },    // f2 system
      { beforeMs: 800 },    // f3 tool running (turn row)
      { beforeMs: 800 },    // f4 tool done
      { beforeMs: 800 },    // f5 turn end (idle — anim off)
      // f6 assistant: re-grid at t=900, frame at t=1800. The window is wider
      // than the test's resize+idle steps: ConPTY emits a resize REPLAY (the
      // console re-draws its content into the pty) inside the resize step's
      // settle sleep — the first byte-count window after it must be quiet.
      { beforeMs: 1800, resize: size2, resizeAtMs: 900 },
      { beforeMs: 800 },    // f7 turn end
    ]
  }
  return [
    { beforeMs: 0 },
    { beforeMs: 800 },
    { beforeMs: 800 },
    { beforeMs: 800 },
    { beforeMs: 800 },
    { beforeMs: 800 },
  ]
}

function scriptedBackend(events: TuiEvent[], steps: Step[], onResize: (s: { cols: number; rows: number }) => void): BackendClient {
  return {
    async *events(): AsyncIterable<TuiEvent> {
      for (let i = 0; i < events.length; i++) {
        const s = steps[i]!
        const resizeAt = s.resizeAtMs ?? s.beforeMs
        await sleep(resizeAt)
        if (s.resize !== undefined) onResize(s.resize)
        await sleep(Math.max(0, s.beforeMs - resizeAt))
        yield events[i]!
      }
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

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  // REAL-WORLD Windows fix: ConPTY's hidden conhost converts the wire stream
  // with the console output codepage unless the console is UTF-8 — TUI glyphs
  // (❯ ◆ ⠼) would be mangled. chcp flips the console attached to this process;
  // its own stdout is redirected so no answer bytes reach the pty.
  execSync("chcp.com 65001>NUL", { stdio: "ignore" })

  const terminal = createTerminal({
    stream: { write: (s: string): boolean => { out(s); return true } },
    cap,
  })
  const renderer = createRenderer({ cols: size1.cols, rows: size1.rows, cap })
  const engine = createScrollbackEngine({ width: size1.cols })

  const events = sceneEvents(SCENE)
  const steps = sceneSteps(SCENE)
  let frameN = 0
  const backend = scriptedBackend(events, steps, (s) => {
    renderer.resize(s.cols, s.rows)
    engine.setWidth(s.cols)
  })

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
      rows.push(line.replace(/ /g, ""))
    }
    writeFileSync(join(dumpDir, `frame-${n}.txt`), rows.join("\n"))
  }

  const app = new TuiApp({
    renderer,
    backend,
    engine,
    capabilities: cap,
    palette: resolvePalette(cap),
    glyphs: makeGlyphs(true),
    write: (s: string) => {
      out(s)
      const n = ++frameN
      marker(`frame-${n}`)
      dumpRows(n)
    },
    now: () => TUI_FROZEN_NOW,
  })

  terminal.init()
  await app.start()

  // Settle window: proves silence after the last frame and lets the test read
  // the final screen with its own idle windows.
  await sleep(500)
  terminal.teardown()
  marker("teardown-wrote")
  process.exit(0)
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
