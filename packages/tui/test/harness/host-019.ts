// M40 G2 (C13): PTY host for case-019 — the PLAN-REVIEW adapt.
// EXACTLY the case-018 pipeline (host-016 fullscreen + host-017 real stdin
// wireInput): the test drives `a`/`c`/`q` through the pty master and the
// production path handles them (plan bar → shortcuts; keys → steer/prefill).
//
// Scene "019" (46x24): plan/mode on → user "plan the work" → assistant
// "Plan:\n1. step one\n2. step two" → turn/end. After the turn the app is
// idle with plan mode on and the LAST display line in an Assistant block —
// planReviewActive() → the shortcuts bar shows `a approve / c comment /
// q quit plan` and `a`/`c`/`q` route (empty prompt): `a` steers
// "Approved — proceed" (record-steer-1.json + marker), `c` prefills
// "comment: ", `q` steers "quit plan mode" (record-steer-2.json + marker).
// Frame count deterministic: 4 event frames + 3 key frames; frozen clock
// 13_334 keeps the anim pump identical → zero-byte idle (the toasts render
// once each — they never expire under the frozen clock and stay identical).
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

/** writeSync(1) sink + ledger — host-011 parity. */
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

// ------------------------------------------------------------------ scene

/** Deterministic plan-mode stream: plan on → user prompt → assistant plan
 * (ordered list — the plan block) → turn/end (idle after). */
function sceneEvents(): TuiEvent[] {
  return [
    { type: "plan", phase: "on", seq: 1, ts: 0 },
    { type: "user", text: "plan the work", seq: 2, ts: 100 },
    { type: "assistant", text: "Plan:\n1. step one\n2. step two", seq: 3, ts: 200 },
    { type: "turn", phase: "end", seq: 4, ts: 300 },
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
    steer: async (text: string) => {
      // The plan keys' record: what the production path steered.
      const n = 1 + Number(existsSync(`${MARKER_DIR}/record-steer-1.json`))
      writeFileSync(`${MARKER_DIR}/record-steer-${n}.json`, JSON.stringify({ text }))
      marker(`steered-${n}`)
    },
    cancel: async () => {},
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
  }
}

// ------------------------------------------------------------------ input

/** host-017 parity: raw stdin → REAL tui-core InputParser → queue; the pty
 * master's keystrokes land here verbatim. */
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
  const backend = scriptedBackend(sceneEvents())
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
  // NOT awaited (host-018 parity): the input pump stays alive for the test's
  // plan keys; the exit gate below is the flow.
  void app.start()
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
