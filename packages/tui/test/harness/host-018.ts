// M40 G2 (C11): PTY host for case-018 — the MOUSE WHEEL scroll proof.
// EXACTLY the case-016 FULLSCREEN pipeline (host-016.ts) PLUS host-017's real
// stdin wireInput (raw pty bytes → REAL tui-core InputParser → TuiApp.input):
// the test writes SGR 1006 wheel sequences (\x1b[<64/65;x;yM) through the pty
// master and the production key path scrolls the scrollback (wheel → the
// existing scroll-up/down actions, ±3, follow-aware — M40 G2).
//
// Scene "018" (46x24): scrollback of 36 rows (user seed + 34-row assistant
// block + user tail) — far beyond the 13-row scrollback region, so at follow
// the top rows are offscreen. The test: pin the follow view (top = row-23),
// wheel-UP once (top = row-20 — a previously offscreen row scrolled into
// view), wheel-DOWN once (top = row-23 again), byte budget, exit gate.
// Frame count deterministic: 3 events → 3 frames; 2 wheel frames; frozen
// clock 13_334 keeps the anim pump identical → zero-byte idle.
//
// Errors: any throw → best-effort marker "host-failed" + message → exit 3.

import { execSync } from "node:child_process"
import { existsSync, writeFileSync, mkdirSync, writeSync } from "node:fs"
import { join } from "node:path"
import { createRenderer, createTerminal, createUnknownCapabilities, makeGlyphs, resolvePalette, InputParser } from "@i-harness/tui-core"
import type { TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { TuiApp, createScrollbackEngine } from "../../src/index.ts"
import type { BackendClient, InputSource, TuiEvent } from "../../src/index.ts"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const MARKER_DIR = process.argv[2] ?? ""
const m = /^(\d+)x(\d+)$/.exec(process.argv[3] ?? "")
const size = m !== null ? { cols: Number(m[1]), rows: Number(m[2]) } : { cols: 46, rows: 24 }
const TUI_FROZEN_NOW = 13_334

function marker(name: string): void {
  mkdirSync(MARKER_DIR, { recursive: true })
  writeFileSync(`${MARKER_DIR}/${name}`, `${Date.now()}`)
}

/** Host-side poll on its own markers (the fs channel in reverse: the host
 * waits for the test's exit gate). */
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

/** writeSync sibling (host-011 parity): every host stdout byte passes here;
 * <markerDir>/bytes + <markerDir>/writes feed `assert-byte-budget`. */
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

// ------------------------------------------------------------------ scene events

/** Deterministic event script: user seed + ONE assistant block of 25 rows
 * (multi-line text — markdownRows falls back to plain rows per line) +
 * turn/end (clears the turn row — the scrollback region is 13 rows tall) +
 * a user tail block. Total display lines: 1 + 25 + 0 + 1 = 27.
 * Viewport math (46x24, scrollback region rows 2..14 · h=13):
 *   follow off = 27-13+1 = 15 → top row-15 (last 12 lines + 1 empty slot);
 *   wheel-up  = clamp-max(27-24+1=4) - 3 = 1 → top row-1 (previously offscreen);
 *   wheel-down = 1+3 = 4 → top row-4. */
function sceneEvents(): TuiEvent[] {
  const body = Array.from({ length: 25 }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`).join("\n")
  return [
    { type: "user", text: "seed the scrollback", seq: 1, ts: 0 },
    { type: "assistant", text: body, seq: 2, ts: 100 },
    { type: "turn", phase: "end", seq: 3, ts: 200 },
    { type: "user", text: "tail marker", seq: 4, ts: 300 },
  ]
}

function scriptedBackend(events: TuiEvent[]): BackendClient {
  return {
    async *events(): AsyncIterable<TuiEvent> {
      for (const ev of events) {
        await sleep(800)
        yield ev
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

// ------------------------------------------------------------------ input

/** host-017 parity: raw stdin → REAL tui-core InputParser → queue (+40ms lone
 * ESC drain); TuiApp.input pump consumes it. The pty-master mouse bytes land
 * here verbatim (1006 `<b;x;yM` → wheel events). */
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

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  execSync("chcp.com 65001>NUL", { stdio: "ignore" })

  const terminal = createTerminal({
    stream: { write: (s: string): boolean => { out(s); return true } },
    cap,
  })
  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols })
  const events = sceneEvents()
  const backend = scriptedBackend(events)
  const input = wireInput()

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
    input: input.source,
  })

  terminal.init()
  // NOT awaited (host-017 parity): pumpInput stays alive for the test's wheel
  // bytes, so start() would never resolve — the exit gate below is the flow.
  void app.start()
  // The scripted backend ends after the events; the input pump stays alive
  // for the test's wheel bytes. Exit gate: the test's fs marker.
  await pollMarker("request-exit")
  input.endInput()
  await sleep(300) // consume any final frame
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
