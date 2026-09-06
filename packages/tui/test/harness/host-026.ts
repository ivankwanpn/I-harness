// M49 Task 10: PTY host for case-026 — TYPED TOOL BLOCKS at real-pty level.
// The host drives the REAL app pipeline over the REAL embedded session service
// (defaultEmbeddedFactory) with a SCRIPTED model (the injected llm-mock client,
// harness opt-in) talking to the REAL fs tools (read / edit / apply_patch) and
// the REAL resolved shell (bash). The stream reaches the engine through the
// production bridge (embedded.ts mapSessionEvent → events() → TuiApp), so
// every unit under test — typed headers, running→done updates, the structured
// change's (+A/-D) delta + expanded hunk lines, the raw viewer, copy feedback
// and the secret-redaction red line — is the production path.
//
// Determinism: capability/clock discipline identical to host-023 (fixed cap
// truecolor, frozen now 44_444, write-sink ledger + frame markers). The mock
// script's four tool calls run through the REAL tools, so fs/shell latency
// varies; the host writes deterministic markers (bash-running / bash-done /
// copied / settle) from an engine-state watcher, and the scene's cell polls
// absorb the frame-scheduling jitter.
//
// Secret redaction: the bash call's args carry `apiKey: "sk-case-026-secret"`
// — the scene asserts the value NEVER reaches any surface (typed headers,
// block bodies, the raw viewer, the copied payload).
//
// Errors: any throw → best-effort marker "host-failed" + message → exit 3.

import { setUtf8CodePage } from "./codepage.ts"
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { createRenderer, createTerminal, createUnknownCapabilities, InputParser, makeGlyphs, resolvePalette } from "@i-harness/tui-core"
import type { TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { TuiApp, createScrollbackEngine, defaultEmbeddedFactory } from "../../src/index.ts"
import type { BackendClient, InputSource } from "../../src/index.ts"
import type { Clipboard } from "../../src/app/clipboard.ts"
import { createMockClient } from "@i-harness/llm-mock"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const MARKER_DIR = process.argv[2] ?? ""
const m = /^(\d+)x(\d+)$/.exec(process.argv[3] ?? "")
const size = m !== null ? { cols: Number(m[1]), rows: Number(m[2]) } : { cols: 100, rows: 30 }
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

async function main(): Promise<void> {
  setUtf8CodePage()

  const terminal = createTerminal({ stream: { write: (s: string): boolean => { out(s); return true } }, cap })
  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols })
  const input = wireInput()

  // The workspace fixture: data.txt with the three fixture lines.
  const workspace = join(MARKER_DIR, "ws")
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, "data.txt"), "alpha\nBETA\nomega\n", "utf8")

  /** The RECORDER clipboard (spec §7 hard rule — the injected-copy path). */
  const clipboard: Clipboard = {
    copy: (text: string): void => {
      writeFileSync(`${MARKER_DIR}/clipboard.json`, text)
      marker("copied")
    },
  }

  // The scripted model (the REAL llm-mock one-shot cassette — destructive, one
  // step per stream call): step 1 = four REAL tool calls (read the fixture,
  // edit alpha→ALPHA, apply a patch BETA→GAMMA, run the resolved shell
  // `echo resolved-shell` with a secret-carrying arg), step 2 = the final
  // assistant text. The apiKey rides the bash args — the redaction red line.
  const mockClient = createMockClient([
    {
      role: "assistant",
      toolCalls: [
        { name: "read", args: { path: "data.txt" } },
        { name: "edit", args: { path: "data.txt", old_string: "alpha", new_string: "ALPHA" } },
        { name: "apply_patch", args: { patch_content: "*** Begin Patch\n*** Update File: data.txt\n@@\n-BETA\n+GAMMA\n*** End Patch\n" } },
        { name: "bash", args: { command: "sleep 1; echo resolved-shell", apiKey: "sk-case-026-secret" } },
      ],
    },
    { role: "assistant", text: "done" },
  ])

  // The REAL embedded service (scripted model through the real assembly):
  // the app's modelState must be ready, so the model arrives through the
  // production model-binding seam (test-mock policy alone would leave
  // modelState unconfigured — the mock client is injected instead).
  const backend: BackendClient = await defaultEmbeddedFactory({
    workspace,
    prompt: "",
    modelPolicy: "required",
    modelBindingFor: async () => ({
      status: "ready",
      binding: {
        model: mockClient,
        providerId: "mock",
        modelId: "mock-story",
        label: "mock:mock-story",
      },
    }),
    approveAll: true,
  })
  marker("backend-ready")

  let frameN = 0
  function dumpRows(n: number): void {
    const dumpDir = process.env.TUI_DUMP_DIR
    if (dumpDir === undefined || dumpDir === "") return
    const inner = renderer as unknown as { db: { front: { cells: Array<{ text: string }>; width: number } } }
    const { cells, width } = inner.db.front
    if (cells.length === 0) return
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
    palette: resolvePalette(cap, "groknight"),
    glyphs: makeGlyphs(true),
    clipboard,
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
  void app.start().catch(() => {})
  await pollMarker("backend-ready")
  marker("scene-026-ready")

  // Engine-state watcher: fs/shell latency is free — the scene waits on:
  //   bash-running — the Run header is on screen but the result is not,
  //   bash-done    — the result text landed,
  //   settle       — the whole turn is on screen (the final assistant row).
  const tailText = (): string => {
    const total = engine.lineCount()
    if (total === 0) return ""
    const vp = engine.viewport(Math.max(0, total - 40), 40)
    return vp.map((l) => l.runs.map((r) => r.text).join("")).join("\n")
  }
  let firedRun = false
  let firedDone = false
  let firedSettle = false
  const watcher = setInterval(() => {
    const text = tailText()
    const resultJson = '"stdout": "resolved-shell'
    if (!firedRun && text.includes("Run sleep 1; echo resolved-shell") && !text.includes(resultJson)) {
      firedRun = true
      marker("bash-running")
    }
    if (!firedDone && text.includes(resultJson)) {
      firedDone = true
      marker("bash-done")
    }
    if (!firedSettle && text.includes(resultJson) && /(^|\n)done(\n|$)/.test(text)) {
      // the final assistant block ("done") is on screen — turn settled.
      firedSettle = true
      marker("settle")
    }
  }, 25)

  // The workspace fixture witness for the test (the fs tools really edited it).
  const fixtureWatcher = setInterval(() => {
    try {
      const content = readFileSync(join(workspace, "data.txt"), "utf8")
      if (content === "ALPHA\nGAMMA\nomega\n" && !existsSync(`${MARKER_DIR}/ws-final`)) {
        writeFileSync(`${MARKER_DIR}/ws-final`, content)
      }
    } catch {
      /* not yet */
    }
  }, 50)

  await pollMarker("request-exit")
  clearInterval(watcher)
  clearInterval(fixtureWatcher)
  input.endInput()
  await sleep(300) // consume any final frame
  terminal.teardown()
  await backend.close().catch(() => {})
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
