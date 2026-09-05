// M46a G2: PTY host for case-022 — the slash registry + keys truth at
// REAL-PTY level (spec §2): Ctrl+S stash/pop round-trip, /theme cycles,
// /timestamps rows, /find search bar, /history panel, /skills panel (REAL
// skills registry over a temp workspace with a real SKILL.md), /usage panel.
// The host wires the REAL app pipeline + the real tui-core InputParser (raw
// stdin → parser → queue), a scripted two-event stream (a user/assistant turn
// for the scrollback + the find target), the REAL scrollback engine and a
// backend.context stub (used 42 / total 1000 — the /usage panel numbers).
//
// Frame count deterministic: frozen clock 13_334; every key is scripted.
// Errors: throw → marker "host-failed" + message → exit 3.

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRenderer, createTerminal, createUnknownCapabilities, makeGlyphs, resolvePalette, InputParser } from "@i-harness/tui-core"
import type { TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { TuiApp, createScrollbackEngine } from "../../src/index.ts"
import type { BackendClient, InputSource, TuiEvent } from "../../src/index.ts"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const MARKER_DIR = process.argv[2] ?? ""
const m = /^(\d+)x(\d+)$/.exec(process.argv[3] ?? "")
const size = m !== null ? { cols: Number(m[1]), rows: Number(m[2]) } : { cols: 80, rows: 24 }
const TUI_FROZEN_NOW = 13_334

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

/** The scripted 3-event stream: one user/assistant turn (the scrollback +
 * the /find "hi" target) then holds for the exit gate. */
async function* sceneEvents(): AsyncIterable<TuiEvent> {
  yield { type: "turn", phase: "start", seq: 0, ts: 400 }
  yield { type: "user", text: "hi there", seq: 1, ts: 500 }
  yield { type: "assistant", text: "ok", seq: 2, ts: 600 }
  yield { type: "turn", phase: "end", seq: 3, ts: 700 }
  for (;;) {
    await new Promise<void>(() => {}) // hold until the exit gate
  }
}

/** The fake backend — scripted stream + the /usage context stub. */
function scriptedBackend(): BackendClient {
  return {
    async *events(): AsyncIterable<TuiEvent> {
      for await (const ev of sceneEvents()) yield ev
    },
    listSessions: async () => [],
    open: async () => {},
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    context: async () => ({ used: 42, total: 1000 }),
    close: async () => {},
  }
}

// ------------------------------------------------------------------ input

/** host-017 parity: raw stdin → REAL tui-core InputParser → queue. */
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

  const terminal = createTerminal({ stream: { write: (s: string): boolean => { out(s); return true } }, cap })
  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols })
  const input = wireInput()

  // Temp workspace with a REAL skill (the /skills registry scan target).
  const workspace = mkdtempSync(join(tmpdir(), "i-harness-tui-022-ws-"))
  mkdirSync(join(workspace, "skills", "hello"), { recursive: true })
  writeFileSync(
    join(workspace, "skills", "hello", "SKILL.md"),
    "---\nname: hello\ndescription: Say hi\n---\n# hello\n\nbody\n",
  )
  writeFileSync(`${MARKER_DIR}/workspace-dir`, workspace)
  marker("scene-ready")
  marker("events-seeded") // the stream is constructed upfront; the app consumes it at start

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
    backend: scriptedBackend(),
    engine,
    capabilities: cap,
    palette: resolvePalette(cap, "groknight"),
    glyphs: makeGlyphs(true),
    workspace,
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
