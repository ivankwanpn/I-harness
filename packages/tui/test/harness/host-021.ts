// M46a G1: PTY host for case-021 — the FULL /provider flow at real-pty level.
// The host drives the REAL app loop + the REAL stdin path: the settings store
// is REAL (temp dir), the credential store is REAL (temp), the ProviderStore
// is REAL with the DISCOVERY FETCH INJECTED (a fake returning two DeepSeek
// models — NO real network in CI).
//
// Flow: /provider → menu → `+ Add provider` → wizard (id=deepseek,
// base=https://api.deepseek.com, key=sk-…DUMMY masked) → save & active →
// discovery (fake) → /model → picker (2 fake models) → select deepseek-chat →
// settings llm.defaultModel patched → /settings → Settings modal → Models
// category → `provider  deepseek` + `default_model  deepseek-chat` rows.
// Host-side markers: the REAL settings document snapshots (section shape —
// refs NOT values) + the default-model adoption record.
//
// Errors: any throw → best-effort marker "host-failed" + message → exit 3.

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { createRenderer, createTerminal, createUnknownCapabilities, makeGlyphs, resolvePalette, InputParser } from "@i-harness/tui-core"
import type { TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { SettingsStore } from "@i-harness/settings"
import { createCredentialStore } from "@i-harness/credentials"
import { TuiApp, ProviderStore, createScrollbackEngine } from "../../src/index.ts"
import type { BackendClient, InputSource, TuiEvent } from "../../src/index.ts"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const MARKER_DIR = process.argv[2] ?? ""
const m = /^(\d+)x(\d+)$/.exec(process.argv[3] ?? "")
const size = m !== null ? { cols: Number(m[1]), rows: Number(m[2]) } : { cols: 80, rows: 24 }
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

/** The quiet backend — no turns in case-021; the events fork never ends
 * (host-020 parity). */
function quietBackend(): BackendClient {
  return {
    async *events(): AsyncIterable<TuiEvent> {
      for (;;) await new Promise((res) => setTimeout(res, 1000))
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
  execSync("chcp.com 65001>NUL", { stdio: "ignore" })

  const terminal = createTerminal({ stream: { write: (s: string): boolean => { out(s); return true } }, cap })
  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols })
  const input = wireInput()

  // REAL settings + credentials + ProviderStore over a temp dir; the fetch is
  // the INJECTED boundary (two fake DeepSeek models — no CI network).
  const settingsPath = join(MARKER_DIR, "settings.json")
  const credsPath = join(MARKER_DIR, "credentials.json")
  const settings = new SettingsStore({ path: settingsPath })
  await settings.load()
  const credentials = createCredentialStore(credsPath)
  const providerStore = new ProviderStore({
    settings,
    credentials,
    fetchFn: (async () => new Response(JSON.stringify({
      data: [
        { id: "deepseek-chat", name: "DeepSeek Chat", owned_by: "deepseek" },
        { id: "deepseek-reasoner", name: "DeepSeek R1", owned_by: "deepseek" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  })

  writeFileSync(`${MARKER_DIR}/settings-path`, settingsPath)
  writeFileSync(`${MARKER_DIR}/credentials-path`, credsPath)
  marker("scene-ready")

  // Host-side state witnesses: poll the DURABLE store (the UI's writes land
  // here) and write the snapshots the yaml/test assert byte-exact.
  let watchedDefault = ""
  const watcher = setInterval(() => {
    const doc = settings.get()
    const dm = doc.llm.defaultModel
    if (dm.provider !== "" && dm.model !== "" && watchedDefault === "") {
      watchedDefault = `${dm.provider}:${dm.model}`
      writeFileSync(`${MARKER_DIR}/default-model.json`, JSON.stringify(doc.llm.defaultModel, null, 2))
      marker("default-model-set")
    }
    const tui = doc.tui
    const deepseek = tui.providers.providers.deepseek
    if (deepseek !== undefined && tui.providers.activeProviderId === "deepseek") {
      if (!existsSync(`${MARKER_DIR}/provider-saved`)) {
        writeFileSync(`${MARKER_DIR}/tui-section-snapshot.json`, JSON.stringify(tui, null, 2))
        writeFileSync(`${MARKER_DIR}/settings-doc-snapshot.json`, JSON.stringify(doc, null, 2))
        marker("provider-saved")
      }
    }
  }, 50)

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
    backend: quietBackend(),
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
    providerStore,
  })

  terminal.init()
  void app.start()
  await pollMarker("request-exit")
  clearInterval(watcher)
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
