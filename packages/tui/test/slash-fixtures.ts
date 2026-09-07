// M49 Task 14 — shared slash test fixtures (the plan's TEST FIXTURE CONTRACT).
// Every helper exercises the REAL unit under test:
//   - slashContext({capabilities})   — minimal SlashContext + capabilities inventory
//   - recordingSlashContext()        — full SlashContext; every member records
//     into `calls` (one call per member invocation, `name`/`name:arg` literal)
//   - recordingBackend()             — structural BackendClient fake (recorded
//     submissions + only the requested optional capabilities present)
//   - runSlash(input, ctx)           — production CommandRegistry.matches() then run()
//   - slashApp(backend)              — real TuiApp over recordingBackend (the
//     submit path facade: editor / submitPrompt / toast)

import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { TuiApp } from "../src/app/loop.ts"
import { createScrollbackEngine } from "../src/index.ts"
import type { BackendClient, TuiEvent } from "../src/index.ts"
import { CommandRegistry } from "../src/app/slash/registry.ts"
import type { SlashCapability, SlashContext } from "../src/app/slash/types.ts"
import type { TuiAppState } from "../src/app/present.ts"

// ------------------------------------------------------------------ capabilities

/** The full typed inventory the visible() gates check. The recording fixture
 * carries EVERY capability (each command may run); the visibility fixture
 * limits them per test. The loop never supplies plan-mode/guardian/vim-mode
 * at M49 (no live backend switching/guardian capability) — recording tests use
 * them only to exercise the capability shape. */
export const ALL_CAPABILITIES: SlashCapability[] = [
  "session-create",
  "session-list",
  "dashboard",
  "provider-settings",
  "rewind",
  "compact",
  "fork",
  "context",
  "plan-mode",
  "guardian",
  "vim-mode",
]

// ------------------------------------------------------------------ slash contexts

/** Minimal SlashContext for visibility tests — only the fields the registry
 * reads are real; commands never run here. */
export function slashContext(options: { capabilities?: SlashCapability[] } = {}): SlashContext {
  return {
    app: {},
    backend: {},
    engine: {},
    input: "",
    arg: "",
    toast: () => {},
    turns: () => 0,
    jumpAnchors: () => [],
    gotoLine: () => {},
    openPanel: () => {},
    openSessions: () => {},
    openHistoryPanel: () => {},
    openRewind: () => {},
    startSearch: () => {},
    planRows: () => [],
    toggleBtwWith: () => {},
    openBtwInput: () => {},
    setScreen: () => {},
    setTheme: () => {},
    setTimestamps: () => {},
    setMultiline: () => {},
    setCompactMode: () => {},
    focusPrompt: () => {},
    resetSession: () => {},
    renameSession: () => {},
    relaunch: () => false,
    quitApp: () => {},
    copy: () => {},
    editPromptInEditor: () => {},
    exportTranscript: async () => undefined,
    openTranscriptPager: async () => false,
    capabilities: options.capabilities ?? [],
  } as unknown as SlashContext
}

/** A TuiAppState-shaped app object carrying the fields the command impls
 * mutate (mirror of the loop's state surface). */
export function slashFakeApp(): TuiAppState {
  return {
    mode: "normal",
    title: "untitled",
    prompt: {
      text: "", cursor: 0, multiLine: false, focused: true,
      model: "mock-model", plan: false, title: "untitled",
    },
    status: { plan: false },
    theme: "auto",
    timestamps: false,
    compactMode: false,
    autoApprove: false,
    history: [],
    historyIndex: 0,
    panes: new Set<string>(),
  } as unknown as TuiAppState
}

export interface SlashRecorder {
  calls: string[]
}

/** The full recording SlashContext: every member pushes its literal call
 * (`name` for no-arg invocations, `name:arg…` otherwise). All capabilities
 * are present so every command's run() is reachable through matches(). */
