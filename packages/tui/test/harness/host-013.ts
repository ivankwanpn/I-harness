// M37b G4: PTY host for case-013 — the PERMISSION OVERLAY scene (spec §3.7)
// across a real pty. After a 500ms settle the host builds the overlay state
// DIRECTLY through the production seam (app.state().overlay =
// bindPermissionOverlay(...)) + marker "overlay-p1", so the modal's draw and
// the key-press routing (j/k cursor, 1-9 accept) all go through the REAL
// G1↔G2 binder + loop dispatch.
//
// The seam's onDecision writes the record to <markerDir>/answered (JSON) +
// marker "answered"; onClose clears the overlay (modal gone frame). The
// scripted backend stays quiet (approvals() never fires — the modal is the
// DIRECT seam path, which is exactly what the wheel exposes; the bridge's
// stream round-trip is unit-covered in approval.test.ts).
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
import { TuiApp, bindPermissionOverlay, createScrollbackEngine } from "../../src/index.ts"
import type { BackendClient, InputSource, PermissionSurface, PermissionState, TuiEvent } from "../../src/index.ts"

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

/** writeSync ledger (host-011 parity): <markerDir>/bytes + /writes for
 * `assert-byte-budget`. */
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

// ------------------------------------------------------------------ input

/** Host-012 parity: raw stdin → REAL tui-core InputParser → queue (+40ms
 * lone-ESC drain); TuiApp.input pump consumes it. */
function wireInput(): { source: InputSource } {
  const parser = new InputParser()
  const queue: InputEvent[] = []
  let wake: (() => void) | undefined
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
        await new Promise<void>((res) => { wake = res })
      }
    },
  }
  return { source }
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

  /** Quiet backend: no events ever (the modal is the direct seam path); the
   * pump stays alive on the never-yielding generator. */
  const backend: BackendClient = {
    async *events(): AsyncIterable<TuiEvent> {
      await new Promise<void>(() => {})
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

  terminal.init()
  void app.start() // never resolves — the host exits after the decision

  await sleep(500) // settle (frame 1 pinned by the test)

  // === scene 013: build the permission overlay through the PRODUCTION seam ===
  const surf: PermissionSurface = {
    id: "p1",
    kind: "bash",
    title: "echo hi",
    detail: "running bash: echo hi",
    scopes: ["command"],
    freeform: true,
  }
  const state: PermissionState = { cursor: 0, scopeIndex: 0, freeformText: "" }
  let decided: (() => void) | undefined
  const done = new Promise<void>((res) => { decided = res })
  app.state().overlay = bindPermissionOverlay(surf, state, {
    onDecision: (d) => {
      // NOTE: the decision record must NOT reuse the marker's file name
      // (marker("answered") would overwrite it) — separate `decision.json`.
      writeFileSync(`${MARKER_DIR}/decision.json`, JSON.stringify(d))
      marker("answered")
      decided?.()
    },
    onClose: () => {
      app.state().overlay = undefined
      app.dispatch("none")
    },
  })
  marker("overlay-p1")
  app.dispatch("none") // draw the modal (frame 2)

  await done
  await sleep(300) // modal-gone frame + settle
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
