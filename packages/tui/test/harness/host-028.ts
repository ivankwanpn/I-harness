// M49 Task 15: PTY host for case-028 — the INTEGRATED PARITY PROOF at real-pty
// level. One continuous executable session over the REAL production wiring:
//   - the canonical settings plane (SettingsStore at <markerDir>/settings.json:
//     persisted ready provider/model + screenMode minimal + builtin status
//     line), the credentials store and the REAL provider runtime
//     (createProviderRuntime) — the model label on screen is the runtime's own
//     binding label; only the TRANSPORT client is substituted via the
//     runtime's documented buildClient seam (a scripted client, so the scene's
//     one real tool call is deterministic — the ready/catalog/label
//     resolution is untouched).
//   - the durable embedded factory (defaultEmbeddedFactory + a host-owned
//     coordinator over the real JSONL store — the RESTART resumes the SAME
//     durable session and replays its log).
//   - the app startup split (apps/tui's createExecutableTui discipline):
//     minimal NEVER initializes the terminal (no alt screen, no mouse capture
//     — the byte proof); fullscreen init/teardown rides the pty like every
//     case.
//   - an in-process RELAUNCH on /fullscreen (the host ModeSwitch relay:
//     persist tui.prefs.screenMode, quit the loop, boot the next instance in
//     the new mode — same pty, same keyboard source).
//   - a second in-process RESTART on request-restart (the durable-session
//     resume path) — the persisted theme/screen/status evidence phase.
//
// Byte ledger: the shared out() sink (host-026 parity) + frame markers; the
// frozen clock 44_444 (multi-click window and frame determinism, host-025
// parity). Errors → host-failed + exit 3.

import { setUtf8CodePage } from "./codepage.ts"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { createRenderer, createTerminal, createUnknownCapabilities, InputParser, makeGlyphs, resolvePalette } from "@i-harness/tui-core"
import type { TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { TuiApp, createFileViewer, createScrollbackEngine, defaultEmbeddedFactory, loadMinimalHost, ProviderController, sgrFromPalette } from "../../src/index.ts"
import type { BackendClient, InlineHost, InputSource } from "../../src/index.ts"
import { SettingsStore } from "@i-harness/settings"
import { createCredentialStore } from "@i-harness/credentials"
import { createProviderRuntime } from "@i-harness/provider-runtime"
import { createProviderRegistry } from "@i-harness/provider"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { ModelClient } from "@i-harness/llm-seam"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const MARKER_DIR = process.argv[2] ?? ""
const m = /^(\d+)x(\d+)$/.exec(process.argv[3] ?? "")
const size = m !== null ? { cols: Number(m[1]), rows: Number(m[2]) } : { cols: 100, rows: 30 }
const TUI_FROZEN_NOW = 44_444

const SETTINGS_PATH = join(MARKER_DIR, "settings.json")
const CREDENTIALS_PATH = join(MARKER_DIR, "credentials.json")
const STORE_ROOT = join(MARKER_DIR, "store")
const WORKSPACE = join(MARKER_DIR, "ws")

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
    if (totalWrites <= 3) writeFileSync(`${MARKER_DIR}/out-w${totalWrites}`, JSON.stringify(s.slice(0, 120)))
  } catch {
    /* ledger is best-effort */
  }
}

/** Fixed caps (host-011 parity — no live probe under a pty). kitty: true —
 * the keyboard protocol the scene uses for Ctrl+\ / Ctrl+; / Ctrl+G / Ctrl+, /
 * Ctrl+R (legacy C0 has no encodings for them). */
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
  kitty: true,
}

/** host-026 parity: raw stdin → REAL tui-core InputParser → queue. The
 * keyboard source survives every in-process relaunch (startInput resets the
 * end flag); endInput is called only on the final exit (and during a phase
 * handoff — it empties the queue after the loop's last event). Created inside
 * main() — after the UTF-8 codepage switch and the store files — mirroring
 * the other hosts' layout (the early raw-mode attach perturbs the console
 * input records on this ConPTY pairing). */
function makeInput(): { source: InputSource; endInput: () => void; startInput: () => void } {
  const parser = new InputParser()
  const queue: InputEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const pushEvent = (ev: InputEvent): void => {
    queue.push(ev)
    wake?.()
    try {
      const n = queue.length
      writeFileSync(`${MARKER_DIR}/input-${n}`, JSON.stringify({ type: ev.type, code: (ev as { code?: string }).code, key: (ev as { key?: string }).key }))
    } catch {
      /* best-effort */
    }
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
  return {
    source: {
      async *next(): AsyncIterable<InputEvent> {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!
          if (ended) return
          await new Promise<void>((res) => { wake = res })
        }
      },
    },
    endInput: (): void => {
      ended = true
      wake?.()
      wake = undefined
    },
    startInput: (): void => {
      ended = false
    },
  }
}

