// M37b G4: PTY host for case-012 — the REAL-KEY interaction scene across a
// real pty (host-011's scene is event-driven only; THIS one is input-driven).
//
// The host spawns as the child of a real ConPTY with the SAME deterministic
// app pipeline (fixed truecolor caps, frozen clock, one frame per state
// change, write-sink marker + byte/write ledger) PLUS a live KEYBOARD: stdin
// is put into raw mode and pushed through the REAL tui-core InputParser
// (same input path as apps/tui: parser → queue → TuiApp.input pump), so
// every key the TEST writes into the pty becomes a real key event. A 40ms
// drain timer resolves a lone ESC (the parser's one time-resolvable state —
// like a real terminal, conjured deterministically).
//
// Scene "012" (scripted submit-aware backend):
//   batch 1 on open: user "hello" → assistant "hi there" → turn end.
//   submit(text):   marker "submitted-2", releases batch 2:
//                   assistant "world" → turn end (marker "turned-2").
//   The events generator then parks on a never-resolving await — the app
//   stays alive until the app's QUIT path (backend.close → endInput →
//   stop()) resolves start(), then the host tears down and exits 0.
//
// Errors: any throw → best-effort marker "host-failed" + message → exit 3.

import { execSync } from "node:child_process"
import { writeFileSync, writeSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  createRenderer,
  createTerminal,
  createUnknownCapabilities,
  makeGlyphs,
  resolvePalette,
  InputParser,
} from "@i-harness/tui-core"
import type { InputEvent, TerminalCapabilityContext } from "@i-harness/tui-core"
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

let epipe = false
let totalBytes = 0
let totalWrites = 0

/** writeSync ledger (host-011 parity): every host cout byte passes here;
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

// ------------------------------------------------------------------ backend

/** Submit-aware scripted backend: batch 1 paced on open; batch 2 released by
 * submit() (marker "submitted-2" → assistant "world" + turn end → marker
 * "turned-2"); then parks on `closed` — the app's QUIT path closes the backend
 * (endInput + release), so both pumps end and start() resolves. */
function scriptedBackend(onClose: () => void): BackendClient {
  let release2: (() => void) | undefined
  let releaseClosed: (() => void) | undefined
  const batch2 = new Promise<void>((res) => { release2 = res })
  const closedP = new Promise<void>((res) => { releaseClosed = res })
  return {
    async *events(): AsyncIterable<TuiEvent> {
      await sleep(250)
      yield { type: "user", text: "hello", seq: 1, ts: 0 }
      await sleep(200)
      yield { type: "assistant", text: "hi there", seq: 2, ts: 100 }
      await sleep(120)
      yield { type: "turn", phase: "end", seq: 3, ts: 200 }
      await batch2
      await sleep(120)
      yield { type: "assistant", text: "world", seq: 4, ts: 300 }
      await sleep(120)
      yield { type: "turn", phase: "end", seq: 5, ts: 400 }
      marker("turned-2")
      await closedP // park until close() — the app's quit path
    },
    listSessions: async () => [],
    open: async () => {},
    submit: async () => {
      marker("submitted-2")
      release2?.()
      release2 = undefined
    },
    steer: async () => {},
    cancel: async () => {},
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    async close() {
      releaseClosed?.()
      releaseClosed = undefined
      onClose()
    },
  }
}

// ------------------------------------------------------------------ input

/** InputParser + queue + 40ms lone-ESC drain (apps/tui's attachInput is the
 * same parser, minus the drain — under a real terminal the ESC timeout
 * resolves the pending sequence; here it is a deterministic timer). */
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
  const input = wireInput()
  const backend = scriptedBackend(input.endInput)

  /** Dev aid: TUI_DUMP_DIR=<dir> writes <frame-N>.txt rows for the yaml authors. */
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
    input: input.source,
    now: () => TUI_FROZEN_NOW,
  })

  // Safety net: a stalled scene exits 4 (the test's wait-exit expects 0).
  const stall = setTimeout(() => {
    try { marker("host-stalled") } catch { /* best effort */ }
    process.exit(4)
  }, 90_000)

  terminal.init()
  await app.start() // resolves ONLY via the app quit path (close → endInput)
  clearTimeout(stall)

  await sleep(300)
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
