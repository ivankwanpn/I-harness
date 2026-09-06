// apps/tui — the tui command (M37a G4).
//
// This is THIN: the wheel's logic lives in @i-harness/tui (app loop + engine +
// embedded backend); here is only the host wiring — flags, capabilities probe,
// terminal init/teardown, stdin input bridge, stdout renderer, resize relay,
// and process lifecycle. Keep it that way.
//
// Usage: node --import tsx apps/tui/src/index.ts [--prompt <text>]
//                [--workspace <dir>] [--model <spec>] [--yes] [--resume <id>]
//                [--session-dir <dir>]
//
// M48 embedded mode supports durable JSONL sessions through --session-dir;
// --resume restores the selected session and keeps subsequent turns durable.
// Without --session-dir, the embedded session remains intentionally ephemeral.
//   - M38b G2: --model now carries a REAL INFO-LINE label (the loop renders it
//     in the prompt chrome + status row; M49 the production model resolution
//     is the canonical provider runtime — required-model policy). --attach
//     <sessionId> switches the backend to the REMOTE SDK stdio server (see
//     the spawn block in runTui).
//   - capabilities: probeCapabilities() with a 2 s outer cap; a PTY / no-
//     answer terminal falls back to createUnknownCapabilities() (its
//     env-derived colorLevel still lands even without replies). The deep
//     probe-reply feed (raw stdin → ProbeClient) is M37b; stray OSC/DCS
//     replies are swallowed by tui-core's InputParser.
//   - Smoke caveat: an interactive run needs a REAL tty stdin. Under a pipe /
//     non-tty shell the raw-mode attach is skipped and the run stays alive on
//     the embedded stream (no keyboard, no way to quit) — by design; the
//     automated proof is packages/tui/test/harness (PTY cases 011/014).

