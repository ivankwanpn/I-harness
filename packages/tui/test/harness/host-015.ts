// M38a G3: PTY host for case-015 — the MINIMAL-MODE deterministic scene.
//
// THE PRODUCTION PATH: TuiApp is wired in mode "minimal" with the REAL G1
// inline engine (createInlineLiveRegion — imported directly; this host is the
// production-path harness, not a re-implementation) and the REAL G2 commit
// pipeline (the loop's minimalOnEvent → commitMinimalDelta → frameMinimal).
// Every app byte flows through the same writeSync(1) sink + ledger as the
// M37a hosts. NO tui-core terminal here: minimal mode never enters the alt
// screen — the app writes straight into the pty, and the terminal's NATIVE
// normal buffer (scrollback + screen rows, no 1049h) is the proof target.
//
// Determinism (the anim-pump trap — read carefully):
//   - clock is FROZEN (now: () => 13_334). Minimal mode's frameMinimal() has
//     NO identical-frame suppression (unlike the fullscreen renderer diff →
//     flush("") path), so the loop.frameMinimal() drawRegion write is emitted
//     on EVERY frame. While a turn is running the 30fps anim pump requests a
//     frame every 33ms (needsAnim: turn defined) — repaints would write. THE
//     FROZEN clock kills the idle-flush commit (0ms < 500ms threshold) but
//     NOT the frame repaints, so the scene is paced thus: every sleep happens
//     while the turn is IDLE (no turn → needsAnim false → anim pump writes
//     nothing), and the turn-running events (tool running → tool done →
//     assistant → turn end) are yielded as a SYNCHRONOUS batch with NO timer
//     between them — the whole batch + its frame microtasks execute inside ONE
//     macrotask, which a 33ms interval tick cannot interrupt. The write count
//     is therefore exact and anim-jitter-free.
//   - In fullscreen mode the anim repaints of an identical frame flush ""
//     ("zero-byte idle"), so the minimal path's unconditional region repaints
//     are the ONE minimal-specific behavior this case accommodates (no bug
//     observed — the bytes are identical; only the count differs from the
//     fullscreen path).
//
// Scenes: argv[3] = "015" (minimal, --relaunch optional) | "015r" (the
// RELAUNCHED fullscreen self — same process binary, spawned by 015).
// argv[4]/argv[5] = size1/size2 ("WxH"). argv[6] = --relaunch's second marker
// dir (the child's marker dir), only present on a "015" run.
//
// case-015 (main): user "hello" → system context → [tool running → tool done
// → assistant → turn end, ONE batch] → 2500ms (the test's app-resize step
// lands in here — the fs `req-resize` channel → app.setSize) → user "again"
// (the post-resize commit) → settle → exit 0. NO input events at all.
// case-015r (relaunch): fullscreen pipeline (like host-011): terminal +
// alt-screen chrome at the CURRENT (post-resize) size, user "hello" → turn
// end, one frame each, teardown → exit-code marker "exit-done" → exit 0.
// Markers of the child go to the dir from env TUI_HOST_MARKER_DIR (the
// parent passes it at spawn) — the child's argv[2] is the PARENT's marker dir
// and stays untouched. The parent waits for the child's `exit-done` before
// exiting (the child shares the pty console — see the resolver note in
// main015: the child survives the parent's exit under this ConPTY pairing).
//
// Errors: any throw → best-effort marker "host-failed" + message → exit 3.

import { execSync } from "node:child_process"
import { spawn as spawnProcess } from "node:child_process"
import { writeFileSync, writeSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  createRenderer,
  createTerminal,
  createUnknownCapabilities,
  makeGlyphs,
  resolvePalette,
} from "@i-harness/tui-core"
import type { TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp, createScrollbackEngine, relaunchArgs } from "../../src/index.ts"
import type { BackendClient, TuiEvent } from "../../src/index.ts"
import { createInlineLiveRegion } from "../../src/minimal/inline.ts"
import type { InlineLiveRegion } from "../../src/minimal/contracts.ts"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function parseSize(raw?: string): { cols: number; rows: number } {
  const m = /^(\d+)x(\d+)$/.exec(raw ?? "")
  if (!m) return { cols: 46, rows: 24 }
  return { cols: Number(m[1]), rows: Number(m[2]) }
}