export function recordingSlashContext(): SlashContext & SlashRecorder & { app: TuiAppState } {
  const calls: string[] = []
  const rec = (name: string): (() => void) => () => { calls.push(name) }
  const rec1 = (name: string): ((a: string) => void) => (a) => { calls.push(`${name}:${a}`) }
  const recB = (name: string): ((a: boolean) => void) => (a) => { calls.push(`${name}:${a}`) }
  /** Optional-arg seam: bare (undefined/empty) records the plain name. */
  const recOpt = (name: string): ((a?: string) => void) => (a) => {
    calls.push(a === undefined || a === "" ? name : `${name}:${a}`)
  }
  const ctx: SlashContext = {
    app: slashFakeApp(),
    backend: {
      compact: async (instructions?: string) => {
        calls.push(instructions === undefined ? "compact" : `compact:${instructions}`)
        return { compacted: true }
      },
      context: async () => ({ used: 10, total: 100 }),
    } as never,
    engine: { lineCount: () => 5 } as never,
    input: "",
    arg: "",
    capabilities: ALL_CAPABILITIES,
    toast: (text) => calls.push(`toast:${text}`),
    turns: () => 2,
    jumpAnchors: () => [{ line: 0, n: 1, text: "turn one" }],
    gotoLine: (line) => calls.push(`gotoLine:${line}`),
    openPanel: (req) => calls.push(`panel:${req.kind}:${req.title}:${req.rows.length}`),
    openSessions: rec("openSessions"),
    openHistoryPanel: rec("openHistoryPanel"),
    openRewind: rec("openRewind"),
    startSearch: (pattern?: string) => calls.push(pattern === undefined ? "startSearch" : `startSearch:${pattern}`),
    planRows: () => [{ label: "plan line" }],
    toggleBtwWith: rec1("btw"),
    openBtwInput: rec("btwInput"),
    setScreen: rec1("setScreen"),
    setTheme: rec1("setTheme"),
    setTimestamps: recB("setTimestamps"),
    setMultiline: recB("setMultiline"),
    setCompactMode: recB("setCompactMode"),
    focusPrompt: rec("focusPrompt"),
    resetSession: rec("resetSession"),
    renameSession: rec1("renameSession"),
    relaunch: () => false,
    quitApp: rec("quitApp"),
    copy: rec("copy"),
    editPromptInEditor: rec("editPromptInEditor"),
    exportTranscript: async () => { calls.push("exportTranscript"); return "/tmp/x.txt" },
    openTranscriptPager: async () => { calls.push("openTranscriptPager"); return true },
    probeReport: async () => { calls.push("probeReport"); return [{ label: "color", detail: "truecolor" }] },
    mouseReportingToggle: true,
    workflow: undefined,
    openTextInput: (opts) => calls.push(`textInput:${opts.title}`),
    // ---- M49 Task 14 capability-gated seams
    createSession: rec("createSession"),
    dashboard: rec("dashboard"),
    queue: rec("queue"),
    tasks: rec("tasks"),
    openSettings: rec("openSettings"),
    provider: recOpt("provider"),
    model: recOpt("model"),
    fork: recOpt("fork"),
    effort: recOpt("effort"),
    openContext: rec("context"),
    visibleCommands: () => [{ name: "theme", description: "Cycle theme" }],
    keyBindings: () => [{ key: "j/k", label: "scroll" }],
  }
  return Object.assign(ctx, { calls }) as SlashContext & SlashRecorder & { app: TuiAppState }
}

// ------------------------------------------------------------------ backend

export interface RecordingBackendHandle {
  backend: BackendClient
  /** Every submitted prompt (the "never reaches the model" proof). */
  submissions: string[]
}

/** Structural BackendClient fake (required members only; requested optional
 * capabilities are added per test — absent ⇒ the loop derives no capability). */
export function recordingBackend(): RecordingBackendHandle {
  const submissions: string[] = []
  const events: TuiEvent[] = []
  return {
    submissions,
    backend: {
      listSessions: async () => [],
      open: async () => {},
      modelState: async () => ({ status: "ready", providerId: "fixture", modelId: "model", label: "fixture:model" }),
      submit: async (text: string) => { submissions.push(text) },
      steer: async () => {},
      cancel: async () => {},
      events: async function* () {
        for (const ev of events) yield ev
      },
      seqCursor: () => 0,
      replay: async () => [],
      status: () => ({ running: false, queued: 0 }),
      close: async () => {},
    } as BackendClient,
  }
}

// ------------------------------------------------------------------ runSlash

/** Resolve through the production CommandRegistry.matches() then call the
 * command's run() — the SAME path the loop's submit uses. */
export async function runSlash(line: string, ctx: SlashContext): Promise<void> {
  const registry = new CommandRegistry()
  const m = registry.matches(line, ctx)
  if (m === undefined) throw new Error(`no match for ${line}`)
  const c = ctx as SlashContext & { arg: string; input: string }
  c.arg = m.arg
  c.input = line
  await m.command.run(ctx)
}

// ------------------------------------------------------------------ slashApp

const CAP: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const PALETTE = resolvePalette(CAP, "groknight")

/** Real TuiApp construction + the submit facade the brief's tests use
 * (editor / submitPrompt / toast). The editor wrapper seeds the REAL
 * PromptEditor and mirrors the text into the view projection (the same
 * editor → view sync the loop's typing path performs). */
export function slashApp(backend: BackendClient): {
  app: TuiApp
  editor: { replaceAll(text: string): void; value(): string }
  submitPrompt(): Promise<void>
  get toast(): string | undefined
} {
  const renderer: Renderer = createRenderer({ cols: 100, rows: 24, cap: CAP })
  const tui = new TuiApp({
    renderer,
    backend,
    engine: createScrollbackEngine({ width: 100 }),
    capabilities: CAP,
    palette: PALETTE,
    glyphs: GLYPHS,
    write: () => {},
    now: () => 13_334,
  })
  const inner = tui.editor
  return {
    app: tui,
    editor: {
      replaceAll(text: string): void {
        inner.replaceAll(text)
        const p = tui.state().prompt
        p.text = inner.value()
        p.cursor = inner.cursor()
      },
      value: () => inner.value(),
    },
    async submitPrompt() { await tui.submitPrompt() },
    get toast(): string | undefined {
      return tui.state().toasts.at(-1)?.text
    },
  }
}
