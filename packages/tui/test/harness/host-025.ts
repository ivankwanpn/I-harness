// M49 Task 7: PTY host for case-025 — the grapheme-safe prompt editor + the
// VISIBLE terminal cursor proof.
// EXACTLY the case-016/024 fullscreen pipeline (TuiApp + ScrollbackEngine +
// present + renderer.commit/flush → writeSync(1); capability/clock discipline
// identical: fixed cap truecolor, frozen now 44_444, write-sink ledger) PLUS
// the host-024 keyboard wiring (InputParser on stdin with the 40ms drain —
// the CASE types through the REAL parser → loop.onInput → PromptEditor →
// syncPrompt → frame).
//
// The backend is the legacy-stub shape (modelState "session-model
// unavailable" → the pre-M49 agent fallback — no model gate) + listSessions
// (F3 opens the sessions picker — the modal open/close cursor-visibility
// proof).

import { setUtf8CodePage } from "./codepage.ts"
import { existsSync, mkdirSync, readdirSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { createRenderer, createTerminal, createUnknownCapabilities, InputParser, makeGlyphs, resolvePalette } from "@i-harness/tui-core"
import type { InputEvent, TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp, createScrollbackEngine } from "../../src/index.ts"
import type { BackendClient, InputSource, TuiEvent } from "../../src/index.ts"
import { unsupportedSessionManagement } from "../backend-stub.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const MARKER_DIR = process.argv[2] ?? ""
const match = /^(\d+)x(\d+)$/.exec(process.argv[3] ?? "")
const size = match === null ? { cols: 100, rows: 30 } : { cols: Number(match[1]), rows: Number(match[2]) }

function marker(name: string): void {
  mkdirSync(MARKER_DIR, { recursive: true })
  writeFileSync(join(MARKER_DIR, name), String(Date.now()))
}

let epipe = false
let totalBytes = 0
let totalWrites = 0

function out(data: string): void {
  if (epipe) return
  try {
    writeSync(1, data)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") epipe = true
    else throw error
  }
  totalBytes += Buffer.byteLength(data)
  totalWrites++
  writeFileSync(join(MARKER_DIR, "bytes"), String(totalBytes))
  writeFileSync(join(MARKER_DIR, "writes"), String(totalWrites))
}

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

function wireInput(): { source: InputSource; close(): void } {
  const parser = new InputParser()
  const queue: InputEvent[] = []
  let wake: (() => void) | undefined
  let closed = false
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const push = (event: InputEvent): void => {
    queue.push(event)
    wake?.()
  }
  process.stdin.setRawMode?.(true)
  process.stdin.on("data", (chunk: unknown) => {
    const data = typeof chunk === "string"
      ? chunk
      : chunk instanceof Uint8Array
        ? chunk
        : new Uint8Array(0)
    for (const event of parser.push(data, cap)) push(event)
    if (drainTimer !== undefined) clearTimeout(drainTimer)
    drainTimer = setTimeout(() => {
      drainTimer = undefined
      for (const event of parser.drain()) push(event)
    }, 40)
  })
  return {
    source: {
      async *next(): AsyncIterable<InputEvent> {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!
          if (closed) return
          await new Promise<void>((resolve) => { wake = resolve })
        }
      },
    },
    close() {
      closed = true
      wake?.()
      wake = undefined
    },
  }
}

function scriptedBackend(): BackendClient {
  let closed = false
  let wake: (() => void) | undefined
  return {
    ...unsupportedSessionManagement,
    listSessions: async () => [],
    open: async () => {},
    submit: async () => {},
    steer: async () => {},
    cancel: async () => {},
    async *events(): AsyncIterable<TuiEvent> {
      while (!closed) await new Promise<void>((resolve) => { wake = resolve })
    },
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {
      closed = true
      wake?.()
      wake = undefined
    },
  }
}

async function pollMarker(name: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(join(MARKER_DIR, name))) {
    if (Date.now() >= deadline) throw new Error(`host poll: marker "${name}" never appeared`)
    await sleep(50)
  }
}

async function main(): Promise<void> {
  setUtf8CodePage()
  const terminal = createTerminal({ stream: { write: (data: string): boolean => { out(data); return true } }, cap })
  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols })
  const input = wireInput()
  const backend = scriptedBackend()
  const app = new TuiApp({
    renderer,
    backend,
    engine,
    capabilities: cap,
    palette: resolvePalette(cap),
    glyphs: makeGlyphs(true),
    input: input.source,
    listSessions: () => backend.listSessions(),
    write: out,
    now: () => 44_444,
  })

  terminal.init()
  // The pumps run for the whole keyboard scene; the test drives the pace
  // (start() resolving needs BOTH iterators to end — the input/backend close
  // only at the exit request below).
  void app.start()
  await sleep(300) // the first frame (agent screen) settles
  marker("app-start")
  // Resize channel (host-015 parity — the ConPTY child never observes the
  // master resize): the test's `app-resize` step writes req-resize-<c>x<r>
  // into the marker dir; this poll applies the SAME app.setSize + the
  // renderer resize (the production path) and acks host-ack-<c>x<r>).
  let lastC = size.cols
  let lastR = size.rows
  const resizeTo = (c: number, r: number): void => {
    if (c === lastC && r === lastR) return
    lastC = c
    lastR = r
    renderer.resize(c, r)
    app.setSize(c, r)
    app.frame() // the post-resize full-paint — the cursor re-asserted NOW
    marker(`host-ack-${c}x${r}`)
  }
  const fsResize = setInterval(() => {
    try {
      for (const e of readdirSync(MARKER_DIR)) {
        const m = /^req-resize-(\d+)x(\d+)$/.exec(e)
        if (m !== null && m !== undefined) {
          resizeTo(Number(m[1]), Number(m[2]))
          writeFileSync(join(MARKER_DIR, e), "done")
        }
      }
    } catch { /* marker dir may be mid-creation */ }
  }, 50)
  // The keyboard scene runs on the TEST side; this host stays up until the
  // test requests the exit (the same fs channel the runner's steps use).
  await pollMarker("request-exit")
  clearInterval(fsResize)
  input.close()
  await backend.close()
  await app.stop()
  terminal.teardown()
  marker("teardown-wrote")
  process.exit(0)
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    try {
      marker("host-failed")
      writeFileSync(join(MARKER_DIR, "host-failed-message"), String(error))
    } catch {}
    process.exit(3)
  },
)