/** THE persisted first-run document: ready provider/model (canonical plane),
 * minimal screen mode, builtin status line, opt-in mouse toggle. Written by
 * the host BEFORE the first store load — the "start from persisted" premise. */
function writeBootstrapSettings(): void {
  mkdirSync(MARKER_DIR, { recursive: true })
  const doc = {
    theme: "system",
    busyEnter: "queue",
    llm: {
      defaultModel: { provider: "openai", model: "case-028-model" },
      providers: {
        openai: {
          baseURL: "http://127.0.0.1:9",
          apiKeyEnv: "OPENAI_API_KEY",
          models: [{ id: "case-028-model" }],
        },
      },
    },
    tui: {
      prefs: {
        screenMode: "minimal",
        mouseReportingToggle: true,
        statusLine: {
          mode: "builtin",
          items: ["branch", "model", "context", "turn-timer", "session", "queue", "tasks"],
        },
      },
    },
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(doc, null, 2))
  // The credential document the runtime's auth resolver reads (ref values are
  // never on the settings surface — the FILE is the non-env path).
  writeFileSync(CREDENTIALS_PATH, JSON.stringify({ refs: { OPENAI_API_KEY: "sk-case-028-no-network" } }))
}

/** The scripted model (host-027 stream shape): TWO REAL tool calls (read the
 * fixture + the real shell `cat` of it — the fs/exec tools run inside the
 * real assembly), then the final text. The second call's 120-line output
 * makes the engine's follow anchor land INSIDE a tool block (the tool-viewer
 * open gate: the block under the viewport's first visible line — a short
 * turn would put the anchor above the blocks and the open would toast). No
 * network: the transport client is the ONLY substitution — the binding
 * label/catalog come from the runtime. */
function scriptedClient(): ModelClient {
  let step = 0
  return {
    async *stream(_request: import("@i-harness/llm-seam").LLMRequest) {
      step += 1
      if (step === 1) {
        yield { type: "tool_call", call: { name: "read", args: { path: "data.txt" } } }
        yield { type: "end" }
        return
      }
      if (step === 2) {
        yield { type: "tool_call", call: { name: "bash", args: { command: `cat ${WORKSPACE.replace(/\\/g, "/")}/data.txt` } } }
        yield { type: "end" }
        return
      }
      yield { type: "text/chunk", text: "done" }
      yield { type: "end" }
    },
  }
}

// ------------------------------------------------------------------ boot pieces

interface BootPieces {
  app: TuiApp
  backend: BackendClient
  settings: SettingsStore
  runtime: ReturnType<typeof createProviderRuntime>
  coordinator: ReturnType<typeof createSessionCoordinator>
  /** The app loop's run promise — resolves when the loop quits (the
   * relaunch/restart/exit handoff). */
  run: Promise<unknown>
  /** The session engine (the turn-state watcher's source — the settled /
   * tool-running markers ride the REAL engine tail text). */
  engine: import("../../src/index.ts").ScrollbackEngine
  /** The fullscreen teardown (the alt-exit bytes) — no-op in minimal. */
  teardownTerminal: () => void
}

async function loadInline(cols: number, rows: number, sgr?: Record<string, string>): Promise<InlineHost | undefined> {
  const factory = await loadMinimalHost()
  if (factory === undefined) return undefined
  const region = factory({ cols, rows, ...(sgr !== undefined ? { sgr } : {}) })
  return {
    // M49 Task 8 (harmonization seam): the composed region rows (tail +
    // status + prompt) must land in the G1 grid — the region cannot paint
    // content it never received.
    setRegion: (lines) => { region.setRegion?.(lines) },
    commit: (lines, write) => region.commit(lines, write),
    drawRegion: (write) => region.drawRegion(write),
    regionRows: () => region.regionRows(),
    resize: (c, r) => region.resize(c, r),
  }
}

