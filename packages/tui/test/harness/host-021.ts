// M49 Task 6: PTY host for case-021 — the Models & Providers flow at real-pty
// level over the CANONICAL plane. The host drives the REAL app loop + the
// REAL stdin path: the settings store is REAL (temp dir), the credential
// store is REAL (temp), the provider runtime is REAL with the DISCOVERY
// PROBE INJECTED (a fake returning two DeepSeek models — NO real network in
// CI) and an INJECTED buildClient that RECORDS the request and streams the
// literal `fixture response`.
//
// Flow: /settings → Models & Providers → provider main/detail (deepseek
// editor: prefilled id/url, key typed → masked; empty keep-current is NOT
// exercised here) → save → discovery (injected) → models catalog (manual
// deepseek-chat + discovered deepseek-reasoner) → select deepseek-reasoner
// (the DISCOVERED model) → close Settings → submit `hello` → the injected
// client's literal `fixture response` lands on screen. Host-side witnesses:
// the REAL settings document snapshot (canonical llm.providers + defaultModel
// — refs NOT values, NO tui.providers) + the request the client received.
//
// Errors: any throw → best-effort marker "host-failed" + message → exit 3.

import { setUtf8CodePage } from "./codepage.ts"
import { existsSync, mkdirSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { createRenderer, createTerminal, createUnknownCapabilities, makeGlyphs, resolvePalette, InputParser } from "@i-harness/tui-core"
import type { TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { SettingsStore } from "@i-harness/settings"
import { createCredentialStore } from "@i-harness/credentials"
import { createProviderRegistry } from "@i-harness/provider"
import { createProviderRuntime } from "@i-harness/provider-runtime"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"
import { ProviderController, TuiApp, createScrollbackEngine, defaultEmbeddedFactory } from "../../src/index.ts"
import type { BackendClient, InputSource } from "../../src/index.ts"

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

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  setUtf8CodePage()

  const terminal = createTerminal({ stream: { write: (s: string): boolean => { out(s); return true } }, cap })
  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols })
  const input = wireInput()

  // REAL settings + credentials over a temp dir. The bootstrap document is
  // written upfront: the canonical plane (llm.providers + llm.defaultModel)
  // — the file starts canonical (the controller flow below only ever writes
  // the canonical plane).
  const settingsPath = join(MARKER_DIR, "settings.json")
  const credsPath = join(MARKER_DIR, "credentials.json")
  writeFileSync(settingsPath, JSON.stringify({
    tui: { prefs: {} },
    llm: {
      providers: {
        deepseek: {
          baseURL: "https://api.deepseek.com",
          protocol: "openai-completions",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
        },
      },
      defaultModel: { provider: "deepseek", model: "deepseek-chat" },
    },
  }))
  const settings = new SettingsStore({ path: settingsPath })
  await settings.load()
  const credentials = createCredentialStore(credsPath)
  await credentials.set("DEEPSEEK_API_KEY", "sk-dummykey-123456")

  // The injected client: records the request (the literal user text) and
  // streams the literal `fixture response`. NO real model, no network.
  const requests: LLMRequest[] = []
  const fixtureClient = {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      requests.push(request)
      writeFileSync(join(MARKER_DIR, "client-request.json"), JSON.stringify({
        prompt: (request.messages.find((msg) => msg.role === "user")?.content as string) ?? "",
      }))
      marker("client-request")
      yield { type: "text/chunk", text: "fixture response" }
      yield { type: "end" }
    },
  }

  // The discovery probe is the INJECTED boundary (no CI network).
  const registry = createProviderRegistry()
  registry.registerProbe("deepseek", async () => [
    { id: "deepseek-chat", name: "DeepSeek Chat", owned_by: "deepseek" },
    { id: "deepseek-reasoner", name: "DeepSeek R1", owned_by: "deepseek" },
  ])

  const providerRuntime = createProviderRuntime({
    settings,
    credentials,
    registry,
    buildClient: () => fixtureClient,
  })

  writeFileSync(`${MARKER_DIR}/settings-path`, settingsPath)
  writeFileSync(`${MARKER_DIR}/credentials-path`, credsPath)
  marker("scene-ready")

  // Host-side state witnesses: poll the DURABLE store (the UI's writes land
  // here) and write the snapshot the yaml/test asserts byte-exact (canonical
  // plane only — the legacy section must NEVER reappear).
  let snapshotWritten = false
  const watcher = setInterval(() => {
    const doc = settings.get()
    // The seed's default is deepseek-chat; the flow's model selection picks
    // the DISCOVERED deepseek-reasoner — that is the snapshot moment (the
    // flow wrote the canonical plane: provider rows, discovery merge, the
    // selected default — and never the legacy section).
    const dm = doc.llm.defaultModel
    if (dm.provider === "deepseek" && dm.model === "deepseek-reasoner" && !snapshotWritten) {
      writeFileSync(`${MARKER_DIR}/settings-doc-snapshot.json`, JSON.stringify(doc, null, 2))
      writeFileSync(`${MARKER_DIR}/llm-section-snapshot.json`, JSON.stringify(doc.llm, null, 2))
      snapshotWritten = true
      marker("provider-saved")
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

  // The embedded backend (the REAL session service) with the runtime-backed
  // model binding — the app submits through it and the injected client
  // answers with the literal fixture response.
  const backend: BackendClient = await defaultEmbeddedFactory({
    workspace: MARKER_DIR,
    prompt: "",
    modelPolicy: "required",
    modelBindingFor: async (_sessionId, meta) => {
      const state = await providerRuntime.resolveModel({
        ...(meta?.modelSelection !== undefined
          ? { sessionSelection: meta.modelSelection }
          : {}),
      })
      if (state.status !== "ready") return state
      const { client, ...binding } = state.binding
      return { status: "ready", binding: { model: client, ...binding } }
    },
    approveAll: true,
  })
  const providerController = new ProviderController({
    runtime: providerRuntime,
    settings,
    backend,
  })

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
    providerController,
  })

  terminal.init()
  void app.start()
  await pollMarker("request-exit")
  clearInterval(watcher)
  input.endInput()
  await sleep(300) // consume any final frame
  if (requests.length > 0) {
    writeFileSync(join(MARKER_DIR, "client-request-final.json"), JSON.stringify({
      prompt: (requests[requests.length - 1]!.messages.find((msg) => msg.role === "user")?.content as string) ?? "",
    }))
  }
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