import { fileURLToPath, pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import {
  attachInput,
  createRenderer,
  createTerminal,
  createUnknownCapabilities,
  makeGlyphs,
  probeCapabilities,
  resolvePalette,
} from "@i-harness/tui-core"
import type { GlyphSet, InputEvent, Palette, Renderer, TerminalCapabilityContext, TerminalHandles } from "@i-harness/tui-core"
import {
  bindPermissionOverlay,
  bindQuestionOverlay,
  createApprovalBridge,
  createRemoteBackend,
  createScrollbackEngine,
  defaultEmbeddedFactory,
  loadMinimalHost,
  ModeSwitch,
  ProviderController,
  sgrFromPalette,
  spawnSdkSubprocess,
  TuiApp,
} from "@i-harness/tui"
import type {
  ApprovalBridge,
  ApprovalBridgeService,
  BackendClient,
  InlineHost,
  InputSource,
  PermissionState,
  QuestionState,
  ScrollbackEngine,
  TuiAppOptions,
} from "@i-harness/tui"
import { createSessionService, type SessionService } from "@i-harness/session-executor"
import type { SessionAssembly } from "@i-harness/session-executor"
// The mock-model script shape (structural — llm-mock stays a tui-only dep; a
// host only ever hands the script-texture to the service option).
type MockStep = { role: "assistant"; text?: string; toolCalls?: Array<{ name: string; args: unknown }> }
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { SettingsStore, resolveSettingsPath } from "@i-harness/settings"
import type { SettingsStoreSurface } from "@i-harness/settings"
import { createCredentialStore } from "@i-harness/credentials"
import type { ProviderRuntime } from "@i-harness/provider-runtime"
import { createProviderRuntime } from "@i-harness/provider-runtime"
import { dirname } from "node:path"

// ------------------------------------------------------------------ flags

export interface TuiFlags {
  prompt?: string
  workspace?: string
  model?: string
  yes: boolean
  resume?: string
  sessionDir?: string
  /** M38b G2: attach to a REMOTE session — spawns `i-harness sdk` (the CLI's
   * stdio JSON-RPC server) and drives the session over the wire (the SDK
   * backend). Absent → the embedded (provider-runtime-backed) backend. */
  attach?: string
  /** Minimized UI (M38a spec §0/§1.1): the terminal's own scrollback holds
   * history; the app writes through the G1 inline live-region engine. */
  mode?: "minimal" | "fullscreen"
}

export function buildSdkArgs(flags: Pick<TuiFlags, "sessionDir">): string[] {
  return ["sdk", ...(flags.sessionDir !== undefined ? ["--session-dir", flags.sessionDir] : [])]
}

export function buildEmbeddedSessionOptions(flags: Pick<TuiFlags, "sessionDir" | "resume" | "prompt">): { prompt: string; storeRoot?: string; rewindStoreRoot?: string; resumeSessionId?: string } {
  if (flags.resume !== undefined && flags.sessionDir === undefined) {
    throw new Error("--resume requires --session-dir")
  }
  return {
    prompt: flags.resume === undefined ? flags.prompt ?? "" : "",
    ...(flags.sessionDir !== undefined ? { storeRoot: flags.sessionDir, rewindStoreRoot: flags.sessionDir } : {}),
    ...(flags.resume !== undefined ? { resumeSessionId: flags.resume } : {}),
  }
}

export interface TuiShutdownController { shutdown(): Promise<void> }

export function createTuiShutdownController(options: { close: () => Promise<void>; stop: () => void; teardown: () => void }): TuiShutdownController {
  let promise: Promise<void> | undefined
  return { shutdown: () => promise ??= (async () => { try { options.stop() } catch {} try { await options.close() } finally { try { options.teardown() } catch {} } })() }
}

/* ------------------------------------------------------------------ M49 Task 10: production interaction bridges */

export interface ExecutableHostOptions {
  /** The assembly workspace (default: a fresh temp dir). */
  workspace?: string
  /** approveAll:false (default) → NO auto-answerer; the bridge is the only
   * answerer (fail-closed otherwise — the spec's one-shot real decisions). */
  approveAll?: boolean
  mockScript?: MockStep[]
}

/** The attach observer — reads the live plugin ctx the way the answerers
 * themselves are read (never a synthetic flag). */
export interface AttachObserver {
  isAttached(ctx: SessionAssembly["ctx"]): boolean
}

export interface ExecutableHost {
  service: SessionService
  approvals: AttachObserver
  questions: AttachObserver
  bridge: ApprovalBridge
  close(): Promise<void>
}

/** M49 Task 10: the real apps/tui composition seam over a REAL session
 * service: the production question/approval bridge attached to EVERY assembly
 * the service creates. `approvals.isAttached(ctx)` / `questions.isAttached(ctx)`
 * read the plugin-ctx answerers back — the same read path the core-tools use. */
export async function createExecutableHost(options: ExecutableHostOptions = {}): Promise<ExecutableHost> {
  const workspace = options.workspace ?? mkdtempSync(join(tmpdir(), "ih-tui-host-"))
  const service = createSessionService({
    workspace,
    approveAll: options.approveAll ?? false,
    modelPolicy: "test-mock",
    mockScript: options.mockScript ?? [{ role: "assistant", text: "ok" }],
  })
  const bridge = createApprovalBridge(service)
  const attached = (key: string) => (ctx: SessionAssembly["ctx"]): boolean => {
    try {
      return ctx.services.get(key) !== undefined
    } catch {
      return false
    }
  }
  return {
    service,
    approvals: { isAttached: attached("approval/answerer") },
    questions: { isAttached: attached("questions/provider") },
    bridge,
    close: () => service.close(),
  }
}

/**
 * M49 Task 10: the bridge subscriber-set — the factory's onAssembly lands the
 * EMBEDDED service's assemblies here; the same hook set feeds the production
 * bridge. The remote (--attach) path has no local assembly (the wire is v0 —
 * approvals live in the SDK subprocess, whose host is the CLI) — guarded.
 */
function createBridgeService(subscriptions: Set<(assembly: SessionAssembly) => void>): ApprovalBridgeService {
  return {
    onAssembly: (hook) => {
      subscriptions.add(hook)
      return () => { subscriptions.delete(hook) }
    },
    assemblyFor: async (id) => {
      throw new Error(`approval bridge assembly resolution unavailable: ${id}`)
    },
  }
}

/** M49 Task 10: pump the approval/question streams into the app's overlay —
 * the ONE active surface wins (a busy overlay leaves the request pending; the
 * bridge's fail-closed timeout decides). Decisions are ONE-SHOT: each
 * answerApproval/answerQuestion resolves the pending ask exactly once, and
 * the Always/Never scope stays a host-side record (the seam is boolean-only).
 */
async function pumpInteractionBridge(app: TuiApp, bridge: ApprovalBridge): Promise<void> {
  const approve = (async () => {
    for await (const surf of bridge.approvals()) {
      if (app.state().overlay !== undefined) continue
      const state: PermissionState = { cursor: 0, scopeIndex: 0, freeformText: "" }
      app.state().overlay = bindPermissionOverlay(surf, state, {
        onDecision: (d) => {
          void bridge.answerApproval(surf.id, { approved: d.approved }, {
            ...(d.scope !== undefined ? { scope: d.scope } : {}),
            ...(d.feedback !== undefined ? { feedback: d.feedback } : {}),
          })
        },
        onClose: () => { app.state().overlay = undefined },
      })
      app.dispatch("none")
    }
  })()
  const ask = (async () => {
    for await (const q of bridge.questions()) {
      if (app.state().overlay !== undefined) continue
      const state: QuestionState = { cursor: 0, page: 1, pages: 1, freeformFocused: false, freeformText: "", selected: [] }
      app.state().overlay = bindQuestionOverlay(q, state, {
        onDecision: (d) => { void bridge.answerQuestion(q.id, { value: d.value }) },
        onClose: () => { app.state().overlay = undefined },
      })
      app.dispatch("none")
    }
  })()
  await Promise.all([approve, ask])
}

export function createTuiModelBindingFor(
  runtime: Pick<ProviderRuntime, "resolveModel">,
  override?: string,
): NonNullable<Parameters<typeof defaultEmbeddedFactory>[0]["modelBindingFor"]> {
  return async (_sessionId, meta) => {
    const state = await runtime.resolveModel({
      ...(meta?.modelSelection !== undefined
        ? { sessionSelection: meta.modelSelection }
        : {}),
      ...(override !== undefined ? { override } : {}),
    })
    if (state.status !== "ready") return state
    const { client, ...binding } = state.binding
    return { status: "ready", binding: { model: client, ...binding } }
  }
}

export type CreateExecutableAppOptions = Omit<
  TuiAppOptions,
  "backend" | "providerController" | "listSessions" | "sessionId"
> & {
  flags: TuiFlags
  backend: BackendClient
  providerController: ProviderController
}

/** Build and initialize the real app without entering its unbounded pumps.
 * Tests and runTui share this ordering: model state, explicit open, then Agent;
 * a bare launch remains on Welcome and a ready startup prompt creates/opens
 * before submission. */
export async function createExecutableApp(
  options: CreateExecutableAppOptions,
): Promise<{ app: TuiApp; backend: BackendClient }> {
  const { flags, backend, providerController, ...appOptions } = options
  const explicitSessionId = flags.attach ?? flags.resume
  const app = new TuiApp({
    ...appOptions,
    backend,
    providerController,
    listSessions: () => backend.listSessions(),
    ...(explicitSessionId !== undefined ? { sessionId: explicitSessionId } : {}),
  })
  await app.initialize({
    ...(explicitSessionId !== undefined ? { sessionId: explicitSessionId } : {}),
    ...(flags.prompt !== undefined ? { prompt: flags.prompt } : {}),
    renderWelcomeBeforeModel: true,
  })
  return { app, backend }
}

export function parseFlags(argv: string[]): TuiFlags {
  const flags: TuiFlags = { yes: false }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--prompt": flags.prompt = argv[++i]; break
      case "--workspace": flags.workspace = argv[++i]; break
      case "--model": flags.model = argv[++i]; break
      case "--yes": flags.yes = true; break
      case "--resume": flags.resume = argv[++i]; break
      case "--session-dir": flags.sessionDir = argv[++i]; break
      case "--attach": flags.attach = argv[++i]; break
      case "--minimal": flags.mode = "minimal"; break
      case "--fullscreen": flags.mode = "fullscreen"; break
      case "--mode": {
        const v = argv[++i]
        if (v === "minimal") flags.mode = "minimal"
        else if (v === "fullscreen") flags.mode = "fullscreen"
        break
      }
      case "--help":
      case "-h":
        process.stdout.write(
          "usage: tui [--prompt <text>] [--workspace <dir>] [--model <spec>]\n" +
          "           [--yes] [--session-dir <dir>] [--resume <sessionId>] [--attach <sessionId>] [--minimal]\n",
        )
        process.exit(0)
    }
  }
  return flags
}

