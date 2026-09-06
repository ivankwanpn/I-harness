import { setUtf8CodePage } from "./codepage.ts"
import { existsSync, mkdirSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import {
  createRenderer,
  createTerminal,
  createUnknownCapabilities,
  InputParser,
  makeGlyphs,
  resolvePalette,
} from "@i-harness/tui-core"
import type { InputEvent, TerminalCapabilityContext } from "@i-harness/tui-core"
import { createCredentialStore } from "@i-harness/credentials"
import { SettingsStore } from "@i-harness/settings"
import { createProviderRegistry } from "@i-harness/provider"
import { createProviderRuntime } from "@i-harness/provider-runtime"
import { ProviderController, TuiApp, createScrollbackEngine } from "../../src/index.ts"
import type { BackendClient, InputSource, TuiEvent } from "../../src/index.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const MARKER_DIR = process.argv[2] ?? ""
const match = /^(\d+)x(\d+)$/.exec(process.argv[3] ?? "")
const size = match === null ? { cols: 80, rows: 24 } : { cols: Number(match[1]), rows: Number(match[2]) }

function marker(name: string): void {
  mkdirSync(MARKER_DIR, { recursive: true })
  writeFileSync(join(MARKER_DIR, name), String(Date.now()))
}

async function pollMarker(name: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(join(MARKER_DIR, name))) {
    if (Date.now() >= deadline) throw new Error(`host poll: marker "${name}" never appeared`)
    await sleep(50)
  }
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

function unconfiguredBackend(): BackendClient {
  let closed = false
  let wake: (() => void) | undefined
  return {
    listSessions: async () => [],
    open: async () => {},
    createSession: async () => {
      marker("unexpected-create")
      return "unexpected"
    },
    forkSession: async () => "unexpected-fork",
    modelState: async () => ({ status: "unconfigured", reason: "No model configured" }),
    setSessionModel: async () => ({ status: "unconfigured", reason: "No model configured" }),
    submit: async (prompt) => {
      writeFileSync(join(MARKER_DIR, "submission"), prompt)
    },
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

async function main(): Promise<void> {
  setUtf8CodePage()
  const terminal = createTerminal({ stream: { write: (data: string): boolean => { out(data); return true } }, cap })
  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols })
  const input = wireInput()
  const backend = unconfiguredBackend()
  const settings = new SettingsStore({ path: join(MARKER_DIR, "settings.json") })
  await settings.load()
  const runtime = createProviderRuntime({
    settings,
    credentials: createCredentialStore(join(MARKER_DIR, "credentials.json")),
    registry: createProviderRegistry(),
  })
  const providerController = new ProviderController({ runtime, settings })
  const app = new TuiApp({
    renderer,
    backend,
    engine,
    capabilities: cap,
    palette: resolvePalette(cap),
    glyphs: makeGlyphs(true),
    input: input.source,
    providerController,
    listSessions: () => backend.listSessions(),
    write: out,
    now: () => 44_444,
  })

  terminal.init()
  await app.initialize({ renderWelcomeBeforeModel: true })
  const running = app.start()
  await sleep(20)
  marker("scene-ready")

  await pollMarker("request-exit")
  input.close()
  await backend.close()
  await running
  await app.stop()
  terminal.teardown()
  marker("teardown-wrote")
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