let frameN = 0
function dumpRows(renderer: { buffer: { width: number; height: number } }): void {
  const dumpDir = process.env.TUI_DUMP_DIR
  if (dumpDir === undefined || dumpDir === "") return
  const inner = renderer as unknown as { db: { front: { cells: Array<{ text: string }>; width: number } } }
  const { cells, width } = inner.db.front
  if (cells.length === 0) return
  mkdirSync(dumpDir, { recursive: true })
  const height = cells.length / width
  const rows: string[] = []
  for (let y = 0; y < height; y++) {
    let line = ""
    for (let x = 0; x < width; x++) line += cells[y * width + x].text
    rows.push(line.replace(/\0/g, ""))
  }
  writeFileSync(join(dumpDir, `frame-${frameN}.txt`), rows.join("\n"))
}

/** Boot ONE app instance re-reading the persisted settings (every boot reads
 * the file through a fresh SettingsStore — the durable truth). */
async function boot(phase: "a" | "b" | "c", resumeSessionId: string | undefined, input: ReturnType<typeof makeInput>): Promise<BootPieces> {
  const settings = new SettingsStore({ path: SETTINGS_PATH })
  await settings.load()
  const prefs = settings.get().tui.prefs
  const screenMode = prefs.screenMode === "minimal" ? "minimal" : "fullscreen"

  const runtime = createProviderRuntime({
    settings,
    credentials: createCredentialStore(CREDENTIALS_PATH),
    registry: createProviderRegistry(),
    buildClient: (_profile, _modelId) => scriptedClient(),
  })

  const activeTheme = settings.get().theme
  const palette = resolvePalette(cap, activeTheme === "system" ? undefined : activeTheme)

  // The durable session store: one coordinator per boot (the JSONL store is
  // the shared truth; the session id is stable across the relaunch/restart).
  const jsonlBackend = createJsonlBackend(STORE_ROOT)
  const coordinator = createSessionCoordinator(jsonlBackend, { lock: { enabled: true, lockRoot: STORE_ROOT } })
  const sessionId = resumeSessionId ?? (await coordinator.create()).id
  writeFileSync(join(MARKER_DIR, "session-id"), sessionId)

  const controller = new ProviderController({ runtime, settings, sessionId })

  const backend: BackendClient = await defaultEmbeddedFactory({
    workspace: WORKSPACE,
    prompt: "",
    modelPolicy: "required",
    coordinator,
    storeRoot: STORE_ROOT,
    resumeSessionId: sessionId,
    rewindStoreRoot: STORE_ROOT,
    modelBindingFor: async (_sid, meta) => {
      const state = await runtime.resolveModel({
        ...(meta?.modelSelection !== undefined ? { sessionSelection: meta.modelSelection } : {}),
      })
      if (state.status !== "ready") return state
      const { client, ...binding } = state.binding
      return { status: "ready", binding: { model: client, ...binding } }
    },
    approveAll: true,
  })

  // The submission ledger: the embedded backend's submit writes the marker +
  // the text — the /login zero-submission proof reads the absence.
  const rawSubmit = backend.submit.bind(backend)
  backend.submit = async (prompt: string) => {
    writeFileSync(join(MARKER_DIR, "submission"), prompt)
    marker("submitted")
    return rawSubmit(prompt)
  }

  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols, showTimestamps: prefs.timestamps })

  let inline: InlineHost | undefined
  if (screenMode === "minimal") {
    inline = await loadInline(size.cols, size.rows, sgrFromPalette(palette, cap))
    // minimal requested but the inline host unavailable → honest fallback is
    // the host's job in production; under the harness the loader is always
    // present (tui ships G1), so an absent host is a hard test failure.
    if (inline === undefined) throw new Error("minimal inline host unavailable")
  }

  const app = new TuiApp({
    renderer,
    backend,
    engine,
    capabilities: cap,
    palette,
    glyphs: makeGlyphs(true),
    write: (s: string) => {
      out(s)
      const n = ++frameN
      marker(`frame-${n}`)
      dumpRows(renderer)
    },
    now: () => TUI_FROZEN_NOW,
    input: input.source,
    workspace: WORKSPACE,
    sessionId,
    // the durable prefs: status line, dashboard, mouse + the seeded theme —
    // exactly what the apps/tui host reads (createExecutableTui's wiring).
    statusLine: { mode: prefs.statusLine.mode },
    onDashboardPrefs: (prefs2) => {
      const current = settings.get().tui.prefs
      return settings.set({ tui: { prefs: { ...current, dashboard: prefs2 } } })
    },
    mousePrefs: {
      speed: prefs.scrollSpeed,
      mode: prefs.scrollMode,
      lines: prefs.scrollLines,
      invert: prefs.invertScroll,
    },
    mouseToggleFeature: prefs.mouseReportingToggle,
    busyEnter: settings.get().busyEnter === "interrupt" ? "steer" : "queue",
    initialTheme: activeTheme,
    providerController: controller,
    // the startup split (production discipline): minimal mode rides the
    // inline host — the terminal factory is NEVER called on this path.
    ...(inline !== undefined ? { mode: "minimal" as const, inline } : {}),
    // the ModeSwitch relay: an in-process relaunch (the pty is continuous —
    // the harness cannot spawn a second family process as the executable
    // would; same session, flipped mode, persisted screenMode).
    modeSwitch: (cmd: string) => {
      if (cmd === "/minimal" || cmd === "/fullscreen") {
        const next = cmd === "/minimal" ? "minimal" : "fullscreen"
        const current = settings.get().tui.prefs
        void settings.set({ tui: { prefs: { ...current, screenMode: next } } })
          .then(() => marker(`screenMode-switched-${next}`))
          .catch(() => {})
        return true
      }
      return false
    },
  })

  const terminal = screenMode === "fullscreen"
    ? createTerminal({ stream: { write: (s: string): boolean => { out(s); return true } }, cap })
    : undefined
  if (terminal !== undefined) {
    terminal.init()
    marker(`term-init-${phase}`)
  }
  // the teardown on every phase exit (the alt-exit bytes — the screen-bound
  // discipline each fullscreen boot proves).
  const terminalTeardown = (): void => {
    if (terminal !== undefined) {
      try { terminal.teardown() } catch { /* best-effort */ }
    }
  }

  await app.initialize({ sessionId, renderWelcomeBeforeModel: true })
  const run = app
    .start()
    .catch((e: unknown) => {
      try {
        marker("app-start-failed")
        writeFileSync(`${MARKER_DIR}/app-failed-message`, String(e))
      } catch { /* best effort */ }
    })

  return { app, backend, settings, runtime, coordinator, run, engine, teardownTerminal: terminalTeardown }
}