// ------------------------------------------------------------------ sdk server spawn (M38b G2)

// M45: I_HARNESS_HOME — the dist-layout escape hatch. A bundled host (dist/
// ih.mjs) computes this path RELATIVE TO THE BUNDLE, which is not the project
// root anymore; the env override points the SDK spawn (tsx loader + CLI entry)
// at a real source checkout. ENV wins ONLY when set — source-run unchanged
// (this file is 3 levels deep; the URL default is still the project root).
const REPO_ROOT = process.env.I_HARNESS_HOME ?? fileURLToPath(new URL("../../../", import.meta.url))
// Absolute file URL of tsx's loader entry — resolves from ANY cwd (the sdk e2e
// precedent; the host may be invoked from anywhere).
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href
const CLI_ENTRY = join(REPO_ROOT, "apps", "cli", "src", "index.ts")

// ------------------------------------------------------------------ stdout

let epipe = false

/** Write sink wrapper: EPIPE on a closed terminal is swallowed; anything else
 * rethrows. Mirrors packages/tui-core/test/harness/host-010.ts. */
function out(s: string): void {
  if (epipe) return
  try {
    process.stdout.write(s)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "EPIPE") epipe = true
    else throw e
  }
}

// ------------------------------------------------------------------ minimal host (M38a)