const MARKER_DIR = process.env.TUI_HOST_MARKER_DIR ?? process.argv[2] ?? ""
const SCENE = process.argv[3] ?? "015"
const size1 = parseSize(process.argv[4])
const size2 = parseSize(process.argv[5])
const RELAUNCH_DIR = process.argv[6] !== undefined && process.argv[6] !== "" ? process.argv[6] : undefined
const TUI_FROZEN_NOW = 13_334 // case-011 parity: a spinner frame index / flat clock

function marker(name: string): void {
  mkdirSync(MARKER_DIR, { recursive: true })
  writeFileSync(`${MARKER_DIR}/${name}`, `${Date.now()}`)
}

let epipe = false
let totalBytes = 0
let totalWrites = 0

/** writeSync(1) sink + ledger (host-011 parity): EPIPE swallowed; every call
 * counted in <markerDir>/bytes + /writes for `assert-byte-budget`. */
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

/** Fixed capabilities — host-011 parity (no live probe under a pty). */
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

// ------------------------------------------------------------------ scenes

/** The minimal scene events (spec case-015): user "hello", runtime-context
 * system line (SHORT — fits the 28-col content width at 34x18, so no rewrap
 * churn across the resize), tool running "Run read data.txt", tool done
 * "data.txt exists", assistant "It says hello.", turn end, then the
 * POST-RESIZE commit user "again". seq ascending. */
function sceneEvents015(): TuiEvent[] {
  return [
    { type: "user", text: "hello", seq: 1, ts: 0 },
    { type: "system", text: "context: workspace ok", seq: 2, ts: 100 },
    { type: "tool", callId: "r1", name: "read data.txt", kind: "execute", status: "running", summary: "read data.txt", seq: 3, ts: 200 },
    { type: "tool", callId: "r1", name: "read data.txt", kind: "execute", status: "done", output: "data.txt exists", summary: "read data.txt", seq: 4, ts: 300 },
    { type: "assistant", text: "It says hello.", seq: 5, ts: 400 },
    { type: "turn", phase: "end", seq: 6, ts: 500 },
    { type: "user", text: "again", seq: 7, ts: 700 },
  ]
}

/** Pacing (the anim-pump rule — header note): ms before each event; a 0 ms
 * step is delivered WITHOUT await so the whole 0-run is one macrotask batch.
 * The post-resize commit lands at 2500ms — AFTER the test's app-resize step
 * (fs request + virtual reflow) finishes, which runs right after turn-end. */
const PACING_015 = [800, 800, 800, 0, 0, 0, 2500]

/** The backend for the "015" scene: sleeps while the turn is IDLE, streams
 * the turn events back-to-back (single macrotask), then the post-resize user
 * after a 2500ms window (the test's app-resize step lands in it →
 * app.setSize via the fs channel), then ENDS (add() resolves → start()
 * resolves → the host exits cleanly). */