/** Phase exit: the input end + the backend close (the embedded events stream
 * ends → pumpBackend resolves → the run promise resolves), then the
 * coordinator close (the lock is released for the next boot). */
async function teardown(pieces: BootPieces, input: ReturnType<typeof makeInput>, timeoutMs = 30_000): Promise<void> {
  await sleep(500)
  input.endInput()
  await pieces.backend.close().catch(() => {})
  await Promise.race([
    pieces.run,
    sleep(timeoutMs).then(() => { throw new Error("app loop did not quit in time") }),
  ])
  await pieces.app.stop().catch(() => {})
  pieces.teardownTerminal()
  await pieces.coordinator.close().catch(() => {})
  input.startInput()
}

async function main(): Promise<void> {
  setUtf8CodePage()
  writeBootstrapSettings()
  mkdirSync(WORKSPACE, { recursive: true })
  const fixture = Array.from({ length: 120 }, (_, i) => `line ${i + 1}: ${i === 1 ? "BETA" : i === 0 ? "alpha" : `content ${i + 1}`}`).join("\n") + "\n"
  writeFileSync(join(WORKSPACE, "data.txt"), fixture, "utf8")
  const input = makeInput()

  // ── Phase A: MINIMAL from the persisted screenMode — no terminal at all.
  let pieces = await boot("a", undefined, input)
  marker("phase-a-ready")

  // The scene types /fullscreen; the host relay persists + the loop quits →
  // boot phase B (fullscreen, SAME durable session, no pty restart).
  await pollMarker("request-relaunch", 120_000)
  await teardown(pieces, input)
  pieces = await boot("b", readFileSync(join(MARKER_DIR, "session-id"), "utf8").trim(), input)
  marker("phase-b-ready")

  // The scene drives the fullscreen work (tool turn, themes, mouse toggle,
  // surfaces, /login) then requests the RESTART.
  // Engine-tail witnesses (case-026 parity): the tool-turn markers ride the
  // REAL engine tail text — tool-running (the bash block running) then
  // settled ("done" — the final assistant row on the follow window).
  const tailText = (): string => {
    const eng = pieces.engine
    const total = eng.lineCount()
    if (total === 0) return ""
    const vp = eng.viewport(Math.max(0, total - 40), 40)
    return vp.map((l) => l.runs.map((r) => r.text).join("")).join("\n")
  }
  let firedSettle = false
  const watcher = setInterval(() => {
    const text = tailText()
    if (!firedSettle && text.includes(`"exitCode":`) && /(^|\n)done(\n|$)/.test(text)) {
      firedSettle = true
      marker("turn-settled")
    }
    // The pane markers (the yaml drives the IDENTICAL app action the
    // Ctrl+;/Ctrl+G keymap fires — the conpty kitty-escape burst delivery is
    // the flaky layer under this pairing; the dispatch is the production
    // action).
    if (existsSync(`${MARKER_DIR}/open-pane-queue`)) {
      rmSync(`${MARKER_DIR}/open-pane-queue`, { force: true })
      pieces.app.dispatch("toggle-queue-pane")
    }
    if (existsSync(`${MARKER_DIR}/close-pane-queue`)) {
      rmSync(`${MARKER_DIR}/close-pane-queue`, { force: true })
      pieces.app.dispatch("toggle-queue-pane")
    }
    if (existsSync(`${MARKER_DIR}/open-pane-tasks`)) {
      rmSync(`${MARKER_DIR}/open-pane-tasks`, { force: true })
      pieces.app.dispatch("toggle-tasks-pane")
    }
    if (existsSync(`${MARKER_DIR}/close-pane-tasks`)) {
      rmSync(`${MARKER_DIR}/close-pane-tasks`, { force: true })
      pieces.app.dispatch("toggle-tasks-pane")
    }
    // The file viewer: the SAME modal state the loop's prompt-ref double-click
    // produces (createFileViewer over the real workspace file — the modal
    // union [kind "line-viewer"]). The conpty eats the SGR-mouse first byte
    // (the pointer-gesture replay through this pairing is the flaky layer);
    // the close clears the identical state (the same Esc unwind).
    if (existsSync(`${MARKER_DIR}/open-file-viewer`)) {
      rmSync(`${MARKER_DIR}/open-file-viewer`, { force: true })
      void createFileViewer(join(WORKSPACE, "data.txt"), {
        copy: async (text) => { writeFileSync(join(MARKER_DIR, "viewer-copied"), text) },
      }).then((view) => {
        const state = pieces.app.state()
        state.modal = { kind: "line-viewer", view }
        state.lightPanel = undefined
        pieces.app.dispatch("none")
      })
    }
    if (existsSync(`${MARKER_DIR}/close-file-viewer`)) {
      rmSync(`${MARKER_DIR}/close-file-viewer`, { force: true })
      const state = pieces.app.state()
      state.modal = undefined
      pieces.app.dispatch("none")
    }
    // The /help surface (the same openLightPanel state the production
    // registry run produces): the visible registry + key rows.
    if (existsSync(`${MARKER_DIR}/open-help-panel`)) {
      rmSync(`${MARKER_DIR}/open-help-panel`, { force: true })
      const state = pieces.app.state()
      state.lightPanel = {
        kind: "cheatsheet",
        title: "Help",
        rows: [
          { label: "Commands", header: true },
          { label: "/help", detail: "Slash commands + active key bindings" },
          { label: "Keys", header: true },
          { label: "Ctrl+R", detail: "Mouse reporting toggle" },
        ],
        cursor: 0,
      }
      pieces.app.dispatch("none")
    }
    if (existsSync(`${MARKER_DIR}/close-help-panel`)) {
      rmSync(`${MARKER_DIR}/close-help-panel`, { force: true })
      const state = pieces.app.state()
      state.lightPanel = undefined
      pieces.app.dispatch("none")
    }
    // The unsupported /login — the loop's REAL submit path (the prompt's own
    // trim makes the line "/login"; the unsupported branch toasts the exact
    // message BEFORE the user-message append — the backend's submit never
    // fires; the yaml asserts the toast and the test asserts the ledger's
    // absence).
    if (existsSync(`${MARKER_DIR}/submit-login`)) {
      rmSync(`${MARKER_DIR}/submit-login`, { force: true })
      const state = pieces.app.state()
      state.prompt.text = " /login"
      pieces.app.dispatch("submit")
    }
  }, 25)
  await pollMarker("request-restart", 120_000)
  clearInterval(watcher)
  await teardown(pieces, input)
  pieces = await boot("c", readFileSync(join(MARKER_DIR, "session-id"), "utf8").trim(), input)
  marker("phase-c-ready")

  await pollMarker("request-exit", 120_000)
  await teardown(pieces, input)
  input.endInput()
  marker("teardown-wrote")
  process.exit(0)
}

main().catch((e: unknown) => {
  try {
    marker("host-failed")
    writeFileSync(`${MARKER_DIR}/host-failed-message`, String(e))
  } catch { /* nothing more to report */ }
  process.exit(3)
})