/**
 * G1's inline engine, loaded LAZILY (dynamic import in loadMinimalHost):
 * before G1 lands this resolves undefined → the app falls back to the
 * fullscreen agent view (the minimal request stays a no-op). The returned
 * adapter is the loop's InlineHost: commit pushes print-once content into
 * the native scrollback, drawRegion repaints the region rows, all bytes
 * through the write sink (ledger). M38a harmonization seam: the composed
 * region rows (todos/status/prompt) land in G1's region grid at G1↔G2
 * wiring — the G1 contract (contracts.ts) exposes no region-content setter.
 * M49 Task 8: `sgr` is the palette-derived style override — minimal's ANSI
 * colors come from the ACTIVE semantic palette (design §9.3), quantized to
 * the terminal's color depth. The failure WARNING is the startup split's job
 * (createExecutableTui — exactly one warning, never rewritten persistence).
 */
async function loadInlineHost(cols: number, rows: number, sgr?: Record<string, string>): Promise<InlineHost | undefined> {
  const factory = await loadMinimalHost()
  if (factory === undefined) return undefined
  const region = factory({ cols, rows, ...(sgr !== undefined ? { sgr } : {}) })
  return {
    commit: (lines, write) => region.commit(lines, write),
    drawRegion: (write) => region.drawRegion(write),
    regionRows: () => region.regionRows(),
    resize: (c, r) => region.resize(c, r),
  }
}

// ------------------------------------------------------------------ startup split (M49 Task 8)

/** Production UI surface modes (design §9.2 `tui.prefs.screenMode`). */
export type ExecutableScreenMode = "fullscreen" | "minimal"

/**
 * Resolve the executable screen mode — the singleton precedence (spec §7.2):
 * explicit `--mode` flag > persisted `tui.prefs.screenMode` > fullscreen
 * default. Only exact values win; anything unknown falls through to the next
 * tier (a corrupt persisted value never sends production anywhere weird).
 */