function sceneBackend015(): BackendClient {
  const events = sceneEvents015()
  return {
    async *events(): AsyncIterable<TuiEvent> {
      for (let i = 0; i < events.length; i++) {
        const ms = PACING_015[i]!
        if (ms > 0) await sleep(ms)
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

/** The RELAUNCHED fullscreen scene ("015r"): host-011's pipeline in miniature
 * — terminal init (alt-screen chrome + the real tui-core renderer path),
 * user "hello" → turn end (one frame each), teardown, explicit exit-code
 * marker. Markers/ledger go to TUI_HOST_MARKER_DIR (set by the parent). */
async function main015r(): Promise<void> {
  execSync("chcp.com 65001>NUL", { stdio: "ignore" })

  const terminal = createTerminal({
    stream: { write: (s: string): boolean => { out(s); return true } },
    cap,
  })
  const renderer = createRenderer({ cols: size1.cols, rows: size1.rows, cap })
  const engine = createScrollbackEngine({ width: size1.cols })

  const events: TuiEvent[] = [
    { type: "user", text: "hello", seq: 1, ts: 0 },
    { type: "turn", phase: "end", seq: 2, ts: 100 },
  ]
  const backend: BackendClient = {
    async *events(): AsyncIterable<TuiEvent> {
      await sleep(600)
      yield events[0]!
      await sleep(600)
      yield events[1]!
      await sleep(600)
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

  let frameN = 0
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
  await sleep(150)
  marker("app-fullscreen-start")
  await app.start()

  await sleep(300)
  terminal.teardown()
  marker("teardown-wrote")
  writeFileSync(`${MARKER_DIR}/exit-code`, "0")
  marker("exit-done")
  process.exit(0)
}

// ------------------------------------------------------------------ main ("015")

async function main015(): Promise<void> {
  execSync("chcp.com 65001>NUL", { stdio: "ignore" })

  // Geometry: the renderer is STILL constructed (the loop reads
  // renderer.buffer.width for the engine width); in minimal mode the loop
  // never touches its cells. The inline engine is the REAL G1 instance —
  // created HERE and passed as the app's `inline` (the production-path host).
  const renderer = createRenderer({ cols: size1.cols, rows: size1.rows, cap })
  const engine = createScrollbackEngine({ width: size1.cols })
  const inline: InlineLiveRegion = createInlineLiveRegion(size1.cols, size1.rows)

  const backend = sceneBackend015()

  let frameN = 0
  /** Dev aid: TUI_DUMP_DIR=<dir> writes region-N.txt = the live-region canon
   * (G1's regionLines, runs text per row — what the pty shows) at each frame. */
  function dumpRegion(n: number): void {
    const dumpDir = process.env.TUI_DUMP_DIR
    if (dumpDir === undefined || dumpDir === "") return
    const rows = inline
      .regionLines()
      .map((l) => l.runs.map((r) => r.text).join(""))
      .join("\n")
    writeFileSync(join(dumpDir, `region-${n}.txt`), rows + "\n")
  }

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
      if (epipe) return
      out(s)
      const n = ++frameN
      marker(`frame-${n}`)
      dumpRegion(n)
    },
    now: () => TUI_FROZEN_NOW,
  })

  /** Resize channel — EMPIRICAL FINDING (M38a G3): under this node-pty ConPTY
   * pairing the CHILD never observes the master's resize (no stdout 'resize'
   * event, process.stdout.columns stays 46x24 — measured in probe runs), so
   * apps/tui's relay is dead code under the harness. The case therefore
   * drives the SAME app.setSize through a deterministic fs seam instead: the
   * test writes `req-resize-<c>x<r>` into the marker dir, this poll applies
   * the resize and acks `host-ack-<c>x<r>`. The app-side path (app.setSize →
   * engine re-wrap + inlineHost.resize → next drawRegion at the new bottom)
   * is the production one; the ConPTY master resize itself stays unproven
   * (its inject-replay burns the native buffer — the fullscreen case-014
   * remains the master-resize proof there).
   * The stdout relay + 100ms poll remains as a best-effort parallel path. */
  let lastC = size1.cols
  let lastR = size1.rows
  const relay = (): void => {
    const c = process.stdout.columns
    const r = process.stdout.rows
    if (c === undefined || r === undefined) return
    if (c === lastC && r === lastR) return
    lastC = c
    lastR = r
    renderer.resize(c, r)
    app.setSize(c, r)
    marker(`host-resize-${c}x${r}`)
  }
  process.stdout.on("resize", relay)
  const poll = setInterval(relay, 100)
  const fsResize = setInterval(() => {
    try {
      for (const e of readdirSync(MARKER_DIR)) {
        const m = /^req-resize-(\d+)x(\d+)$/.exec(e)
        if (m === null) continue
        const c = Number(m[1])
        const r = Number(m[2])
        lastC = c
        lastR = r
        renderer.resize(c, r)
        app.setSize(c, r)
        writeFileSync(`${MARKER_DIR}/host-ack-${c}x${r}`, `${Date.now()}`)
        unlinkSync(`${MARKER_DIR}/${e}`) // consume: fire once
        marker(`host-resize-${c}x${r}`)
      }
    } catch {
      /* marker dir may not exist yet — headless start */
    }
  }, 100)

  const started = app.start().then(() => {
    clearInterval(poll)
    clearInterval(fsResize)
  })
  await sleep(150)
  marker("app-minimal-start")
  await started // resolves when the scripted backend ends (scene 015)

  // === relaunch sub-case: spawn SELF with --mode fullscreen (spec §1) ===
  // argv contracts: [2]=parent marker dir, [3]=scene, [4]=size1, [5]=size2,
  // [6]=second marker dir (this run), [7..]=preserved flags. The child's argv
  // is [<second dir>, "015r", size1, size2, ...relaunchArgs("fullscreen",
  // preserved)] — the production relaunchArgs does the mode-flip stripping
  // (here it strips nothing: the preserved list is empty); the SECOND marker
  // dir is delivered via env TUI_HOST_MARKER_DIR so the child never touches
  // the parent's markers.
  if (RELAUNCH_DIR !== undefined) {
    // GATE: the child's fullscreen bytes would pollute the minimal-screen
    // assertions (same pty stream) — the TEST releases the relaunch only
    // after its minimal proofs (byte budget included) complete.
    for (let t = 0; t < 200; t++) {
      if (existsSync(`${MARKER_DIR}/relaunch-go`)) break
      await sleep(100)
    }
    // The child inherits the CURRENT (post-resize) geometry — the pty is at
    // size2 by the time the relaunch runs; the child's fullscreen layout must
    // match the pty (its argv sizing mirrors the production "read the size
    // from the terminal" — the harness hardcodes the current one).
    const childArgv = [
      RELAUNCH_DIR,
      "015r",
      `${size2.cols}x${size2.rows}`,
      `${size2.cols}x${size2.rows}`,
      ...relaunchArgs("fullscreen", process.argv.slice(7)),
    ]
    const dump2 =
      process.env.TUI_DUMP_DIR !== undefined && process.env.TUI_DUMP_DIR !== ""
        ? join(process.env.TUI_DUMP_DIR, "relaunch")
        : process.env.TUI_DUMP_DIR
    const child = spawnProcess(process.execPath, ["--import", "tsx", process.argv[1]!, ...childArgv], {
      stdio: "inherit",
      env: { ...process.env, TUI_HOST_MARKER_DIR: RELAUNCH_DIR, TUI_DUMP_DIR: dump2 },
    })
    child.on("error", (e) => {
      try {
        writeFileSync(`${RELAUNCH_DIR}/spawn-error`, String(e))
      } catch {
        /* nothing more to report */
      }
    })
    // The child needs the console to survive the parent's exit — wait for its
    // final marker (exit-done) before exiting (experiment G3: does the console
    // stay attached to another process, or is it killed at the direct child's
    // exit? the parent exits LAST, so the child never races a dead console).
    for (let t = 0; t < 100; t++) {
      if (existsSync(`${RELAUNCH_DIR}/exit-done`)) break
      await sleep(100)
    }
    if (!existsSync(`${RELAUNCH_DIR}/exit-done`)) {
      try {
        writeFileSync(`${RELAUNCH_DIR}/parent-timeout`, `${Date.now()}`)
      } catch {
        /* nothing to report */
      }
    }
    try {
      child.kill("SIGKILL")
    } catch {
      /* already dead */
    }
  }

  // Settle window + teardown (no tui-core terminal — nothing to tear down).
  await sleep(500)
  marker("teardown-wrote")
  process.exit(0)
}

async function main(): Promise<void> {
  if (SCENE === "015r") {
    await main015r()
    return
  }
  await main015()
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
