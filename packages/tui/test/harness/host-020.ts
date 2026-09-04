// M43 G2: PTY host for case-020 — the REWIND end-to-end proof (spec §3.9).
// EXACTLY the case-019 pipeline (host-016 fullscreen + host-017 real stdin):
// the test drives Esc/Esc/Enter/a/y through the pty master against the real
// app loop, and the PRODUCTION path (G1's rewind view/binder/loop wiring on
// the BackendClient.rewind bridge) drives the M42 service.
//
// Scene "020" (80x24): temp WORKSPACE dir with `src/data.txt` = "v1"; the
// scripted stream replays two REAL recording turns:
//   turn 1: user "write" → REAL write tool (fs write v2; the M42
//           RewindRecorder captured the "v1" pre-image via take()) → turn end
//   turn 2: user "modify" → REAL write tool (fs write v3; pre "v2") →
//           turn end
// The recorder's finalize() persists BOTH points into a REAL RewindStore
// (`<tmp>/rewind/case-020` — turnIndex 0=write v2, 1=change v3).
//
// Backend rewind = the REAL M42 RewindService on that store (host-wired — the
// embedded bridge is G1's; the host stands for it against the contract):
//   points()/plan()/execute() — execute runs the REAL file restore + the
//   journal truncate, and its appendEvent hook converts the rewind/point
//   marker into the contract TuiEvent { type: "rewind", ... } (targetTurn =
//   store index + 1 → the engine line reads `Rewound to turn 1`).
//
// Rewinding to "turn 1" (store index 0) restores the disk to "v1". Because
// turn 2 overwrote the file AFTER turn 1 ended, the M42 plan honestly marks
// src/data.txt as a "modified" CONFLICT (current disk ≠ the target point's
// afterHash) — grok semantics: execute ANYWAY, marked (the confirm shows the
// `!` warning row). The test asserts (a) disk == "v1" (fs), (b) the scrollback
// `Rewound to turn 1` system row, and the byte-budget + exit 0.
//
// Frame count deterministic: 6 event frames + key frames; frozen clock 13_334.
// Errors: any throw → best-effort marker "host-failed" + message → exit 3.

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRenderer, createTerminal, createUnknownCapabilities, makeGlyphs, resolvePalette, InputParser } from "@i-harness/tui-core"
import type { TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { RewindRecorder, RewindService, RewindStore, type RewindEvent } from "@i-harness/rewind"
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

/** Host-side poll on its own markers (the fs channel in reverse). */
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

interface SceneState {
  store: RewindStore
  recorder: RewindRecorder
  service: RewindService
  workspace: string
  dataTxt: string
  /** Post-scene rewind events (pushed by execute's appendEvent). */
  rewindQueue: TuiEvent[]
  wakeEv: (() => void) | undefined
}

/**
 * The deterministic two-turn stream. The fs writes REALLY happen (temp
 * workspace) and the M42 recorder REALLY captures both points — the stream
 * and the journal stay in lockstep (begin on the user's anchor seq, take at
 * each write, finalize at each turn end).
 */
async function* sceneEvents(s: SceneState): AsyncIterable<TuiEvent> {
  const { recorder, store } = s
  // ── turn 1: "write" → the write tool puts "v2" on disk.
  recorder.begin(1, "write")
  await sleep(800)
  yield { type: "user", text: "write", seq: 1, ts: 0 }
  await sleep(800)
  recorder.take("src/data.txt", new Uint8Array(readFileSync(s.dataTxt)))
  writeFileSync(s.dataTxt, "v2")
  yield { type: "tool", callId: "t1", name: "write", kind: "edit", status: "done", summary: "src/data.txt", output: "wrote v2", seq: 2, ts: 100 }
  await sleep(800)
  const p1 = await recorder.finalize()
  if (p1 !== null) await store.appendPoint(p1)
  yield { type: "turn", phase: "end", seq: 3, ts: 200 }
  await sleep(800)
  // ── turn 2: "modify" → the write tool puts "v3" on disk.
  recorder.begin(4, "modify")
  await sleep(800)
  yield { type: "user", text: "modify", seq: 4, ts: 300 }
  await sleep(800)
  recorder.take("src/data.txt", new Uint8Array(readFileSync(s.dataTxt)))
  writeFileSync(s.dataTxt, "v3")
  yield { type: "tool", callId: "t2", name: "write", kind: "edit", status: "done", summary: "src/data.txt", output: "wrote v3", seq: 5, ts: 400 }
  await sleep(800)
  const p2 = await recorder.finalize()
  if (p2 !== null) await store.appendPoint(p2)
  yield { type: "turn", phase: "end", seq: 6, ts: 500 }
  marker("points-seeded")
  // ── post-scene drain: the rewind event arrives only when the UI's execute
  // lands (the service's appendEvent hooks into rewindQueue).
  let nextSeq = 7
  for (;;) {
    while (s.rewindQueue.length > 0) {
      const ev = s.rewindQueue.shift()!
      yield { ...ev, seq: nextSeq++, ts: 600 }
    }
    await new Promise<void>((res) => { s.wakeEv = res })
  }
}

/** The fake backend — scripted scene stream + REAL M42 rewind bridge. */
function scriptedBackend(s: SceneState): BackendClient {
  const rewind: NonNullable<BackendClient["rewind"]> = {
    points: () => s.service.points(),
    plan: (target, mode) => s.service.plan(target, mode),
    execute: async (target, mode) => {
      const r = await s.service.execute(target, mode, {
        appendEvent: (ev: RewindEvent) => {
          // UI contract: targetTurn is the DISPLAY turn number (the picker
          // row label = store index + 1) → the engine line reads
          // "Rewound to turn 1"; mode rides the contract shape verbatim.
          s.rewindQueue.push({ type: "rewind", targetTurn: ev.targetTurn + 1, mode: ev.mode, seq: 0, ts: 600 })
          s.wakeEv?.()
        },
      })
      // Host-side cues for the test: the execute completed + the disk
      // snapshot at that moment (the byte-exact fs assert lives in the test).
      writeFileSync(`${MARKER_DIR}/rewind-result.json`, JSON.stringify(r))
      writeFileSync(`${MARKER_DIR}/after-rewind-data.txt`, readFileSync(s.dataTxt, "utf8"))
      marker("rewind-executed")
      return r
    },
  }
  return {
    async *events(): AsyncIterable<TuiEvent> {
      for await (const ev of sceneEvents(s)) yield ev
    },
    listSessions: async () => [],
    open: async () => {},
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    rewind,
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

  // Temp workspace + REAL M42 rewind pipeline (store / recorder / service).
  const workspace = mkdtempSync(join(tmpdir(), "i-harness-tui-020-ws-"))
  mkdirSync(join(workspace, "src"), { recursive: true })
  const dataTxt = join(workspace, "src", "data.txt")
  writeFileSync(dataTxt, "v1")
  const store = new RewindStore({ root: mkdtempSync(join(tmpdir(), "i-harness-tui-020-rw-")), sessionId: "case-020" })
  const recorder = new RewindRecorder({ store, workspace })
  const service = new RewindService({ store, workspace })
  const scene: SceneState = { store, recorder, service, workspace, dataTxt, rewindQueue: [], wakeEv: undefined }

  writeFileSync(`${MARKER_DIR}/workspace-dir`, workspace)
  writeFileSync(`${MARKER_DIR}/rewind-store-dir`, store.storeDir)
  marker("scene-ready")

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
    backend: scriptedBackend(scene),
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
  // rewind keys; the exit gate below is the flow.
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