export function resolveExecutableScreenMode(options: {
  flag?: string
  persisted?: string
}): ExecutableScreenMode {
  if (options.flag === "minimal") return "minimal"
  if (options.flag === "fullscreen") return "fullscreen"
  if (options.persisted === "minimal") return "minimal"
  if (options.persisted === "fullscreen") return "fullscreen"
  return "fullscreen"
}

export interface CreateExecutableTuiOptions {
  flags: TuiFlags
  /** The resolved screen mode (resolveExecutableScreenMode output). */
  screenMode: ExecutableScreenMode
  /** The fullscreen terminal-handles factory — invoked AT MOST ONCE and only
   * when the terminal path actually runs (fullscreen, or the minimal →
   * fullscreen fallback). Minimal-with-inline NEVER calls it, so the
   * alt-screen/mouse bytes are structurally impossible: they only exist in
   * initSequence (the test substitutes a recording double). */
  terminalFactory: () => TerminalHandles
  cols: number
  rows: number
  renderer: Renderer
  backend: BackendClient
  engine: ScrollbackEngine
  capabilities: TerminalCapabilityContext
  palette: Palette
  glyphs: GlyphSet
  write: (s: string) => void
  /** The loaded settings store (normalized surface — the effective values). */
  settings: SettingsStoreSurface
  /** The provider controller behind /provider //model //settings. */
  providerController: ProviderController
  workspace: string
  input?: InputSource
  /** Eager inline-host loader — createExecutableTui's startup split loads the
   * host BEFORE the app starts (the executable's loadInlineHost default;
   * tests inject a fake to prove the byte discipline). */
  loadInline?: (cols: number, rows: number) => Promise<InlineHost | undefined>
  /** M49 Task 8: the palette-derived minimal style override (the ACTIVE
   * semantic palette, quantized — sgrFromPalette(palette, cap)). */
  minimalSgr?: Record<string, string>
}

/**
 * The executable's production startup split (spec §7.2/§9.3): fullscreen
 * initializes the terminal (alt screen + five-mode mouse), minimal loads the
 * inline host and touches NOTHING terminal-side — no alt screen, no mouse
 * capture, no init sequence at all (the structural guarantee). An inline-
 * engine failure with a minimal request writes ONE warning, starts
 * fullscreen, and NEVER rewrites the persisted choice (the caller's
 * resolution stands — the user's mode is a hint for the NEXT start).
 */
export async function createExecutableTui(
  options: CreateExecutableTuiOptions,
): Promise<{
  app: TuiApp
  backend: BackendClient
  screenMode: ExecutableScreenMode
  terminal: TerminalHandles | undefined
}> {
  const {
    flags,
    screenMode,
    terminalFactory,
    cols,
    rows,
    settings,
    providerController,
    loadInline,
    minimalSgr,
    ...appInputs
  } = options
  const tuiPrefs = settings.get().tui.prefs
  const mouseToggleFeature = process.env.GROK_MOUSE_REPORTING_TOGGLE === "1"
    || tuiPrefs.mouseReportingToggle
  let inline: InlineHost | undefined
  let effective: ExecutableScreenMode = screenMode
  let terminal: TerminalHandles | undefined
  if (screenMode === "minimal") {
    const loader = loadInline ?? ((c: number, r: number) => loadInlineHost(c, r, minimalSgr))
    inline = await loader(cols, rows)
    if (inline === undefined) {
      // Inline-engine failure: ONE warning, fullscreen fallback, and the
      // persisted tui.prefs.screenMode is deliberately NOT rewritten (this
      // is the resolver's choice; the NEXT start retries minimal).
      console.warn("minimal mode requested but the inline engine is unavailable — falling back to fullscreen")
      terminal = terminalFactory()
      terminal.init()
      effective = "fullscreen"
    }
  } else {
    terminal = terminalFactory()
    terminal.init()
  }
  const { app, backend } = await createExecutableApp({
    flags,
    renderer: appInputs.renderer,
    backend: appInputs.backend,
    engine: appInputs.engine,
    capabilities: appInputs.capabilities,
    palette: appInputs.palette,
    glyphs: appInputs.glyphs,
    // M49 Task 8 (review r1): seed the runtime theme FROM the persisted
    // choice — the state anchor must match the rendered palette, so bare
    // /theme after a restart cycles from the active theme, never "system".
    initialTheme: settings.get().theme,
    write: appInputs.write,
    providerController,
    compact: tuiPrefs.compact,
    workspace: appInputs.workspace,
    ...(appInputs.input !== undefined ? { input: appInputs.input } : {}),
    ...(inline !== undefined ? { mode: "minimal" as const, inline } : {}),
    mousePrefs: {
      speed: tuiPrefs.scrollSpeed,
      mode: tuiPrefs.scrollMode,
      lines: tuiPrefs.scrollLines,
      invert: tuiPrefs.invertScroll,
    },
    mouseToggleFeature,
    busyEnter: settings.get().busyEnter === "interrupt" ? "steer" : "queue",
    modeSwitch: (cmd) => new ModeSwitch({
      argv: process.argv.slice(2),
      persist: (mode) => {
        persistScreenMode(settings, mode)
      },
    }).onSlash(cmd),
  })
  return { app, backend, screenMode: effective, terminal }
}

/** Durable screenMode write (the mode-switch persistence — best-effort: a
 * failed write never blocks the relaunch). */
function persistScreenMode(settings: SettingsStoreSurface, mode: "minimal" | "fullscreen"): void {
  const current = settings.get().tui.prefs
  void settings.set({ tui: { prefs: { ...current, screenMode: mode } } }).catch(() => {
    // the relaunch already spawned; a persist failure only loses the hint
  })
}

// ------------------------------------------------------------------ main

export async function runTui(flags: TuiFlags): Promise<number> {
  if (flags.resume !== undefined && flags.sessionDir === undefined) {
    throw new Error("--resume requires --session-dir")
  }
  // M37a Windows fix (same as the M36 PTY harness): ConPTY converts the wire
  // stream with the console output codepage unless the console is UTF-8 —
  // multibyte TUI glyphs (❯ ◆ ⠼ …) would be mangled on a legacy codepage.
  if (process.platform === "win32") {
    try {
    execFileSync(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\chcp.com`, ["65001"], { stdio: "ignore" })
    } catch {
      /* best-effort; UTF-8 conhost is the common case */
    }
  }

  const workspace = flags.workspace ?? process.cwd()

  // M49: production model resolution uses the canonical settings and
  // credentials through provider-runtime. The engine + loop read the durable TUI prefs
  // (timestamps/compact apply NOW; the modal can also flip them live).
  const settings = new SettingsStore()
  await settings.load()
  const credentials = createCredentialStore(
    join(dirname(resolveSettingsPath()), "credentials.json"),
  )
  const providerRuntime = createProviderRuntime({ settings, credentials })
  const tuiPrefs = settings.get().tui.prefs

  // Capabilities: the probe writes its queries to stdout; a PTY / no-answer
  // terminal resolves to the env-derived defaults (2 s outer cap on top of
  // the probe's own 500 ms deadline).
  const cap: TerminalCapabilityContext = await Promise.race([
    probeCapabilities(() => ({ write: (s) => process.stdout.write(s) })),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000)),
  ])
    .then((c) => (c === "timeout" ? createUnknownCapabilities() : c))
    .catch(() => createUnknownCapabilities())

  // M49 Task 10: the production interaction bridge — attached to EVERY
  // assembly the embedded service creates (onAssembly → the factory's seam)
  // and pumped into the app's overlay below. The REMOTE path has no local
  // assembly (the wire is v0 — the SDK subprocess owns its own host; its
  // approvals/fail-closed semantics are the CLI's, not ours — honest gap).
  const bridgeSubscriptions = new Set<(assembly: SessionAssembly) => void>()
  const bridge = createApprovalBridge(createBridgeService(bridgeSubscriptions))

  // Backend (M38b G2): `--attach <sessionId>` → the REMOTE SDK backend — spawn
  // `i-harness sdk` (the CLI's stdio JSON-RPC server) and
  // drive that session over the FROZEN v0 wire. The spawned subprocess dies
  // with backend.close() (shutdown → exit). LOUD: the wire has no history RPC,
  // so an --attach shows the session from THIS moment (pre-attach log lines are
  // NOT replayed — wire v0 append-only rule; history replay needs a v1 RPC).
  // Otherwise the embedded factory resolves through the same canonical
  // provider runtime. `--model` remains the explicit override.
  const base = flags.attach !== undefined
    ? createRemoteBackend({
        client: spawnSdkSubprocess({
          command: process.execPath,
          args: ["--import", TSX_LOADER, CLI_ENTRY, ...buildSdkArgs(flags)],
          cwd: workspace,
        }),
        sessionId: flags.attach,
        title: flags.attach,
      })
    : await defaultEmbeddedFactory({
        workspace,
        ...buildEmbeddedSessionOptions(flags),
        // Task 5 owns startup prompt gating in TuiApp. The backend's legacy
        // auto-submit seam remains available to direct consumers/tests only.
        prompt: "",
        modelPolicy: "required",
        modelBindingFor: createTuiModelBindingFor(providerRuntime, flags.model),
        // M46a: the durable TUI prefs drive the assembly's approval stance —
        // guardian ON means tool asks reach the approval bridge (approval
        // without a bridge fails closed — the bridge is G1's createApprovalBridge;
        // the default factory never attaches one, so guardian stays the
        // durable knob + the honest "asks" semantics at the ask surface).
        approveAll: !tuiPrefs.guardian || tuiPrefs.alwaysApprove,
        // M49 Task 10: every production assembly gets the bridge answerers
        // (the bridge attach — fail-closed when the UI cannot surface).
        onAssembly: (assembly) => { for (const hook of bridgeSubscriptions) hook(assembly) },
      })

  const cols = process.stdout.columns ?? 80
  const rows = process.stdout.rows ?? 24
  // M49 Task 8 (spec §7.2): startup mode = explicit `--mode` flag >
  // persisted tui.prefs.screenMode (the /minimal //fullscreen switches write
  // it) > fullscreen default. The STARTUP SPLIT (createExecutableTui) then
  // initializes the terminal ONLY in fullscreen — minimal never enters the
  // alt screen and never captures the mouse (the structural red line: the
  // sequences exist only in initSequence, which minimal never calls).
  const screenMode = resolveExecutableScreenMode({ flag: flags.mode, persisted: tuiPrefs.screenMode })
  const renderer = createRenderer({ cols, rows, cap })
  const engine = createScrollbackEngine({ width: cols, showTimestamps: tuiPrefs.timestamps })

  // Input bridge: attachInput pushes parser events into a queue the TuiApp's
  // input pump drains; when the backend close()s (app quit path), the queue
  // closes so stop()/start() can resolve without a live keyboard.
  const inputQueue: InputEvent[] = []
  let inputWake: (() => void) | undefined
  let inputEnded = false
  const endInput = (): void => {
    inputEnded = true
    inputWake?.()
    inputWake = undefined
  }
  const input: InputSource = {
    async *next(): AsyncIterable<InputEvent> {
      for (;;) {
        while (inputQueue.length > 0) yield inputQueue.shift()!
        if (inputEnded) return
        await new Promise<void>((r) => {
          inputWake = r
        })
      }
    },
  }
  const backend: BackendClient = {
    ...base,
    close: async () => {
      endInput()
      await base.close()
    },
  }

  // Raw-mode attach — only possible on a real tty. On a non-tty stdin (pipes,
  // CI) skip the keyboard; the run stays alive on the backend stream.
  let attach: ReturnType<typeof attachInput> | undefined
  try {
    attach = attachInput({
      stdin: process.stdin,
      onEvent: (ev) => {
        inputQueue.push(ev)
        inputWake?.()
      },
      cap,
    })
    attach.start()
  } catch {
    // not a tty → no keyboard; the input pump is simply never wired
  }

  // M49 Task 6: the provider controller — the UI adapter over the runtime +
  // the live backend (active-session model selections ride setSessionModel;
  // no session → durable llm.defaultModel).
  const providerController = new ProviderController({
    runtime: providerRuntime,
    settings,
    backend,
    sessionId: flags.attach ?? flags.resume,
  })
  // M49 Task 8: startup honors the PERSISTED THEME (design §9.3) — the
  // palette given to the app is the resolved active theme; the minimal
  // region's ANSI comes from the same active palette (sgrFromPalette).
  const activeTheme = settings.get().theme
  const palette = resolvePalette(cap, activeTheme === "system" ? undefined : activeTheme)
  const { app, terminal } = await createExecutableTui({
    flags,
    screenMode,
    // The factory runs ONLY on the fullscreen path — minimal never creates or
    // initializes the terminal handle (alternate screen + mouse capture are
    // structurally absent from the minimal byte stream).
    terminalFactory: () => createTerminal({
      stream: { write: (s: string): boolean => { out(s); return true } },
      cap,
    }),
    cols,
    rows,
    renderer,
    backend,
    engine,
    capabilities: cap,
    palette,
    glyphs: makeGlyphs(true),
    write: out,
    settings,
    providerController,
    workspace,
    ...(attach !== undefined ? { input } : {}),
    // M49 Task 8: "Minimal uses the active semantic palette for ANSI output" —
    // the inline host paints with the palette-derived SGR (quantized).
    minimalSgr: screenMode === "minimal" ? sgrFromPalette(palette, cap) : undefined,
  })

  // M49 Task 10: pump the production interaction bridge — approval/question
  // requests surface through the app's overlay (the one active surface); the
  // embedded path only (the remote SDK host owns its own).
  if (flags.attach === undefined) void pumpInteractionBridge(app, bridge)

  // Resize relay: stdout 'resize' → renderer re-grid + engine re-wrap + the
  // minimal inline host geometry; the next frame is a full paint (renderer
  // internal), zero-byte idle untouched.
  process.stdout.on("resize", () => {
    try {
      const c = process.stdout.columns ?? cols
      const r = process.stdout.rows ?? rows
      renderer.resize(c, r)
      app.setSize(c, r)
    } catch {
      /* mid-shutdown: ignore */
    }
  })

  // Lifecycle: the app quit path (Ctrl-Q / armed Ctrl-C) → backend.close →
  // input ended → start() resolves → graceful teardown. SIGINT/SIGTERM are
  // the first-graceful paths (raw mode means Ctrl-C never becomes SIGINT).
  // M49 Task 8: minimal has NO terminal — teardown is a no-op there (the
  // terminal was never initialized; no leave-alt-screen bytes either).
  const shutdownController = createTuiShutdownController({ close: () => backend.close(), stop: () => attach?.stop(), teardown: () => terminal?.teardown() })
  const shutdown = (): Promise<void> => shutdownController.shutdown()
  const onSignal = (code: number): void => {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
    void shutdown().then(() => process.exit(code), () => process.exit(code))
  }
  const onSigint = (): void => onSignal(130)
  const onSigterm = (): void => onSignal(143)
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)

  await app.start()

  try {
    await shutdown()
  } catch (error) {
    console.error(`[i-harness] shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  return 0
}

// Entry guard: invoke runTui() only when this module is executed directly as
// the process entry point (e.g. `node --import tsx apps/tui/src/index.ts`),
// never when imported (tests, other modules). File-URL comparison — same
// pattern as apps/cli.
// M45: in the DIST bundle esbuild merges every module into one file with a
// SINGLE import.meta.url — this guard would fire whenever the CLI bundle is
// run (`node dist/ih.mjs --version` would ALSO boot the TUI: double-entry).
// build-dist.mjs defines I_HARNESS_DIST=1 for the bundle, so the guard is
// skipped there; source-run never sets it (semantics unchanged).
if (process.argv[1] && process.env.I_HARNESS_DIST !== "1" && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTui(parseFlags(process.argv.slice(2))).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
