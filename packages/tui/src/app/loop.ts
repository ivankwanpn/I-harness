// @i-harness/tui — G2: the app event loop (M37a).
// Three sources merge per tick: injected input (host wires tui-core
// attachInput → InputSource), backend.events() (live stream, 16ms-batched by
// the backend bridge), and the 30fps animation pump — scheduled ONLY while a
// turn is running or a toast is live ("needs repaint" polling, spec §7).
// Painting is coalesced to one frame per tick; identical frames flush "" to
// the write sink (zero-byte idle, M36).

import type {
  GlyphSet,
  InputEvent,
  Palette,
  Renderer,
  TerminalCapabilityContext,
} from "@i-harness/tui-core"
import { createMouseReportingToggle, resolvePalette } from "@i-harness/tui-core"
import type { MouseReportingToggle } from "@i-harness/tui-core"
import { isAbsolute, join } from "node:path"
import type { BackendClient, BackendModelState, ScrollbackEngine, SessionQueueItem, SessionSummary, TuiEvent } from "../contracts.ts"
import type { QueueRow } from "../views/queue-pane.ts"
import { dispatchKey, shortcutsFor } from "./keys.ts"
import type { AppAction, Kbd, KeymapState, OverlayKind } from "./keys.ts"
import { present } from "./present.ts"
import type { TuiAppState } from "./present.ts"
import { bindRewindOverlay, isRewindOverlay } from "./overlay-seam.ts"
import type { RewindState } from "../views/rewind.ts"
// M49 Task 6: provider menu/master-detail + settings modal + model picker
// overlays over the ProviderController (provider-runtime + settings + backend).
import {
  bindProviderOverlay,
  type ProviderBindOptions,
  type ProviderEditorState,
  type ProviderRow,
} from "../views/provider.ts"
import { bindModelPickerOverlay, modelPickerEntries, type ModelPickerState } from "../views/model-picker.ts"
import { bindSettingsOverlay, createTuiSettingsRegistry, type SettingsModalState } from "../views/settings.ts"
import { createSettingsController } from "../settings/controller.ts"
import type { SettingsProviderProtocol, SettingsTheme } from "@i-harness/settings"
import { ProviderController } from "./provider-controller.ts"
import { FpsMeter } from "./hud.ts"
import type { HudState } from "./hud.ts"
// M46b G1: the HitArea hover engine + the grok scroll-stream normalizer.
import { HoverEngine } from "./hover.ts"
import { ScrollStreamNormalizer } from "./scroll-stream.ts"
import type { MouseStreamPrefs } from "./scroll-stream.ts"
import type { RegionLine } from "../minimal/contracts.ts"
import { MinimalCommits, commitDelta, displayToRegion } from "../minimal/commit.ts"
import { composeRegion } from "../minimal/live-region.ts"
import { fmtCompact } from "../views/status.ts"
import type { TurnPhase } from "../views/turn-status.ts"
import type { PaneState } from "../views/agent.ts"
import { layoutAgent } from "../views/agent.ts"
import type { SlashEntry } from "../views/slash-dropdown.ts"
import type { CompletionEntry } from "../views/completion-dropdown.ts"
import type { SearchResult } from "../views/file-search.ts"
import { flattenSessions } from "../views/session-picker.ts"
import type { SessionRow } from "../views/session-picker.ts"
// M46a G2: the slash command registry (builtin map + visible gating) + the
// light panel/kitchen seams the commands' ctx exposes.
import { CommandRegistry, defaultRegistry } from "./slash/registry.ts"
import type { SlashCapability, SlashCommand, SlashContext, SlashPanelRequest } from "./slash/types.ts"
import { bindTextInput } from "./slash/impl/text-input.ts"
import type { LightPanelState } from "../views/light-panel.ts"
// M46c G2: paste source retention helpers (the chip labels/threshold) + the
// default /workflow surface (the real @i-harness/workflow-backed host).
import { isSizeablePaste, pasteLabel } from "../views/prompt.ts"
// M49 Task 7: the grapheme-safe PromptEditor — the ONE transaction path for
// every prompt mutation (insert/delete/newline/motion/paste/history/stash/
// mouse/external editor) + the history rewind math.
import { createPromptEditor } from "../editor/index.ts"
import type { PromptEditor } from "../editor/index.ts"
import { historyRewind } from "../editor/history.ts"
import type { WorkflowSurface } from "../contracts.ts"
import { createDefaultWorkflowSurface } from "./slash/impl/workflow2.ts"
import { doctorLiveBrand, doctorLiveDark, doctorRows } from "../views/light-doctor.ts"
// M46b G2: mouse click semantics — the dispatch core + the injectable
// clipboard (the only copy path). G1's hover engine lives on app.mouse.engine
// (constructed below; present settles it per frame) and the wheel stream is
// G1's ScrollStreamNormalizer (push on events, onTick drain on the anim pump).
import { MouseRouter } from "./mouse.ts"
import { defaultClipboard, checkedCopy } from "./clipboard.ts"
import type { Clipboard } from "./clipboard.ts"
import { goalRows } from "../views/light-goal.ts"
import { usageRows } from "../views/light-usage.ts"
// M49 Task 10: the ONE active modal/viewer union — the input owner routes
// keys/mouse here before panes→prompt→scrollback; the block viewer is the
// typed tool surface (presentTool over the engine's ToolViewInfo); the line
// viewer reads the REAL file.
import { ModalOwner, createFileViewer, modalHitTargets } from "../views/modal.ts"
import { createBlockViewer, createTaskPresentation } from "../views/block-viewer.ts"
import { presentTool } from "../tool-presentation/index.ts"
import type { AgentTaskView, ToolViewInfo } from "../contracts.ts"
import type { TaskEntry, TaskGroup } from "../views/tasks-pane.ts"
// M49 Task 13: the local dashboard state + the status-line truth source
// (spec §8.3/§9.6) — pure modules, real values only.
import { createDashboardState } from "../views/dashboard-state.ts"
import type { DashboardState } from "../views/dashboard-state.ts"
import {
  STATUS_LINE_MIN_REFRESH_MS,
  collectStatus,
  type StatusLineState,
  type StatusAggregateInput,
  type StatusCommandContext,
  type StatusCommandSource,
  type StatusLineSegmentKind,
} from "./status-source.ts"

export interface InputSource {
  next(): AsyncIterable<InputEvent>
}

export interface TuiAppOptions {
  renderer: Renderer
  backend: BackendClient
  engine: ScrollbackEngine
  capabilities: TerminalCapabilityContext
  palette: Palette
  glyphs: GlyphSet
  /** Sink for flush bytes ("", when a frame is identical, writes nothing). */
  write?: (s: string) => void
  /** Info-line/status model label (M38b G2): a REAL value known by the HOST
   * (the --model spec) — the backend's own modelLabel (e.g. the embedded
   * bridge's seam) is the second source; an honest fallback text when both
   * are absent. Never a fabricated model identity. */
  modelLabel?: string
  input?: InputSource
  compact?: boolean
  /** Test clock — defaults to Date.now(). */
  now?: () => number
  /** Pane/overlay seeds (M37b, additive) — content backed by the HOST. */
  initialPanes?: PaneState
  /** Start on the welcome screen (spec §2a) instead of the agent screen. */
  initialScreen?: "agent" | "welcome"
  /** Slash registry adapter (spec §10 #8: builtin+skill+ACP → this option). */
  slashCommands?: SlashEntry[]
  /** `@`-file search adapter (fs-search lands M38-real; host may mock). */
  searchFiles?: (query: string) => Promise<SearchResult[]>
  /** Completions for slash args (shell completion is skipped, spec §10 #10). */
  completions?: () => CompletionEntry[]
  /** Session listing adapter (G1's listSessionsFromStore plugs in here). */
  listSessions?: () => Promise<SessionSummary[]>
  /** UI surface mode (M38a G2): fullscreen cell TUI (default) or the minimal
   * live-region view (spec §0/§1.1 — the terminal's own scrollback holds
   * history; the loop writes through the InlineHost, not the cell buffer). */
  mode?: "fullscreen" | "minimal"
  /** FPS/scroll debug HUD (M39, spec §3.12): the top-right 32-col panel
   * (`fps:.. p50:..ms p95:..ms` + `scroll: {lineCount} lines`), drawn last
   * after every present. OFF by default — no meter is allocated and no panel
   * is drawn (zero overhead). Fullscreen real only; minimal mode has no cell
   * buffer, so the panel has no surface there (the loop still samples). */
  hud?: boolean
  /** Already-constructed minimal live-region host (G1's engine adapter). */
  inline?: InlineHost
  /** Lazy live-region factory — hosts wire G1's module dynamically (dynamic
   * import keeps the host compiling while G1 is in flight); resolving
   * undefined falls back to the fullscreen agent view. */
  inlineFactory?: () => Promise<InlineHost | undefined>
  /** Slash relay (spec §1): `/minimal`/`/fullscreen` — the host's ModeSwitch
   * spawns the same session relaunched in the target mode (returns true =
   * handled; the loop quits). */
  modeSwitch?: (cmd: string) => boolean
  /** M49 Task 6: the provider controller behind `/provider`, `/model`,
   * `/settings` + Ctrl+M/F2/Ctrl+, — host-constructed over real settings +
   * credentials + the live backend (provider-runtime is the write path;
   * session-model selections ride the backend's setSessionModel capability).
   * Absent → the modal slash surfaces toast "provider UI: host store not
   * wired". */
  providerController?: ProviderController
  /** M46a G2: workspace root — the skills/hooks/plugins/workflow scans
   * (eco panels) land under it. Absent → process.cwd() at run time. */
  workspace?: string
  /** Initial session id when the host knows it. Later backend session/open
   * events replace it for session-aware slash commands. */
  sessionId?: string
  /** M46b G2: clipboard injection seam — tests assert the copied payloads
   * (drag auto-copy, cwd chip copy, prompt-selection copy, copy-block) on an
   * injected recorder; absent → the system clipboard (never in tests). */
  clipboard?: Clipboard
  /** M46b G2: prompt file-ref double-click → the line-viewer seam (the
   * @-file-search adapter plugs in here). Absent → honest toast. */
  openLineViewer?: (file: string, line?: number) => void
  /** M46b G1: the mouse scroll-stream prefs (the settings modal's Mouse
   * category — the HOST reads the durable settings store and passes them in;
   * absent → grok defaults: speed 50 (1.0×), auto mode, brand profile
   * lines/tick, no invert). */
  mousePrefs?: MouseStreamPrefs
  /** M46b G1: the mouse-reporting-toggle FEATURE flag — the host resolves
   * `[ui] mouse_reporting_toggle` (GROK_MOUSE_REPORTING_TOGGLE forces it ON).
   * OFF (default): Ctrl+R stays 'none' + /toggle-mouse-reporting stays
   * hidden+inert. ON: both toggle `app.mouse.enabled` (capture/hover). */
  mouseToggleFeature?: boolean
  /** M46c G2: the /workflow surface host (contracts.ts WorkflowSurface) —
   * the real @i-harness/workflow-backed surface is the default (registry scan
   * + executor with the local exec shim); hosts/tests inject a fake instead. */
  workflow?: WorkflowSurface
  /** M46c G1: the turn timeline rail ON (app.showTimeline) — the host opt-in
   * (default OFF; the rail replaces the scrollback's right 2 columns only
   * while ON && pane width >= 60 && turns >= 2; /timeline toggles it). */
  showTimeline?: boolean
  /** M49 Task 7: the persisted `busyEnter` setting (spec §6.2) — Enter while a
   * turn is RUNNING: "steer" sends the text as an interject (interrupt),
   * "queue" submits (the backend runs it after the current turn). Host-
   * resolved durable knob; default queue (the pre-M49 submit behavior). */
  busyEnter?: BusyEnter
  /** M49 Task 8 (review r1): the persisted theme — seeds app.theme so the
   * runtime state matches the palette the host resolved. Without it the state
   * starts "auto" even on a concrete persisted theme, bare /theme would anchor
   * at "system" after a restart and silently overwrite the user's choice.
   * Absent → "auto" (legacy hosts/tests). */
  initialTheme?: SettingsTheme
  /** M49 Task 13 (spec §9.6): the status line. Absent / no mode → the legacy
   * builtin row (pre-M49 hosts keep their exact rendering). mode "disabled"
   * hides the row; "builtin" (default when the option is present) derives
   * every segment from the app's REAL values + the host extras below;
   * "command" renders the injected command source's sanitized text. */
  statusLine?: StatusLineOptions
  /** M49 Task 13 (spec §8.3): the persisted dashboard pins/order
   * (tui.prefs.dashboard) — ids only; missing ids are ignored for display and
   * are deleted only after the next successful commit (the host prunes via
   * state.pruneMissing after its settings write resolves). */
  dashboardPrefs?: { pinned: string[]; order: string[] }
  /** M49 Task 13: the dashboard pin/order persistence hook — the loop forwards
   * the current id lists here on every pin/unpin/order change and NEVER
   * writes settings itself (the host owns the store — it writes
   * tui.prefs.dashboard). When the RESOLVED promise settles successfully the
   * loop prunes missing ids from its state (the "deleted only after the next
   * successful commit" rule); a rejection keeps them. */
  onDashboardPrefs?: (prefs: { pinned: string[]; order: string[] }) => Promise<unknown> | void
}

/** M49 Task 13: the status-line host option (spec §9.6). */
export interface StatusLineOptions {
  mode?: "disabled" | "builtin" | "command"
  /** Host-resolved REAL git branch (apps/tui probes the workspace HEAD);
   * absent → the branch segment is omitted (unknown is never fabricated). */
  branch?: string
  /** The persisted tui.prefs.statusLine.items allowlist (builtin mode); absent
   * → every sourced configurable segment renders. */
  items?: readonly StatusLineSegmentKind[]
  /** Command-mode source (createCommandStatusSource over the host's exec
   * runner — workspace cwd, JSON stdin, 1000ms timeout, sanitized + capped). */
  commandSource?: StatusCommandSource
  /** The command refresh interval (ms) — the loop's cadence floor is 300ms
   * (spec §9.6); the source itself never drops an explicit refresh. */
  commandRefreshMs?: number
}

/** One-time executable startup inputs. `renderWelcomeBeforeModel` lets the
 * real terminal paint the shell before a potentially slow provider probe;
 * legacy tests that call start() directly use the compatibility path. */
export interface TuiStartupOptions {
  sessionId?: string
  prompt?: string
  renderWelcomeBeforeModel?: boolean
  legacyUnsupportedToAgent?: boolean
}

/** Minimal live-region host (M38a G2) — what the loop drives in minimal
 * mode. A host wraps G1's InlineLiveRegion (contracts.ts): commit pushes
 * print-once content into the native scrollback; drawRegion repaints the
 * region rows; everything lands in the app's write sink (ledger). */
export interface InlineHost {
  /** Append committed content above the region (print-once). */
  commit(lines: RegionLine[], write: (s: string) => void): void
  /** Repaint the live-region rows (tail window + status + prompt). */
  drawRegion(write: (s: string) => void): void
  /** Height of the live region at the current geometry. */
  regionRows(): number
  /** Resize geometry (next drawRegion full-repaints). */
  resize(cols: number, rows: number): void
  /** Push G2-composed region rows (tail window + todos + status + prompt).
   * OPTIONAL harmonization seam — the G1 contract exposes no region-content
   * setter; hosts that omit it repaint their own commit-window only. */
  setRegion?(lines: RegionLine[]): void
}

const ANIM_MS = 33 // 30fps pump

/** M49 Task 10: last path segment (the line-viewer toasts label the file). */
function basenameOf(file: string): string {
  const i = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))
  return i === -1 ? file : file.slice(i + 1)
}

/** M47 G2: the live /doctor probe's paint-suspend window (≤800ms — settled
 * earlier when the run's answers are complete; released on timeout, no
 * deadlock; the query bytes arrive back through the input path's parser
 * hooks and are accepted even after the window — no second suspend). */
const PROBE_SUSPEND_MS = 800
const PROBE_SUSPEND_REASON = "live /doctor probe"

/** M47 G2: the line viewer's row window (the block view around the matched
 * line — same window the /plan plan-text viewer uses). */
const LINE_VIEWER_ROWS = 24

/** M46a G1: the TUI provider protocol vocabulary (the /provider arg parse).
 * M49: the arg values are canonicalized to the settings plane vocabulary
 * when the draft is built (openai-compatible → openai-completions,
 * anthropic → anthropic-messages). */
const TUI_PROTOCOLS = ["openai-responses", "openai-compatible", "anthropic", "gemini", "bedrock"] as const

/** The /provider arg protocol → the canonical settings plane vocabulary. */
function canonicalProtocolOf(value: string): SettingsProviderProtocol | undefined {
  if (value === "openai-compatible") return "openai-completions"
  if (value === "anthropic") return "anthropic-messages"
  if (value === "openai-responses" || value === "gemini" || value === "bedrock") return value
  return undefined
}

/** M49 Task 12: the real task-view groups (spec §8.2) — a group appears ONLY
 * when it has rows (its truth is the backend projection); the collapse state
 * survives refreshes by group label. `[✗]` rides a row only when the backend
 * carries the cancel capability AND the registry says canCancel. */
function groupTaskViews(
  items: AgentTaskView[],
  backendCanCancel: boolean,
  now: number,
  prev: TaskGroup[] | undefined,
): TaskGroup[] {
  const labels: Record<AgentTaskView["group"], TaskGroup["label"]> = {
    subagent: "Subagents",
    job: "Background",
    workflow: "Workflows",
    schedule: "Schedule",
  }
  const order: Array<AgentTaskView["group"]> = ["subagent", "job", "workflow", "schedule"]
  const prevCollapsed = new Map((prev ?? []).map((g) => [g.label, g.collapsed === true]))
  const out: TaskGroup[] = []
  for (const group of order) {
    const rows = items.filter((row) => row.group === group)
    if (rows.length === 0) continue
    out.push({
      label: labels[group],
      entries: rows.map((row): TaskEntry => ({
        id: row.id,
        status: row.status,
        label: row.label,
        ...(row.startedAt !== undefined ? { elapsed: elapsedText(now - row.startedAt) } : {}),
        action: row.canCancel && backendCanCancel ? "cancel" : "expand",
      })),
      ...(prevCollapsed.get(labels[group]) === true ? { collapsed: true } : {}),
    })
  }
  return out
}

/** Elapsed text, e.g. "2m10s" / "3s" (the pane's duration surface). */
function elapsedText(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  return `${m}m${sec % 60}s`
}

/** Case-insensitive subsequence hit indices (fuzzy-hit letters, spec §3.6). */
function fuzzyHits(command: string, query: string): number[] {
  const c = command.toLowerCase()
  const q = query.toLowerCase()
  const out: number[] = []
  let qi = 0
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) {
      out.push(i)
      qi++
    }
  }
  return out
}

/** M49 Task 7: the persisted `busyEnter` setting (spec §6.2 — the host
 * resolves the durable knob; default queue = the pre-M49 submit behavior). */
export type BusyEnter = "steer" | "queue"

export class TuiApp {
  private readonly opts: TuiAppOptions
  private readonly app: TuiAppState
  private stopped = false
  private frameQueued = false
  private animTimer: ReturnType<typeof setInterval> | null = null
  private runP: Promise<unknown> = Promise.resolve()
  private startupP: Promise<void> | undefined
  private welcomeActionP: Promise<void> | undefined
  private armedQuit = false
  /** M43: the empty-Esc rewind arming arm (spec §4: Esc 空+≥1 turn → rewind
   * picker on the second press; distinct from armedQuit — Ctrl+Q/Ctrl+C own
   * that). */
  private armedRewind = false
  private turnStartedAt = 0
  private phaseStartedAt = 0
  /** UI surface mode (M38a): distinct from `app.mode` (normal/plan discipline). */
  private readonly uiMode: "fullscreen" | "minimal"
  private inlineHost: InlineHost | undefined
  private inlineResolved = false
  private commits: MinimalCommits | undefined
  /** In-flight backend.context() probe (M38b G2) — never two concurrent
   * refreshes; the promise itself is the guard. */
  private contextProbe: Promise<void> | undefined
  /** Invalidates async session-derived probes when session/open commits. */
  private sessionGeneration = 0
  private currentSessionId: string | undefined
  /** M49 Task 13: the last RESOLVED model state (the builtin status row's
   * model segment source — ready → the label; anything else → unknown →
   * omitted, never a fabricated identity). */
  private lastModelState: BackendModelState | undefined
  /** M49 Task 13: the surface the dashboard was opened from (backFromDashboard
   * returns there — "Agent→Dashboard preserves filter/cursor"). */
  private dashboardFrom: "welcome" | "agent" = "agent"
  /** M49 Task 13: in-flight status-line recompute (never two concurrent — the
   * promise itself is the guard, same pattern as refreshContext). */
  private statusLineProbe: Promise<void> | undefined
  /** M49 Task 13: the command-status cadence clock (spec §9.6 — refreshes no
   * faster than max(300ms, refreshMs); the source never blocks this). */
  private lastCommandRefreshAt = 0
  /** M46c G2: the /workflow surface (host option else the default real host) —
   * cached per app so the executor's process-shared job store is one instance. */
  private workflowHost: WorkflowSurface | undefined
  /** M39 debug HUD meter — allocated ONLY when opts.hud is on (zero otherwise). */
  private fpsMeter: FpsMeter | undefined
  /** M46a G2: the slash command registry (builtin map + visible gate). */
  private readonly slash: CommandRegistry = defaultRegistry()
  /** M46a G2: the ACTIVE palette — the host's at start; /theme re-resolves
   * (resolvePalette groknight/grokday/auto) and every frame draws with it. */
  private palette: Palette
  /** M46b G2: the clipboard injection layer (options ?? system clipboard). */
  private readonly clipboard: Clipboard
  /** M49 Task 10: THE one-active-modal input owner. While a modal is open,
   * every key routes here FIRST (owning input before panes→prompt→scrollback);
   * closing clears app.modal through the onClose wiring below. */
  private readonly modalOwner: ModalOwner
  /** M47 G2: the ACTIVE capability context — the host's at start; the live
   * /doctor probe's answers merge into it (present + the report rows read it;
   * theme re-resolves use it too). */
  private cap: TerminalCapabilityContext
  /** M49 Task 7: the prompt editor — the AUTHORITATIVE prompt model. The view
   * state (app.prompt) is a projection: text = value(), cursor = cursor(),
   * pasteStash = the editor's paste atoms (the M46c chip rows). Every prompt
   * mutation routes through here — never direct UTF-16 writes. */
  readonly editor: PromptEditor = createPromptEditor()
  /** M49 Task 14 (spec §9.7): the runtime terminal mouse-capture toggle — the
   * real byte seam (enable/disable ONLY on transitions); minimal/no-mouse
   * terminals ignore attempts and stay OFF. */
  private readonly mouseReporting: MouseReportingToggle
  /** M47 G2: paint-suspend (the live /doctor probe) — while set and unexpired
   * frame() writes NOTHING (no present, no flush, no minimal repaint); the
   * probe owns the tty. Cleared by the run's settle (answers or ≤800ms
   * timeout) or by an expired window. */
  probeSuspend: { until: number; reason: string } | undefined
  /** M47 G2: the last/active live-probe run (collects the classified answers;
   * stays after settle so LATE replies still refresh the report). */
  private probeRun: { until: number; done: boolean; collect: { brand?: string; dark?: boolean; kitty?: boolean } } | undefined
  private probeRunP: Promise<void> | undefined
  private probeRunResolve: (() => void) | undefined
  private probeTimer: ReturnType<typeof setTimeout> | undefined
  /** M46b G2: the mouse click-semantics router (geometry only read while a
   * mouse event arrives). */
  private mouse!: MouseRouter
  /** M46b G1: the scroll STREAM (grok wheel/trackpad normalization) — push on
   * wheel events, onTick drain on the anim pump; the M40 ±3 wheel path is
   * REPLACED by this (the ±3 fallback comment lives in onInput for the
   * pre-M46b note). */
  private readonly scrollNormalizer: ScrollStreamNormalizer
  /** M46b G1: the scroll-stream prefs — the host's settings wiring when
   * passed (TuiAppOptions.mousePrefs), else the grok defaults (speed 50 →
   * 1.0×, auto mode, brand-profile lines/tick, no invert — the settings
   * modal persists the same shape). */
  private mousePrefs(): MouseStreamPrefs {
    const p = this.opts.mousePrefs
    if (p === undefined) return { speed: 50, mode: "auto", invert: false }
    return {
      speed: Math.max(1, Math.min(100, p.speed)),
      mode: p.mode,
      ...(p.lines !== undefined ? { lines: Math.max(1, Math.min(10, p.lines)) } : {}),
      invert: p.invert,
    }
  }

  /** M46b G1: the mouse-reporting-toggle feature gate (host-resolved; OFF by
   * default — the Ctrl+R binding + /toggle-mouse-reporting are inert). */
  private mouseToggleFeature(): boolean {
    return this.opts.mouseToggleFeature === true
  }

  constructor(opts: TuiAppOptions) {
    this.opts = opts
    this.currentSessionId = opts.sessionId
    this.uiMode = opts.mode ?? "fullscreen"
    this.palette = opts.palette
    this.clipboard = opts.clipboard ?? defaultClipboard()
    // M49 Task 10: the modal input owner — onClose clears the state + repaint.
    this.modalOwner = new ModalOwner({
      onClose: () => {
        this.app.modal = undefined
        this.requestFrame()
      },
    })
    this.cap = opts.capabilities
    this.mouseReporting = createMouseReportingToggle(opts.capabilities)
    this.probeSuspend = undefined
    // M46b G1: the wheel stream (brand profile + knob defaults while the
    // settings snapshot wiring feeds real prefs — mousePrefs() above).
    this.scrollNormalizer = new ScrollStreamNormalizer(
      { brand: opts.capabilities.brand, multiplexer: opts.capabilities.multiplexer === "none" ? "" : opts.capabilities.multiplexer },
      this.mousePrefs(),
      { viewportRows: opts.renderer.buffer.height, now: opts.now },
    )
    if (opts.hud === true) {
      this.fpsMeter = new FpsMeter()
      this.fpsMeter.start()
    }
    // M38b G2: REAL model label — the host's --model spec when wired, else the
    // backend's own knowledge (embedded's modelLabel seam); otherwise display
    // an honest unconfigured state instead of fabricating a model identity.
    const model = this.opts.modelLabel ?? this.opts.backend.modelLabel ?? "unconfigured"
    this.app = {
      title: "untitled",
      mode: "normal",
      engine: opts.engine,
      prompt: { text: "", cursor: 0, multiLine: false, focused: true, model, plan: false, title: "untitled", pasteStash: [] },
      promptCursor: 0,
      history: [],
      historyIndex: 0,
      scroll: { offset: 0, follow: true },
      focused: "prompt",
      search: undefined,
      status: {
        branch: undefined,
        // M49 Task 13: the cwd segment is the host workspace when wired
        // (production always passes it; legacy hosts keep the placeholder).
        path: opts.workspace ?? "~/workspace",
        tickMs: 0,
        model,
        plan: false,
        contextUsed: undefined,
        contextTotal: undefined,
        todo: { done: 0, total: 0 },
        tasks: { running: 0, labels: [] },
        queue: 0,
        mcp: null,
      },
      turn: undefined,
      toasts: [],
      panes: new Set<string>(),
      shortcuts: { items: shortcutsFor({ focused: "prompt", multiLine: false, turnRunning: false, mode: "normal" }) },
      view: { kind: "welcome" },
      // Keep the pre-M49 static-test surface on Agent until initialize() owns
      // startup. Production calls initialize before start; older PTY hosts
      // call start directly and take the explicit legacy fallback below.
      screen: opts.initialScreen ?? (this.uiMode === "minimal" ? "minimal" : "agent"),
      welcome: {
        version: "0.1.0",
        menus: [
          { action: "new", key: "ctrl+n", label: "New session" },
          { action: "resume", key: "ctrl+s", label: "Resume session" },
          // M49 Task 13 (spec §8.3): the Dashboard shares one view with
          // /dashboard — an Enter on the row opens the same local view.
          { action: "dashboard", key: "ctrl+\\", label: "Dashboard (local sessions)" },
          { action: "settings", key: "F2", label: "Settings" },
          { action: "quit", key: "ctrl+q", label: "Quit" },
        ],
        cursor: 0,
        modelState: { status: "loading" },
      },
      paneData: opts.initialPanes,
      // M46a G2: the real toggle knobs. M49 Task 8 (review r1): the seed
      // honors the host's active/persisted theme — system-following displays
      // as "auto"; a concrete persisted theme becomes the runtime anchor so
      // bare /theme cycles FROM it instead of "system".
      theme: opts.initialTheme === undefined || opts.initialTheme === "system" ? "auto" : opts.initialTheme,
      timestamps: false,
      compactMode: false,
      autoApprove: false,
      // M46c G1: the turn timeline rail (spec §3.12) — HOST-opt-in default OFF
      // (the existing scene tests pin exact 80-col rows; the rail replaces the
      // right 2 columns only when on — deviation loud in the report: grok
      // defaults appearance.show_timeline ON, we default OFF for test/stability
      // parity with the compact/wt option style; /timeline toggles).
      showTimeline: opts.showTimeline === true,
      draft: undefined,
      lightPanel: undefined,
      // M46b G1+G2: the hover state — the loop constructs the engine (the
      // views register their HitArea rects during present; present settles
      // the last-Moved coordinate every frame). `enabled` gates the whole
      // mouse path (G1's mouse-reporting toggle flips it).
      mouse: { enabled: true, last: { col: 0, row: 0 }, hovered: new Set(), engine: new HoverEngine() },
      // M49 Task 13: the shared dashboard state (the persisted pins/order ids
      // seed only what tui.prefs.dashboard carries — missing ids are kept
      // until the next successful commit, never eagerly pruned).
      dashboard: createDashboardState([], opts.dashboardPrefs),
      dashboardLoading: false,
      dashboardUnavailable: false,
      dashboardFetchFailed: false,
      dashboardPeek: undefined,
      statusLine: opts.statusLine !== undefined ? (opts.statusLine.mode ?? "builtin") : undefined,
    }
    this.initMouse()
  }

  /** M46b G2: the mouse router — bounds the loop's widget semantics to the
   * router's hooks (loop-owned behaviors) + the injected clipboard. */
  private initMouse(): void {
    // M49 Task 14 (spec §9.7): the runtime seam's settled state must MATCH the
    // app's capture state — the fullscreen host already emitted the init
    // capture bytes (app.mouse starts enabled). Warm the seam (discard the
    // warm-up return bytes — the host owns the init emission; the first
    // USER toggle is a real transition and emits the disable bytes).
    this.mouseReporting.set(this.app.mouse?.enabled === true)
    this.mouse = new MouseRouter({
      app: this.app,
      engine: this.opts.engine,
      size: () => ({ cols: this.opts.renderer.buffer.width, rows: this.opts.renderer.buffer.height }),
      now: () => this.opts.now?.() ?? Date.now(),
      clipboard: this.clipboard,
      glyphs: this.opts.glyphs,
      compact: this.opts.compact,
      hooks: {
        focus: (target) => this.focus(target),
        overlaySelectRow: () => this.overlaySelect(),
        openLineViewer: (file, line) => this.openLineViewer(file, line),
        openGoalDetail: () => this.openLightPanel({
          kind: "goal",
          title: "Goal",
          rows: goalRows(this.app.status.goal),
        }),
        openUsagePanel: () => this.openLightPanel({
          kind: "usage",
          title: "Usage",
          rows: usageRows({
            used: this.app.status.contextUsed ?? 0,
            ...(this.app.status.contextTotal !== undefined ? { total: this.app.status.contextTotal } : {}),
          }),
        }),
        openPlanView: () => this.openLightPanel({
          kind: "plan",
          title: "Plan",
          rows: this.lastAssistantRows().map((r) => ({ label: r.label })),
        }),
        // M46c G1: timeline tick/chevron click → jump the viewport to the
        // turn anchor display line (the /jump goTo seam — same scroll set).
        timelineJump: (line) => {
          this.app.scroll = { offset: Math.max(0, line), follow: false }
          this.requestFrame()
        },
        // M46c G2: paste-chip double-click → INSERT the retained source at the
        // cursor (the honest "source not retained" toast is superseded).
        // M49 Task 7: the double-click EXPANDS the editor's paste atom (the
        // source is already in the text — the chip is its atomic envelope).
        insertPasteStash: (index) => this.expandPasteStash(index),
        // M49 Task 11: the queue [cancel] chip fires the SAME action as the
        // app-level cancelQueueItem (cancel + refresh from backend truth).
        queueCancel: (id) => { void this.cancelQueueItem(id) },
        // M49 Task 13: dashboard row double-click → the SAME open action the
        // Enter key uses (keyboard and mouse share one action, spec §8.3).
        openDashboardSession: (id) => {
          this.app.dashboard?.select(id)
          void this.openSelectedDashboardSession()
        },
        // M49 Task 12: the tasks-pane row actions fire the SAME app actions as
        // the keyboard path (cancel + refresh from backend truth / viewer);
        // the status-chip toggle routes through togglePane so opening
        // refreshes the real rows (never a blank pane).
        taskCancel: (id) => { void this.cancelTaskId(id) },
        openTaskViewer: (id) => { void this.openTaskViewer(id) },
        tasksPaneToggle: () => this.togglePane("tasks"),
        // M49 Task 7: the click moves the PromptEditor cursor (atom-safe) —
        // never a direct string write.
        movePromptCursor: (index) => {
          this.reconcileEditor()
          this.editor.moveTo(index)
          this.syncPrompt()
          this.refreshDropdowns()
        },
        onChanged: () => this.requestFrame(),
      },
    })
  }

  /** M46b G2: prompt file-ref double-click → the line viewer (the @-file-search
   * seam plugs its viewer here). M47 G2: the seam is now REAL — the host's
   * viewer when wired (openLineViewer option); otherwise the engine's block
   * walk: the light-panel block viewer for the first block whose header/title
   * contains the ref (read/execute block), cursor at the ref line, Enter jumps
   * the scrollback viewport there. A ref in no block keeps the honest toast.
   */
  private openLineViewer(file: string, line?: number): void {
    const open = this.opts.openLineViewer
    if (open !== undefined) {
      open(file, line)
      return
    }
    // M49 Task 10: the LINE VIEWER reads the REAL file when it can resolve
    // one (absolute path, or a ref under a known workspace) and positions the
    // exact 1-based line. An unresolvable/missing file falls through to the
    // engine block walk (M47 baseline) — the honest toast path stays there.
    const target = isAbsolute(file)
      ? file
      : this.opts.workspace !== undefined
        ? join(this.opts.workspace, file)
        : undefined
    if (target !== undefined) {
      void this.tryRealFileViewer(target, line)
        .then((opened) => { if (!opened) this.blockWalkLineViewer(file, line) })
      return
    }
    this.blockWalkLineViewer(file, line)
  }

  /** M49 Task 10: read the REAL file and open the line viewer in the modal
   * union (exact lines, exact 1-based cursor). Returns false when reading
   * failed (the honest fallback then runs the block walk). */
  private async tryRealFileViewer(target: string, line?: number): Promise<boolean> {
    if (this.inlineActive()) return false
    const view = await createFileViewer(target, {
      line,
      copy: async (text) => {
        const r = await checkedCopy(this.clipboard, text)
        if (!r.ok) throw new Error(r.error)
      },
    })
    if (view.error !== undefined) {
      this.toast(`line viewer: ${basenameOf(target)}${line !== undefined ? `:${line}` : ""} — ${view.error}`)
      return false
    }
    this.modalOwner.open({ kind: "line-viewer", view })
    this.app.modal = { kind: "line-viewer", view }
    this.requestFrame()
    this.toast(`line viewer: ${basenameOf(target)} → ${view.lines.length} lines`)
    return true
  }

  /** M47 baseline: the engine block walk light panel (see the method note). */
  private blockWalkLineViewer(file: string, line?: number): void {
    const eng = this.opts.engine
    const total = eng.lineCount()
    const suffix = line !== undefined ? `:${line}` : ""
    if (total <= 0 || file.length === 0) {
      this.toast(`line viewer: ${file}${suffix} — no block match`)
      return
    }
    // Block walk: the first display line whose block header/title contains the
    // ref (Read/Execute headers carry the tool's path — `Run {cmd}` /
    // `Read {path}`; the same title surface /jump's walk uses).
    let base = -1
    let title = ""
    const needle = file.toLowerCase()
    for (let l = 0; l < total; l++) {
      const b = eng.lineBlock(l)
      if (b === undefined || b.title.length === 0) continue
      if (b.title.toLowerCase().includes(needle)) {
        base = l
        title = b.title
        break
      }
    }
    if (base === -1) {
      this.toast(`line viewer: ${file}${suffix} — not in any block`)
      return
    }
    // Ensure the matched block is UNFOLDED before taking the rows (tool blocks
    // render folded by default — their collapsed header alone would make the
    // viewer a one-row box). The toggle may fold an already-expanded block —
    // restore it (the delta on the total display lines measures the flip).
    const beforeLines = eng.lineCount()
    eng.toggleFoldAt(base)
    if (eng.lineCount() < beforeLines) eng.toggleFoldAt(base) // was expanded — restore
    // The block viewer: the block's display rows from the matched line (24-row
    // window — same window the /plan plan-text viewer uses), cursor at the ref
    // line; Enter jumps the scrollback viewport to that row.
    const rows = eng.viewport(base, Math.min(LINE_VIEWER_ROWS, eng.lineCount() - base)).map((r) => ({
      label: r.runs.map((x) => x.text).join(""),
    }))
    const cursor = Math.max(0, Math.min(rows.length - 1, (line ?? 1) - 1))
    this.app.lightPanel = {
      kind: "line-viewer",
      title,
      rows,
      cursor,
      onSelect: (i) => {
        this.app.scroll = { offset: Math.max(0, base + i), follow: false }
        this.requestFrame()
      },
    }
    this.app.slash = undefined
    this.app.completion = undefined
    this.app.fileSearch = undefined
    this.app.historyPanel = undefined
    this.app.sessions = undefined
    this.requestFrame()
    this.toast(`line viewer (M47): ${file}${suffix} → ${title}`)
  }

  // ------------------------------------------------------------------ block viewer (M49 Task 10)

  /** Enter (alt Ctrl+F) on the scrollback — the open gate: NO overlay/
   * dropdown open, search bar idle, a tool block under the viewport's first
   * visible line (the engine resolves it — no block keeps the honest toast). */
  private blockViewerOpenKey(kbd: Kbd): boolean {
    // minimal mode has no fullscreen surface — the modal stays closed there.
    if (this.inlineActive()) return false
    // the SCROLLBACK's Enter/Ctrl+F only (a prompt-focused Enter submits;
    // the Welcome menu keeps its own Enter) — the modal is not an overlay
    // replacement.
    if (this.app.focused !== "scrollback" || this.app.screen === "welcome") return false
    if (this.overlayState() !== undefined || this.app.search?.active === true) return false
    const enter = kbd.code === "Enter" && !kbd.ctrl && !kbd.alt && !kbd.shift
    const ctrlF = kbd.code === "char" && kbd.ctrl && !kbd.alt && !kbd.shift && kbd.key.toLowerCase() === "f"
    if (!enter && !ctrlF) return false
    // M49 Task 12: a SELECTED tasks-pane row (clicked by id) makes Enter open
    // the Task viewer — before the tool-block fallback (the selection is the
    // pane's open target; it survives refreshes by stable id). The pane must
    // be OPEN — a stale selection after the status-chip close must not hijack
    // Enter. Ctrl+F NEVER routes through the selection (review finding): it
    // always opens the block viewer's find/search at the anchor — the
    // selection is Enter's own target and can be cleared by re-clicking the
    // selected row.
    if (enter) {
      const taskId = this.app.panes.has("tasks") ? this.app.paneData?.tasksSelectId : undefined
      if (taskId !== undefined) {
        void this.openTaskViewer(taskId)
        this.requestFrame()
        return true
      }
    }
    this.openBlockViewerAt(this.anchorDisplayLine())
    this.requestFrame()
    return true
  }

  /** The viewport's first visible display line (follow ⇒ the tail window) —
   * the SCROLLBACK rect's height is the real window (the renderer height
   * includes the panes/prompt rows, which would anchor the block viewer at a
   * line several rows ABOVE the visible top). */
  private anchorDisplayLine(): number {
    const total = this.opts.engine.lineCount()
    const rect = layoutAgent(
      { cols: this.opts.renderer.buffer.width, rows: this.opts.renderer.buffer.height },
      this.app,
      { compact: this.opts.compact },
    ).scrollback
    return this.app.scroll.follow ? Math.max(0, total - rect.h + 1) : Math.max(0, this.app.scroll.offset)
  }

  /** Open THE block viewer (the typed tool presentation over the engine block
   * at `line`) — the one active modal union; the modal becomes the input
   * owner; the copy adapter is the checked path (failures render the error). */
  private openBlockViewerAt(line: number): void {
    const info = this.opts.engine.toolAt?.(line)
    if (info === undefined) {
      this.toast("block viewer: no tool block at the cursor")
      return
    }
    const viewer = createBlockViewer(presentTool(info as ToolViewInfo), {
      copy: async (text) => {
        const r = await checkedCopy(this.clipboard, text)
        if (!r.ok) throw new Error(r.error)
      },
    })
    this.modalOwner.open({ kind: "block-viewer", viewer })
    this.app.modal = { kind: "block-viewer", viewer }
    this.app.slash = undefined
    this.app.completion = undefined
    this.app.fileSearch = undefined
    this.app.historyPanel = undefined
    this.app.sessions = undefined
    this.app.lightPanel = undefined
    this.requestFrame()
  }

  /** The modal's wheel scroll (3 rows/tick — scrollback parity). */
  private modalScroll(delta: number): void {
    const modal = this.app.modal
    if (modal === undefined) return
    if (modal.kind === "block-viewer") modal.viewer.move(delta)
    else modal.view.move(delta)
  }

  private modalMove(delta: number): void {
    this.modalScroll(delta)
  }

  private modalMovePage(delta: number): void {
    const modal = this.app.modal
    if (modal === undefined) return
    if (modal.kind === "block-viewer") modal.viewer.page(delta)
    else modal.view.page(delta)
  }

  // ------------------------------------------------------------------ live /doctor probe (M47 G2)

  /** M47 G2: the live /doctor probe — re-issues the capability queries through
   * the app's OWN write sink (the ledger counts them), suspends the frame
   * pump (≤800ms — released on the answers or the timeout, no deadlock, no
   * failed-run hang), and merges the answers into this.cap when it settles.
   * The answers arrive through the input path's parser hooks —
   * feedProbeReply (OSC/DCS payloads) and the unknown-CSI route — never as
   * key events. One run at a time; a repeated /doctor shares the in-flight
   * run (no re-entrant suspend). */
  private armLiveProbe(): Promise<void> {
    if (this.probeRunP !== undefined && this.probeRun !== undefined && !this.probeRun.done) {
      return this.probeRunP
    }
    const until = (this.opts.now?.() ?? Date.now()) + PROBE_SUSPEND_MS
    this.probeSuspend = { until, reason: PROBE_SUSPEND_REASON }
    this.probeRun = { until, done: false, collect: {} }
    this.probeRunP = new Promise<void>((resolve) => {
      this.probeRunResolve = resolve
    })
    // The queries go through the app's write sink (ledger-observable bytes) —
    // byte-for-byte the tui-core probe's sweep (probe/index.ts probe()).
    this.opts.write?.("\x1b[>0q")
    this.opts.write?.("\x1b[c")
    this.opts.write?.("\x1b[?27u")
    this.opts.write?.("\x1b]11;?\x07")
    // Hard cap: settles no later than 800ms whatever answers (the run's own
    // all-replies check settles earlier — the fast path).
    this.probeTimer = setTimeout(() => this.settleLiveProbe(), PROBE_SUSPEND_MS)
    return this.probeRunP
  }

  /** M47 G2 — input path → the live probe. The parser's onOsc/onDcs hooks hand
   * reply payloads here (they never become key events); the loop classifies
   * them into the run's collector. A reply arriving AFTER the run settled
   * still refreshes the report — no second suspend. */
  feedProbeReply(data: string): void {
    this.probeOnReply(data, false)
  }

  /** The live capability context (startup + the merged probe answers). */
  liveCapabilities(): TerminalCapabilityContext {
    return this.cap
  }

  /** Classify one reply — OSC/DCS hook payload (`isCsi` = false) or raw
   * unknown-CSI bytes (`isCsi` = true, the DA/DECRPM replies) — into the run.
   * The grammar mirrors tui-core's probe scan (probe/index.ts handleDcs/
   * handleOsc/handleCsi) so the live run agrees with the startup probe. */
  private probeOnReply(data: string, isCsi: boolean): void {
    const run = this.probeRun
    if (run === undefined) return
    let changed = false
    if (!isCsi) {
      // OSC/DCS hook payloads: XTVERSION (`>|…`) / OSC 11 (`…;rgb:…`).
      if (data.startsWith(">|")) {
        const brand = doctorLiveBrand(data)
        if (brand !== null && brand !== run.collect.brand) {
          run.collect.brand = brand
          changed = true
        }
      } else {
        const dark = doctorLiveDark(data)
        if (dark !== null && dark !== run.collect.dark) {
          run.collect.dark = dark
          changed = true
        }
      }
    } else {
      // Raw unknown-CSI bytes: kitty DECRPM / DA2 (DA2 = the strong WT brand;
      // DA1 is the weak hint and never settles — same as the startup probe).
      const decrpm = /^\x1b\[\?27;?(\d+)\$p$/.exec(data)
      if (decrpm !== null) {
        const kitty = parseInt(decrpm[1]!, 10) >= 1
        if (kitty !== run.collect.kitty) {
          run.collect.kitty = kitty
          changed = true
        }
      } else if (/^\x1b\[\?27u$/.test(data)) {
        if (run.collect.kitty !== true) {
          run.collect.kitty = true
          changed = true
        }
      } else if (data.startsWith("\x1b[>1;95")) {
        if (run.collect.brand !== "WindowsTerminal") {
          run.collect.brand = "WindowsTerminal"
          changed = true
        }
      }
    }
    if (!changed) return
    if (run.done) {
      // A reply AFTER the window: accept + refresh the report (no second
      // suspend — the panel updates without holding the tty).
      this.cap = this.mergeLiveCap(run)
      this.refreshDoctorPanel()
      this.requestFrame()
      return
    }
    if (run.collect.brand !== undefined && run.collect.dark !== undefined && run.collect.kitty !== undefined) {
      this.settleLiveProbe()
    }
  }

  private settleLiveProbe(): void {
    const run = this.probeRun
    if (run === undefined || run.done) return
    run.done = true
    if (this.probeTimer !== undefined) {
      clearTimeout(this.probeTimer)
      this.probeTimer = undefined
    }
    this.probeSuspend = undefined
    this.cap = this.mergeLiveCap(run)
    this.refreshDoctorPanel()
    this.requestFrame()
    const resolve = this.probeRunResolve
    this.probeRunResolve = undefined
    this.probeRunP = undefined
    resolve?.()
  }

  /** Live answers → the capability context: env-derived fields re-read at
   * probe time (the same math as tui-core's buildResult env branch) + the
   * answered reply fields; UNANSWERED reply-fields keep the previous
   * knowledge (a partial live run never regresses the report to defaults). */
  private mergeLiveCap(run: { collect: { brand?: string; dark?: boolean; kitty?: boolean } }): TerminalCapabilityContext {
    const env = process.env
    const ct = (env.COLORTERM ?? "").toLowerCase()
    const term = (env.TERM ?? "").toLowerCase()
    const colorLevel =
      ct.includes("truecolor") || ct.includes("24bit") ? "truecolor"
      : term.includes("256color") ? "ansi256"
      : "ansi16"
    const modern = colorLevel === "truecolor" || colorLevel === "ansi256"
    return {
      ...this.cap,
      colorLevel,
      multiplexer: env.ZELLIJ !== undefined ? "zellij" : env.TMUX !== undefined ? "tmux" : "none",
      mouse: modern,
      bracketedPaste: modern,
      focusEvents: modern,
      synchronizedOutput: modern,
      ...(run.collect.brand !== undefined ? { brand: run.collect.brand } : {}),
      ...(run.collect.dark !== undefined ? { dark: run.collect.dark } : {}),
      ...(run.collect.kitty !== undefined ? { kitty: run.collect.kitty } : {}),
    }
  }

  /** The doctor panel rows = the LIVE context (while the panel is open). */
  private refreshDoctorPanel(): void {
    const lp = this.app.lightPanel
    if (lp === undefined || lp.kind !== "doctor") return
    lp.rows = doctorRows(this.cap)
  }

  /** Coordinator state (the loop mutates; tests/host read). */
  state(): TuiAppState {
    return this.app
  }

  /** M46b G1: the input injection seam — feeds one InputEvent through the same
   * path pumpInput uses (onInput). Tests drive mouse events deterministically
   * without a TTY; hosts never need it (attachInput owns the queue). */
  feedInput(ev: InputEvent): void {
    this.onInput(ev)
  }

  /** Resolve the startup model gate and any explicit session before the event
   * pumps begin. Idempotent so executable composition may initialize first
   * and start() can retain a defensive fallback for older hosts. */
  initialize(options: TuiStartupOptions = {}): Promise<void> {
    this.startupP ??= this.initializeOnce(options)
    return this.startupP
  }

  private async initializeOnce(options: TuiStartupOptions): Promise<void> {
    if (options.prompt !== undefined) {
      // M49 Task 7: the startup prompt seeds the editor (never a raw write).
      this.editor.replaceAll(options.prompt, this.nowMs())
      this.syncPrompt()
    }
    if (options.renderWelcomeBeforeModel === true && this.uiMode === "fullscreen") {
      this.activateWelcome()
      this.frame()
    }

    let modelState: BackendModelState
    try {
      modelState = await this.opts.backend.modelState()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (options.legacyUnsupportedToAgent === true && /session-model unavailable/i.test(reason)) {
        // Old unit/PTY hosts intentionally expose no Task 4 model capability.
        // Preserve their pre-M49 Agent rendering without weakening production,
        // whose executable path never opts into this compatibility branch.
        this.app.view = undefined
        return
      }
      modelState = { status: "invalid", reason }
    }
    this.applyModelState(modelState)

    const explicitSessionId = options.sessionId?.trim()
    if (explicitSessionId !== undefined && explicitSessionId !== "") {
      try {
        await this.opts.backend.open(explicitSessionId)
        this.activateAgent(explicitSessionId)
      } catch (error) {
        this.setStartupError(`session open failed: ${error instanceof Error ? error.message : String(error)}`)
        this.activateWelcome()
        this.requestFrame()
        return
      }
      if (options.prompt !== undefined && options.prompt.trim() !== "" && modelState.status === "ready") {
        this.acceptPrompt(options.prompt)
      }
      this.requestFrame()
      return
    }

    if (options.prompt !== undefined && options.prompt.trim() !== "") {
      if (modelState.status === "ready") {
        await this.createSessionAndSubmit(options.prompt)
      } else {
        this.activateWelcome()
      }
      this.requestFrame()
      return
    }

    if (this.uiMode === "minimal") {
      try {
        const first = (await this.opts.backend.listSessions())[0]
        if (first !== undefined) {
          await this.opts.backend.open(first.id)
          this.activateAgent(first.id)
        }
      } catch (error) {
        this.setStartupError(`session open failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      this.activateWelcome()
    }
    this.requestFrame()
  }

  /** Launch the pumps; resolves when the input/backend iterators finish. */
  async start(): Promise<void> {
    this.stopped = false
    await this.resolveInlineNow()
    // Minimal requested without a host (no inline option / factory resolved
    // undefined) falls back to the fullscreen agent view.
    if (this.uiMode === "minimal" && this.inlineHost === undefined) {
      this.app.screen = "agent"
    }
    if (this.startupP === undefined) {
      await this.initialize({ legacyUnsupportedToAgent: true })
    } else {
      await this.startupP
    }
    this.app.engine.setWidth(this.opts.renderer.buffer.width)
    this.animTimer = setInterval(() => this.animPump(), ANIM_MS)
    this.runP = Promise.all([this.pumpInput(), this.pumpBackend()])
    // Real-value refresh (M38b G2): the initial context/queue snapshots land
    // before the first frame — afterwards they ride the turn boundaries.
    this.refreshContext()
    this.refreshQueue()
    // M49 Task 13: the status line's first recompute (tasks/model/queue…).
    this.refreshStatusLine()
    await this.runP
  }

  /** Terminal resize relay — engine re-wrap + minimal inline-host geometry
   * (the host's renderer does not exist in minimal mode). M39: the resize also
   * drives the documented auto-retain heuristic (large-history memory release). */
  setSize(cols: number, rows: number): void {
    this.app.engine.setWidth(cols)
    this.inlineHost?.resize(cols, rows)
    this.maybeAutoRetain()
  }

  /**
   * M39 memory-release heuristic (documented, OFF by default — it only fires
   * when the scrollback actually grew past the threshold): after a re-wrap,
   * a >2000-line scrollback trims its display trunk to 1500 visible lines.
   * Block-granular + marker-pinned; the seq cursor is untouched.
   */
  private maybeAutoRetain(): void {
    if (this.opts.engine.lineCount() <= 2000) return
    this.opts.engine.retain?.({ maxLines: 1500 })
    this.requestFrame()
  }

  /** Manual memory-release hook (app.retain(maxLines?)) — trims the display
   * trunk to `maxLines` visible lines (default 1500); returns the newly
   * trimmed block count (0 = nothing trimmed). */
  retain(maxLines?: number): { trimmedBlocks: number } {
    const r = this.opts.engine.retain?.({ maxLines })
    this.requestFrame()
    return r ?? { trimmedBlocks: 0 }
  }

  /** Idempotent: stops the pumps/timer (a pending IO iterator ends the run). */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.animTimer !== null) {
      clearInterval(this.animTimer)
      this.animTimer = null
    }
    await this.runP
  }

  /** One repaint (coalesced) — present + flush; flush("") = zero-byte idle.
   * Minimal mode (M38a): the frame goes to the live-region writer instead —
   * NO cell renderer (no fullscreen buffer at all). */
  frame(): void {
    if (this.stopped) return
    const t = this.opts.now?.() ?? Date.now()
    // M47 G2: paint-suspend (the live /doctor probe) — while active, NO frame
    // bytes are written (no present, no renderer.flush — not even the
    // zero-byte idle ""; the anim pump's repaint path funnels here, so it is
    // gated too). The probe owns the tty; its replies never become frames.
    // An expired window releases the gate naturally (a scheduling miss); the
    // run's settle also clears it (answers / ≤800ms timeout).
    const suspend = this.probeSuspend
    if (suspend !== undefined) {
      if (t < suspend.until) return
      this.probeSuspend = undefined
    }
    this.app.toasts = this.app.toasts.filter((toast) => toast.until > t)
    if (this.app.turn !== undefined) {
      const turn = this.app.turn
      turn.nowMs = t
      turn.phaseMs = t - this.phaseStartedAt
      turn.turnMs = t - this.turnStartedAt
    }
    // M49 Task 13: the turn-timer segment is live (per frame — real elapsed;
    // undefined while idle = the segment is omitted).
    if (this.app.statusLine !== undefined && this.app.statusLine !== "disabled") {
      this.app.status.turnTimerMs = this.app.turn === undefined ? undefined : this.app.turn.turnMs
    }
    // M39: sample the frame interval per coalesced repaint (the meter is
    // undefined when the HUD is off — zero cost).
    this.fpsMeter?.tick(t)
    if (this.inlineActive()) {
      this.frameMinimal()
      return
    }
    present(this.app, this.opts.renderer, this.palette, this.opts.glyphs, {
      compact: this.opts.compact,
      // M47 G2: the LIVE capability context (the /doctor probe answers merge
      // into this.cap — the renderer sees refreshed truth, not only startup's).
      cap: this.cap,
      ...(this.fpsMeter !== undefined ? { hud: this.hudState() } : {}),
    })
    this.opts.renderer.flush((s) => this.opts.write?.(s))
  }

  /** Per-frame HUD snapshot — meter + the honest visible line count. */
  private hudState(): HudState {
    return { meter: this.fpsMeter!, lineCount: this.opts.engine.lineCount() }
  }

  /** Keymap/backend/anim results funnel here; the loop paints after.
   * `skipModal` (M49 Task 14, spec §9.4): the top-tier overlay routing uses it
   * — an interactive confirm/permission/question overlay owns the input BEFORE
   * the viewer, so its actions must NOT take the modal branch (Esc closes the
   * overlay, Enter accepts its row, nav moves its rows — never the viewer's). */
  dispatch(action: AppAction, skipModal = false): void {
    // Index-carrying accept (digits 1-9, spec §4 permission/question/cancel).
    if (typeof action !== "string") {
      if (action.type === "overlay-accept") this.overlayAccept(action.index)
      this.requestFrame()
      return
    }
    // M49 Task 10: while the modal is open it owns the surface — the modal
    // semantics (Esc closes / y copies / arrows move) route here; quit stays
    // global (Ctrl+Q must still work over a modal).
    if (!skipModal && this.app.modal !== undefined && action !== "quit") {
      switch (action) {
        case "overlay-dismiss": this.modalOwner.close(); break
        case "overlay-copy": {
          const modal = this.app.modal
          const live = modal?.kind === "block-viewer" ? modal.viewer : modal?.kind === "line-viewer" ? modal.view : undefined
          if (live !== undefined) void live.copy()
          break
        }
        case "overlay-nav-prev": this.modalMove(-1); break
        case "overlay-nav-next": this.modalMove(1); break
        case "overlay-page-prev": this.modalMovePage(-1); break
        case "overlay-page-next": this.modalMovePage(1); break
        default: break
      }
      this.requestFrame()
      return
    }
    switch (action) {
      case "scroll-up": this.scrollBy(-3); break
      case "scroll-down": this.scrollBy(3); break
      case "page-up": this.scrollBy(-this.pageStep()); break
      case "page-down": this.scrollBy(this.pageStep()); break
      case "goto-top": this.app.scroll = { offset: 0, follow: false }; break
      case "goto-bottom": this.app.scroll = { offset: 0, follow: true }; break
      case "prev-turn":
      case "next-turn":
        // M46c G1: the L/H turn navigation — the REAL transition now (the
        // M38 note is superseded by the engine turn-anchor accessor): jump
        // the viewport to the previous/next turn anchor.
        this.gotoTurnRel(action === "prev-turn" ? -1 : 1)
        break
      case "toggle-fold": {
        if (this.app.search?.active === true) break
        const y = this.app.scroll.follow
          ? Math.max(0, this.opts.engine.lineCount() - this.opts.renderer.buffer.height)
          : this.app.scroll.offset
        this.opts.engine.toggleFoldAt(y)
        break
      }
      case "toggle-expand-all": this.opts.engine.toggleExpandAll(); break
      case "copy-block": this.copySelectedBlock(); break
      case "focus-scrollback": this.focus("scrollback"); break
      case "focus-prompt": this.focus("prompt"); break
      case "submit": this.submitPrompt(); break
      case "newline": {
        // M49 Task 7: the newline goes through the editor (AT the cursor —
        // multi-line drafts edit in place).
        this.editor.newline(this.nowMs())
        this.app.prompt.multiLine = true
        this.syncPrompt()
        this.refreshDropdowns()
        this.refreshShortcuts()
        break
      }
      // M49 Task 7: editor motion/undo/redo — the PromptEditor is the only
      // mutation path (the diff/shortcuts ride the synced view state).
      case "edit-left": this.editorMove("left"); break
      case "edit-right": this.editorMove("right"); break
      case "edit-word-left": this.editorMove("word-left"); break
      case "edit-word-right": this.editorMove("word-right"); break
      case "edit-home": this.editorMove("home"); break
      case "edit-end": this.editorMove("end"); break
      case "edit-select-all": this.reconcileEditor(); this.editor.selectAll(); this.requestFrame(); break
      case "edit-undo": {
        this.reconcileEditor()
        if (this.editor.undo()) {
          this.syncPrompt()
          this.refreshDropdowns()
        }
        break
      }
      case "edit-redo": {
        this.reconcileEditor()
        if (this.editor.redo()) {
          this.syncPrompt()
          this.refreshDropdowns()
        }
        break
      }
      case "interject": {
        const text = this.app.prompt.text.trim()
        if (text.length > 0) {
          void this.opts.backend.steer(text)
          this.clearPrompt()
        }
        break
      }
      case "cancel-turn": {
        if (this.app.prompt.text.trim().length > 0) {
          this.clearPrompt() // Ctrl-C / Esc on a non-empty draft clears it
          break
        }
        if (this.app.turn !== undefined) void this.opts.backend.cancel()
        this.armedQuit = true
        this.toast("Press again to quit")
        break
      }
      case "toggle-multiline": {
        this.app.prompt.multiLine = !this.app.prompt.multiLine
        this.refreshShortcuts()
        break
      }
      case "cycle-mode": {
        // Normal → Plan → Always-Approve; M37a cycles the first two.
        this.app.mode = this.app.mode === "normal" ? "plan" : "normal"
        this.app.status.plan = this.app.mode === "plan"
        this.app.prompt.plan = this.app.mode === "plan"
        this.toast(`Switched to mode: ${this.app.mode.toLowerCase()}`)
        this.refreshShortcuts()
        break
      }
      case "toggle-todo-pane": this.togglePane("todo"); break
      case "toggle-tasks-pane": this.togglePane("tasks"); break
      case "toggle-queue-pane": this.togglePane("queue"); break
      case "sessions": this.toggleSessions(); break
      case "sessions-new": this.toast("new session: M38 (backend create)"); break
      // M46a keys truth — the stash (Ctrl+S/Alt+S), the send-to-background
      // slot (Ctrl+B — jobs bridge absent ⇒ honest toast), minimal $EDITOR
      // (Ctrl+G in minimal mode).
      case "stash-draft": this.stashDraft(); break
      case "send-background": this.toast("send-to-background (M46b)"); break
      case "edit-prompt-editor": this.editPromptInEditor(); break
      case "open-command-palette": this.toast("command palette: M38"); break
      // ---- overlays / dropdowns / pickers (M37b, spec §4)
      case "overlay-select": this.overlaySelect(); break
      case "overlay-nav-prev": this.overlayNav(-1); break
      case "overlay-nav-next": this.overlayNav(1); break
      case "overlay-page-prev": this.overlayNav(-this.overlayPage()); break
      case "overlay-page-next": this.overlayNav(this.overlayPage()); break
      case "overlay-dismiss": this.overlayDismiss(); break
      case "overlay-copy": this.toast("Copied!"); break
      case "overlay-expand":
      case "overlay-collapse":
      case "overlay-toggle":
      case "overlay-tab":
      case "overlay-tab-back":
      case "overlay-search":
      case "overlay-filter":
      case "overlay-range-left":
      case "overlay-range-right":
      case "overlay-question-prev":
      case "overlay-question-next":
        // picker-only extras — M37b moves the cursor (tabs/filters: M38).
        this.overlaySub(action)
        break
      // ---- rewind (M43, spec §3.9) — the seam's act fn owns the semantics;
      // the loop only forwards (the action names are phase-agnostic: the
      // binder interprets "rewind-y" as cancel-rewind or confirm per phase).
      case "rewind-y":
      case "rewind-n":
      case "rewind-a":
      case "rewind-b":
      case "rewind-f":
      case "rewind-back":
        this.app.overlay?.act?.(action)
        break
      case "rewind-arm1":
        this.armedRewind = true
        this.toast("Press again to open Rewind")
        break
      case "rewind-open":
        if (this.armedRewind) this.openRewind()
        else {
          // defensive — keys only emit rewind-open while armed; a desync
          // re-arms rather than silently dropping the press.
          this.armedRewind = true
          this.toast("Press again to open Rewind")
        }
        break
      // ---- welcome (spec §2a)
      case "menu-up": this.welcomeNav(-1); break
      case "menu-down": this.welcomeNav(1); break
      case "menu-top": this.welcomeNav(-Number.MAX_SAFE_INTEGER); break
      case "menu-bottom": this.welcomeNav(Number.MAX_SAFE_INTEGER); break
      case "menu-activate": this.welcomeActivate(); break
      case "welcome-new": this.welcomeActivate("new"); break
      case "welcome-resume": this.welcomeActivate("resume"); break
      case "welcome-settings": this.welcomeActivate("settings"); break
      // ---- dashboard (M49 Task 13, spec §8.3)
      case "open-dashboard": this.toggleDashboard(); break
      case "dashboard-up": this.app.dashboard?.move(-1); break
      case "dashboard-down": this.app.dashboard?.move(1); break
      case "dashboard-open": void this.openSelectedDashboardSession(); break
      case "dashboard-back": this.backFromDashboard(); break
      case "dashboard-peek": this.peekDashboardSession(); break
      case "dashboard-pin": this.toggleDashboardPin(); break
      case "dashboard-move-up": this.dashboardMoveOrder(-1); break
      case "dashboard-move-down": this.dashboardMoveOrder(1); break
      case "dashboard-filter-backspace": this.dashboardFilterBackspace(); break
      case "dashboard-new": this.dashboardCreateSession(); break
      // M46a G1: the provider/model modal surfaces (F2/Ctrl+, → settings;
      // Ctrl+M on the agent screen → the model picker).
      case "open-settings": this.openSettings(); break
      case "open-model-picker": this.openModelPicker(); break
      // M46b G1: Ctrl+R / /toggle-mouse-reporting (feature-gated) — flips
      // `app.mouse.enabled` (the whole mouse path: capture gate → hover
      // machinery + scroll stream): OFF hands the mouse back to the terminal
      // (native select), ON restores in-app hover/scroll. M49 Task 14: the
      // same toggle drives the REAL terminal seam (enable/disable bytes only
      // on transitions — see toggleMouseReporting below).
      case "toggle-mouse-reporting": this.toggleMouseReporting(); break
      case "quit": this.requestQuit(); break
      case "quit-arm1":
        // First press (Esc-empty / unarmed) arms; a later press quits.
        if (this.armedQuit) this.requestQuit()
        else {
          this.armedQuit = true
          this.toast("Press again to quit")
        }
        break
      case "history-prev": this.historyPivot(-1); break
      case "history-next": this.historyPivot(1); break
      case "none": break
    }
    this.requestFrame()
  }

  // ------------------------------------------------------------------ input

  private async pumpInput(): Promise<void> {
    const src = this.opts.input
    if (src === undefined) return
    for await (const ev of src.next()) {
      if (this.stopped) break
      this.onInput(ev)
    }
  }

  private async pumpBackend(): Promise<void> {
    for await (const ev of this.opts.backend.events()) {
      if (this.stopped) break
      this.onBackend(ev)
    }
  }

  private animPump(): void {
    if (this.stopped) return
    const t = this.opts.now?.() ?? Date.now()
    this.app.status.tickMs = t
    // M49 Task 13: the command status line refreshes on the anim pump — the
    // source owns the ≥300ms floor and the two-failure retention, so this is
    // a cheap no-op between refreshes and NEVER blocks the draw path.
    if (this.app.statusLine === "command") this.refreshStatusLine()
    // Minimal mode: the 500ms tail-flush sits on THIS pump (idle tick) — a
    // long assistant stream with no block close commits its partial delta.
    if (this.inlineActive() && this.minimalCommits().idleFlushDue(t)) {
      this.commitMinimalDelta()
    }
    // M46b G2: the mouse tick — drag autoscroll (band rows per tick) + the
    // selection flash expiry. Cheap no-op when nothing is in-flight.
    if (!this.inlineActive()) this.mouse.frame(t)
    // M46b G1: the wheel stream drain (coast/gap finalize while active).
    if (!this.inlineActive()) this.scrollDrain(t)
    if (this.needsAnim(t)) this.requestFrame()
  }

  /** "Needs repaint" polling (spec §7): turn running or a live toast. */
  private needsAnim(t: number): boolean {
    if (this.app.turn !== undefined) return true
    for (const toast of this.app.toasts) if (toast.until > t) return true
    return false
  }

  private onInput(ev: InputEvent): void {
    // M47 G2: probe replies that the parser cannot classify — DA2/DA1 CSI
    // (`\x1b[>…c`, `\x1b[?…c`) and kitty DECRPM (`\x1b[?27;1$p`) — arrive as
    // `unknown` events (the parser has no CSI hook). They carry the probe's
    // answers in their raw bytes; the LIVE run's grammar reads them HERE
    // (they were dropped by the key path anyway — never key events).
    if (ev.type === "unknown" && this.probeRun !== undefined && this.probeRun.collect !== undefined) {
      this.probeOnReply(String.fromCharCode(...ev.bytes), true)
      return
    }
    if (ev.type === "paste") {
      // Bracketed paste AND Ctrl+V both arrive as `paste` events (the binding
      // in tui-core). The INSERT stays immediate (M37a behavior); M46c G2
      // RETAINS the source text under a [Pasted: N lines] chip — M49 Task 7:
      // a sizeable paste is ONE atomic PromptPaste element through the editor
      // (the cursor never enters it; double-click expands it).
      if (this.app.focused === "prompt") {
        this.reconcileEditor()
        if (isSizeablePaste(ev.text)) {
          this.editor.insertPaste({ display: `[Pasted: ${pasteLabel(ev.text)}]`, source: ev.text }, this.nowMs())
        } else {
          this.editor.insert(ev.text, this.nowMs())
        }
        this.syncPrompt()
        this.refreshDropdowns()
      }
      this.requestFrame()
      return
    }
    if (ev.type === "mouse") {
      // Minimal mode has no fullscreen surface → no mouse semantics there
      // (capture is OFF in minimal — G1's teardown covers the ordering).
      if (this.inlineActive()) return
      // Parser coords are 1-based; the router/streams operate on 0-based cells.
      const col = ev.x - 1
      const row = ev.y - 1
      if (col < 0 || row < 0) return
      const mouse = this.app.mouse
      // M46b G1: `mouse.enabled` gates the WHOLE mouse path (capture → hover
      // machinery + scroll stream + the click router). When off, the terminal
      // owns the mouse (native select) — nothing routes here.
      if (mouse === undefined || !mouse.enabled) return
      // M49 Task 10: the modal owns the MOUSE too — its hit targets (copy/
      // close — emitted only with real actions) resolve first; a click or
      // wheel anywhere else is consumed (the modal is the only surface).
      if (this.app.modal !== undefined) {
        const modalRect = { x: 0, y: 0, w: this.opts.renderer.buffer.width, h: this.opts.renderer.buffer.height }
        for (const t of modalHitTargets(this.modalOwner, modalRect)) {
          if (col >= t.rect.x && col < t.rect.x + t.rect.w && row >= t.rect.y && row < t.rect.y + t.rect.h) {
            t.action?.()
            this.requestFrame()
            return
          }
        }
        if (ev.button === "wheel-up") { this.modalScroll(3); this.requestFrame(); return }
        if (ev.button === "wheel-down") { this.modalScroll(-3); this.requestFrame(); return }
        return
      }
      // G1: the settled pointer — present() settles the hovered set every
      // frame (dirty-repaint only: engine.update returns the change flag).
      mouse.last = { col, row }
      if (mouse.engine.update(col, row)) this.requestFrame()
      if (ev.button === "wheel-up" || ev.button === "wheel-down") {
        // M46b G1: the scroll STREAM replaces the M40 ±3 wheel actions —
        // grok cadence/ept/taper/carry semantics (the stream's signed lines
        // are the whole delta; the follow-aware base is scrollBy's).
        const out = this.scrollNormalizer.push(ev.button === "wheel-up" ? "up" : "down")
        const applied = this.applyScrollLines(out.lines)
        if (applied !== 0 || out.active) this.requestFrame()
        return
      }
      // M46b G2: click/dispatch — the parser's `released` bit is the press/
      // release divider; drag/motion bits route to the drag state machine.
      const kind = ev.released ? "up" : ev.drag || ev.motion ? "motion" : "down"
      this.mouse.handle({ x: col, y: row, button: ev.button, kind, drag: ev.drag, mods: ev.mods })
      return
    }
    if (ev.type !== "key") return
    const modalKbd: Kbd = { code: ev.code, key: ev.key, ctrl: ev.ctrl, alt: ev.alt, shift: ev.shift }
    // M49 Task 14 (spec §9.4 input precedence): confirm/permission/question
    // overlays are the TOP tier — they own the input BEFORE the viewer/modal
    // (an interactive permission prompt beats an open block viewer). The
    // overlay answers go through the same keymap actions; the freeform capture
    // owns plain chars; everything else is consumed by the active surface.
    // (Pickers/panels/settings/rewind stay in the tier BELOW the viewer —
    // they fall through to the keymap routing below.)
    const topOv = this.overlayState()
    if (topOv !== undefined && (topOv.kind === "permission" || topOv.kind === "question" || topOv.kind === "cancel-turn")) {
      // The active freeform owns plain chars/Enter/Esc FIRST (the original
      // overlay-capture semantics — a question-esque freeform submit/abort
      // never reaches the keymap or the viewer).
      const fft = this.app.overlay?.freeform
      if (fft !== undefined && fft.active()) {
        if (ev.code === "char" && !ev.ctrl && !ev.alt) { fft.append(ev.key); this.requestFrame(); return }
        if (ev.code === "Backspace") { fft.backspace(); this.requestFrame(); return }
        if (ev.code === "Enter") { fft.submit(); this.requestFrame(); return }
        if (ev.code === "Esc") { fft.abort(); this.requestFrame(); return }
      }
      const action = dispatchKey(modalKbd, this.keymapState())
      if (action !== "none") {
        // Skip the modal branch: dispatch() must NOT route these OVERLAY
        // actions into an open viewer (an interactive permission/question
        // prompt owns input — Esc closes the overlay, Enter accepts it, nav
        // moves its rows; the viewer underneath stays untouched).
        this.dispatch(action, true)
        this.requestFrame()
        return
      }
      // the top-tier overlay owns input: other keys are consumed.
      this.requestFrame()
      return
    }
    // M49 Task 10: the modal (viewer) is the next tier — the input OWNER
    // after top-tier overlays (before panes→prompt→scrollback: an open modal
    // consumes everything).
    if (this.modalOwner.key(modalKbd)) {
      this.requestFrame()
      return
    }
    // M49 Task 10: Enter (alt Ctrl+F) on the scrollback — no overlay/dropdown
    // open, search bar idle — opens the block viewer for the block at the
    // viewport's first visible line.
    if (this.blockViewerOpenKey(modalKbd)) return
    // M46a: /find search mode — chars/Backspace/Enter/Esc own the search bar
    // (scrollback focus while active); everything else falls through.
    if (this.searchKey(ev)) return
    // M40 G2 (C13): plan-review keys — while the plan bar is active, no
    // overlay/dropdown is open and the prompt is EMPTY, `a`/`c`/`q`
    // steer/prefill BEFORE the prompt edit path (typing wins once the prompt
    // has content — approve/comment/quit are deliberate single presses on
    // the plain empty editor).
    if (
      ev.code === "char" && !ev.ctrl && !ev.alt
      && this.overlayState() === undefined
      && this.app.prompt.text.length === 0
      && this.planReviewActive()
    ) {
      if (ev.key === "a") { this.planApprove(); this.requestFrame(); return }
      if (ev.key === "c") { this.planComment(); this.requestFrame(); return }
      if (ev.key === "q") { this.planQuit(); this.requestFrame(); return }
    }
    // M39 wheel close: overlay freeform capture — the permission reject row /
    // question `z` row own the printable chars while focused (the shipped
    // keymap has no char case for overlays; without this, typed feedback was
    // dropped — case-017 needed a host-side gutter, now the production path).
    const ff = this.app.overlay?.freeform
    if (ff !== undefined && ff.active()) {
      if (ev.code === "char" && !ev.ctrl && !ev.alt) { ff.append(ev.key); this.requestFrame(); return }
      if (ev.code === "Backspace") { ff.backspace(); this.requestFrame(); return }
      if (ev.code === "Enter") { ff.submit(); this.requestFrame(); return }
      if (ev.code === "Esc") { ff.abort(); this.requestFrame(); return }
      // fall through — nav/scope keys stay keymap-routed
    }
    // M46c G2: workflow panel refresh — [r] while the /workflow status panel is
    // open re-fetches its rows (no-pump discipline: refresh on open + here).
    if (this.workflowRefreshKey(ev)) return
    // M49 Task 13: the DASHBOARD screen owns its input — the keymap routes the
    // special keys (nav/open/back/peek/pin/filter-backspace) and plain chars
    // APPEND to the filter (the prompt never sees them on this surface).
    // MUST run BEFORE the prompt-edit branch: the dashboard screen keeps the
    // app.focused "prompt" (no prompt box exists there — the previous
    // session's focus persists), so the prompt-editing branch would swallow
    // the chars (typed filter letters landed in the invisible prompt).
    if (this.app.screen === "dashboard") {
      const dkbd: Kbd = { code: ev.code, key: ev.key, ctrl: ev.ctrl, alt: ev.alt, shift: ev.shift }
      const action = dispatchKey(dkbd, this.keymapState())
      if (action !== "none") {
        this.dispatch(action)
        return
      }
      if (ev.code === "char" && !ev.ctrl && !ev.alt) {
        const dash = this.app.dashboard
        if (dash !== undefined) {
          dash.setFilter(`${dash.filter()}${ev.key}`)
          this.requestFrame()
        }
        return
      }
      this.requestFrame()
      return
    }
    // Text editing for the prompt comes BEFORE the keymap — M37a subset:
    // printable chars + Backspace/Delete; emacs motion lands M37b. When a
    // non-dropdown overlay is open (pickers/panels), chars are NOT prompt
    // edits — they route through the overlay keymap (spec §4).
    const ov = this.overlayState()
    if (this.app.focused === "prompt" && (ov === undefined || ov.dropdown !== undefined)) {
      if (ev.code === "char" && !ev.ctrl && !ev.alt) {
        this.insertText(ev.key)
        return
      }
      if (ev.code === "Backspace") {
        this.backspace()
        return
      }
      if (ev.code === "Delete") {
        // M49 Task 7: delete-forward is an editor transaction (grapheme-safe,
        // atom-aware).
        this.reconcileEditor()
        this.editor.deleteForward()
        this.syncPrompt()
        this.refreshDropdowns()
        return
      }
    }
    const kbd: Kbd = { code: ev.code, key: ev.key, ctrl: ev.ctrl, alt: ev.alt, shift: ev.shift }
    this.dispatch(dispatchKey(kbd, this.keymapState()))
  }

  private keymapState(): KeymapState {
    const ov = this.overlayState()
    return {
      focused: this.app.focused,
      promptText: this.app.prompt.text,
      multiLine: this.app.prompt.multiLine,
      turnRunning: this.app.turn !== undefined,
      armedQuit: this.armedQuit,
      searchActive: this.app.search?.active === true,
      overlay: ov?.kind,
      dropdown: ov?.dropdown,
      welcome: this.app.screen === "welcome",
      // M49 Task 13: the dashboard screen owns its key/prompt routing.
      dashboard: this.app.screen === "dashboard",
      minimal: this.inlineActive(),
      rewindAvailable: this.rewindEligible(),
      rewindArmed: this.armedRewind,
      // M46b G1: the Ctrl+R scrollback binding exists ONLY when the
      // mouse-reporting-toggle feature is on (settings knob / env forced).
      mouseToggle: this.mouseToggleFeature(),
    }
  }

  /** Open interaction surface (spec §4 priority: G1 overlays > pickers > dropdowns). */
  private overlayState(): { kind: OverlayKind; dropdown?: "slash" | "completion" | "file-search" } | undefined {
    const ov = this.app.overlay
    if (ov !== undefined) return { kind: ov.kind }
    if (this.app.sessions !== undefined) return { kind: "sessions" }
    if (this.app.historyPanel !== undefined) return { kind: "history" }
    // M46a G2: light panels ride the dropdown keymap (Enter accepts, Esc ends).
    if (this.app.lightPanel !== undefined) return { kind: "light" }
    if (this.app.fileSearch !== undefined) return { kind: "dropdown", dropdown: "file-search" }
    if (this.app.completion !== undefined) return { kind: "dropdown", dropdown: "completion" }
    if (this.app.slash !== undefined) return { kind: "dropdown", dropdown: "slash" }
    return undefined
  }

  private onBackend(ev: TuiEvent): void {
    if (ev.type === "session/open" && this.opts.engine.reset !== undefined) {
      this.opts.engine.reset()
    } else {
      this.opts.engine.append(ev)
    }
    // Minimal commit pipeline (M38a): boundary events commit the engine
    // delta print-once; the region repaint rides the frame below.
    if (this.inlineActive()) this.minimalOnEvent(ev)
    const now = this.opts.now?.() ?? Date.now()
    switch (ev.type) {
      case "session/open":
        this.resetSessionView(ev.sessionId)
        break
      case "turn":
        if (ev.phase === "start") this.beginTurn("thinking", now)
        else this.app.turn = undefined // finish() → row hides (spec §7)
        // Real-value refresh at the turn boundary (M38b G2): context usage and
        // the queued-turn count — the status chip renders only what exists.
        this.refreshContext()
        this.refreshQueue()
        break
      case "thinking": {
        const t = this.ensureTurn(now)
        t.phase = "thinking"
        this.phaseStartedAt = now
        break
      }
      case "assistant": {
        const t = this.ensureTurn(now)
        t.phase = "responding"
        this.phaseStartedAt = now
        break
      }
      case "tool": {
        const t = this.ensureTurn(now)
        t.phase = "responding"
        break
      }
      case "compaction":
        if (ev.phase === "start") {
          const t = this.ensureTurn(now)
          t.phase = "compacting"
          this.phaseStartedAt = now
        }
        break
      case "todo": {
        let done = 0
        for (const item of ev.items) if (item.status === "completed") done++
        this.app.status.todo = { done, total: ev.items.length }
        // Pane content (spec §3.12) + visibility hint when the pane was seeded.
        this.app.paneData = { ...(this.app.paneData ?? {}), todo: ev.items }
        break
      }
      case "goal":
        if (ev.label !== undefined) this.app.status.goal = ev.label
        break
      case "title":
        this.app.title = ev.title
        this.app.prompt.title = ev.title
        // M49 Task 13: the session segment is a REAL title (the event is the
        // source; an absent title leaves the segment omitted).
        if (this.app.statusLine !== undefined && ev.title !== "") {
          this.app.status.session = ev.title
          this.refreshStatusLine()
        }
        break
      case "plan": {
        this.app.mode = ev.phase === "on" ? "plan" : "normal"
        this.app.status.plan = this.app.mode === "plan"
        this.app.prompt.plan = this.app.mode === "plan"
        // M40 G2 (C13): the plan-review bar depends on this transition —
        // refresh so `a approve / c comment / q quit plan` appear exactly
        // when the engine's plan/mode event lands.
        this.refreshShortcuts()
        break
      }
      case "user":
      case "user/edit":
      case "system":
        break // engine.append handled the visible surface
      case "rewind": {
        // M43: the durable marker landed — the engine drew the row and set the
        // anchor; jump the viewport to it (the rewound era dims from there
        // while any rewind overlay is open). No toast: grok has none (§3.9).
        const anchor = this.opts.engine.rewindAnchor?.()
        if (anchor !== undefined && !this.inlineActive()) {
          const page = this.opts.renderer.buffer.height
          this.app.scroll = { follow: false, offset: Math.max(0, anchor - Math.floor(page / 2)) }
          // dim-from sync (spec §3.9: the anchor-era dim rides the OPEN panel).
          const ov = this.app.overlay
          if (ov !== undefined && isRewindOverlay(ov)) this.app.dimFrom = anchor
        }
        break
      }
    }
    this.requestFrame()
  }

  private ensureTurn(now: number): NonNullable<TuiAppState["turn"]> {
    if (this.app.turn === undefined) this.beginTurn("thinking", now)
    return this.app.turn!
  }

  private beginTurn(phase: TurnPhase, at: number): void {
    this.turnStartedAt = at
    this.phaseStartedAt = at
    this.app.turn = {
      phase,
      attempts: 1,
      phaseMs: 0,
      turnMs: 0,
      tokens: 0,
      nowMs: at,
      canStop: true,
    }
    this.refreshShortcuts()
  }

  // ------------------------------------------------------------------ behaviors

  private focus(target: "prompt" | "scrollback"): void {
    this.app.focused = target
    this.refreshShortcuts()
  }

  private scrollBy(dy: number): void {
    const total = this.opts.engine.lineCount()
    const page = this.opts.renderer.buffer.height
    const max = Math.max(0, total - page + 1)
    // M40 G2 (C11): follow-aware base — while following, the effective offset
    // is the tail (max); an offset above it would jump to the TOP of history
    // instead of one notch away from the tail (the pre-G2 behavior).
    const cur = this.app.scroll.follow ? max : this.app.scroll.offset
    this.app.scroll.follow = false
    this.app.scroll.offset = Math.max(0, Math.min(max, cur + dy))
  }

  /** M46b G1: the scroll-stream wire — `lines` (signed: negative = up) →
   * scrollBy. Returns the applied delta (the input path/flush gate use it). */
  private applyScrollLines(lines: number): number {
    if (lines === 0) return 0
    this.scrollBy(lines)
    return lines
  }

  /** M46b G1: the stream's drain tick (coast taper + 80ms gap finalize) rides
   * the anim pump while a stream is active. */
  private scrollDrain(t: number): void {
    if (!this.scrollNormalizer.hasActiveStream()) return
    const out = this.scrollNormalizer.onTick(t)
    if (out.lines !== 0) this.applyScrollLines(out.lines)
    if (!out.active) this.requestFrame()
  }

  /** M46b G1: the mouse-reporting toggle (Ctrl+R / /toggle-mouse-reporting).
   * M49 Task 14 (spec §9.7): the toggle drives the REAL terminal seam —
   * enable/disable bytes are written ONLY on a transition (the
   * MouseReportingToggle identity) and turning OFF hands the mouse back to the
   * terminal for native selection (no hover/capture state survives) —
   * the MouseRouter state (press/drag/latch/link) is cancelled, the hover
   * engine + settled set + scroll stream are cleared, and the app routing
   * gate flips. Minimal mode ignores the toggle (no capture, no bytes —
   * createMouseReportingToggle stays OFF for no-mouse caps). */
  private toggleMouseReporting(): void {
    const mouse = this.app.mouse
    if (mouse === undefined || this.inlineActive()) {
      // minimal has no fullscreen surface: the attempt is ignored (no bytes).
      this.toast("mouse capture: no fullscreen mouse path")
      return
    }
    const next = !mouse.enabled
    const bytes = this.mouseReporting.set(next)
    if (bytes !== "") this.opts.write?.(bytes) // transition only — zero bytes on no-op
    mouse.enabled = next
    mouse.engine.clear()
    mouse.hovered.clear()
    this.mouse.cancel() // press/drag/scrollbar-latch/link-arm + drag-line cleared
    if (!next) {
      // capture OFF: drop every interaction artifact (the drag selection, its
      // flash window and the prompt text selection) — the terminal-native
      // selection takes over with nothing stale on screen.
      this.opts.engine.clearSelection?.()
      this.app.selectionFlashUntil = undefined
      this.app.promptSelect = undefined
      this.app.selectionDragLine = undefined
    }
    this.scrollNormalizer.reset()
    this.toast(next ? "Mouse reporting on" : "Mouse reporting off")
    this.requestFrame()
  }

  private pageStep(): number {
    return Math.max(1, Math.floor(this.opts.renderer.buffer.height / 2))
  }

  submitPrompt(): void {
    const text = this.app.prompt.text.trim()
    if (text.length === 0) return // queue-top force-send lands M38 (spec §4)
    // M46a G1 slash modals: /provider, /model, /settings (each = the modal
    // surface; harmonized with G2's registry below — the G1 text-match stays
    // FIRST: it owns those three names and never fights the registry run).
    if (this.tryG1SlashModal(text)) {
      this.clearPrompt()
      return
    }
    // M46a G2: the slash REGISTRY run — every capability-gated command hits
    // here. Matched → run + return.
    const matched = this.slash.matches(text, this.slashCtx(text))
    if (matched !== undefined) {
      this.app.history.push(this.app.prompt.text)
      this.app.historyIndex = this.app.history.length
      this.clearPrompt()
      void this.runSlashCommand(matched.command, matched.arg, text)
      return
    }
    // M49 Task 14 (spec §10.1): an unknown / hidden slash line NEVER becomes a
    // user prompt — the unsupported path fires BEFORE the user-message append
    // (exact message, no backend submission).
    if (text.startsWith("/")) {
      const name = text.slice(1).split(/\s+/, 1)[0] ?? ""
      this.toast(`Unsupported command: /${name}`)
      this.clearPrompt()
      return
    }
    // Mode-switch relay (spec §1, still the /minimal //fullscreen host path
    // when a host wires it without the registry relay — harmless fallback).
    const modeSwitch = this.opts.modeSwitch
    if (modeSwitch !== undefined && modeSwitch(text)) {
      this.clearPrompt()
      this.requestQuit()
      return
    }
    // M49 Task 7: busy Enter — the persisted `busyEnter` setting chooses
    // STEER (interrupt the running turn with the text) or QUEUE (the plain
    // submit — the backend runs it after the current turn; default).
    if (this.app.turn !== undefined && (this.opts.busyEnter ?? "queue") === "steer") {
      this.app.history.push(this.app.prompt.text)
      this.app.historyIndex = this.app.history.length
      this.clearPrompt()
      void this.opts.backend.steer(text).catch((error: unknown) => {
        this.toast(`steer failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    this.acceptPrompt(this.app.prompt.text)
  }

  private applyModelState(state: BackendModelState): void {
    // M49 Task 13: the builtin status row's model segment source — the label
    // is REAL only when the resolution says ready.
    this.lastModelState = state
    if (this.app.welcome !== undefined) this.app.welcome.modelState = state
    const label = state.status === "ready" ? state.label : state.status
    this.app.prompt.model = label
    this.app.status.model = label
    this.refreshStatusLine()
  }

  private setStartupError(message: string): void {
    if (this.app.welcome !== undefined) this.app.welcome.startupError = message
  }

  private activateWelcome(): void {
    this.app.view = { kind: "welcome" }
    if (this.uiMode === "fullscreen") this.app.screen = "welcome"
    this.app.focused = "prompt"
    this.app.prompt.focused = true
  }

  private activateAgent(sessionId: string): void {
    this.currentSessionId = sessionId
    this.app.view = { kind: "agent", sessionId }
    this.app.screen = this.uiMode === "minimal" ? "minimal" : "agent"
    this.app.prompt.title = this.app.title
  }

  private async refreshWelcomeModelState(): Promise<BackendModelState> {
    if (this.app.welcome !== undefined) this.app.welcome.modelState = { status: "loading" }
    this.requestFrame()
    let state: BackendModelState
    try {
      state = await this.opts.backend.modelState()
    } catch (error) {
      state = { status: "invalid", reason: error instanceof Error ? error.message : String(error) }
    }
    this.applyModelState(state)
    this.requestFrame()
    return state
  }

  private async createSessionAndSubmit(raw: string): Promise<void> {
    // M49 Task 4 rule: createSession is an OPTIONAL capability member — an
    // absent seam fails loudly (never a silent no-op). NOTE: the member is
    // invoked AS A METHOD (never extracted) — the embedded implementation
    // uses `this.open` and an unbound call would crash (case-026 caught it).
    if (this.opts.backend.createSession === undefined) {
      this.setStartupError("session create unavailable on this backend")
      this.activateWelcome()
      return
    }
    try {
      const sessionId = await this.opts.backend.createSession()
      this.activateAgent(sessionId)
      this.acceptPrompt(raw)
    } catch (error) {
      this.setStartupError(`session create failed: ${error instanceof Error ? error.message : String(error)}`)
      this.activateWelcome()
    }
  }

  /** Record and clear only after the model/session gate accepted the prompt.
   * Invalid and unconfigured paths never call this, so their draft survives.
   * M49 Task 14 (spec §10.1): a slash line never becomes a user message —
   * submitPrompt owns the interactive guard; this is the same guard for the
   * host/startup prompt path (a "/login" boot prompt is rejected, never
   * submitted). */
  private acceptPrompt(raw: string): void {
    const text = raw.trim()
    if (text === "") return
    if (text.startsWith("/")) {
      const name = text.slice(1).split(/\s+/, 1)[0] ?? ""
      this.toast(`Unsupported command: /${name}`)
      return
    }
    this.app.history.push(raw)
    this.app.historyIndex = this.app.history.length
    this.clearPrompt()
    void this.opts.backend.submit(text).catch((error: unknown) => {
      this.toast(`submit failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Run a matched command; errors surface as toasts (never an unhandled
   * rejection — the registry's run is user-paced and must not abort a frame). */
  private async runSlashCommand(command: SlashCommand, arg: string, input: string): Promise<void> {
    try {
      await command.run(this.slashCtx(input, arg))
    } catch (error) {
      this.toast(`/${command.name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.requestFrame()
  }

  /** M49 Task 7: the editor → view-state projection. The PromptState is the
   * render contract; the editor is the source of truth. */
  private syncPrompt(): void {
    const p = this.app.prompt
    p.text = this.editor.value()
    p.cursor = this.editor.cursor()
    // M46c G2: the chip rows are the editor's paste atoms (label from the
    // source — the atom display and the state never parse each other).
    p.pasteStash = this.editor.pasteAtoms().map((a) => ({ label: pasteLabel(a.source), text: a.source }))
  }

  /** External writers (hosts/tests seeding app.prompt.text directly — the
   * M46c state surface is shared) drift the editor. Called before EVERY
   * editor entry: the transaction adopts the view state first, then the edit
   * runs (the adoption is itself undoable). */
  private reconcileEditor(): void {
    const p = this.app.prompt
    if (p.text !== this.editor.value()) {
      this.editor.replaceAll(p.text, this.nowMs())
    }
  }

  private nowMs(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private editorMove(direction: "left" | "right" | "word-left" | "word-right" | "home" | "end"): void {
    this.reconcileEditor()
    this.editor.move(direction)
    this.syncPrompt()
    this.refreshDropdowns()
  }

  private insertText(s: string): void {
    this.reconcileEditor()
    this.editor.insert(s, this.nowMs())
    this.syncPrompt()
    this.refreshDropdowns()
  }

  private backspace(): void {
    this.reconcileEditor()
    this.editor.backspace()
    this.syncPrompt()
    this.refreshDropdowns()
  }

  /** M46c G2 + M49 Task 7: paste-chip double-click seam — EXPAND the editor's
   * paste atom at stash `index` (the source byte-preserved in place — it was
   * already inserted; the atom envelope turns it editable). */
  private expandPasteStash(index: number): void {
    this.reconcileEditor()
    if (!this.editor.expandPaste(index)) {
      this.toast("paste chip expand: stale chip")
      return
    }
    this.syncPrompt()
    this.refreshDropdowns()
  }

  /** M46c G2: the [r] key while the /workflow panel is open → re-fetch its
   * rows (the panel's own refresh closure, stored on the lightPanel state). */
  private workflowRefreshKey(ev: InputEvent): boolean {
    if (ev.type !== "key" || ev.code !== "char" || ev.ctrl || ev.alt) return false
    if (ev.key.toLowerCase() !== "r") return false
    const lp = this.app.lightPanel
    if (lp === undefined || lp.kind !== "workflow" || lp.refresh === undefined) return false
    lp.refresh()
    this.requestFrame()
    return true
  }

  private clearPrompt(): void {
    // M49 Task 7: the clear is an editor transaction (the paste stash lives
    // in the editor's atoms — cleared together).
    this.editor.clear(this.nowMs())
    this.syncPrompt()
    this.refreshDropdowns()
    this.refreshShortcuts()
  }

  /** M49 Task 7: history rewind — the restore is an undoable replaceAll (one
   * transaction per step; the previous draft rides the undo stack). */
  private historyStep(dir: 1 | -1): void {
    const h = this.app.history
    if (h.length === 0) return
    const step = historyRewind(h, this.app.historyIndex, dir)
    if (step === undefined) return
    this.app.historyIndex = step.index
    this.editor.replaceAll(step.text, this.nowMs())
    this.syncPrompt()
    this.refreshDropdowns()
  }

  /** Up on an empty prompt with history opens the browser panel (spec §4). */
  private historyPivot(dir: 1 | -1): void {
    if (this.app.history.length === 0 || this.app.prompt.text.length !== 0) {
      this.historyStep(dir)
      return
    }
    if (this.app.historyPanel === undefined && dir === -1) {
      this.app.historyPanel = {
        entries: this.app.history.map((t) => ({ text: t, highlight: [] })),
        cursor: Math.max(0, this.app.history.length - 1),
      }
      this.requestFrame()
      return
    }
    this.historyStep(dir)
  }

  private refreshShortcuts(): void {
    this.app.shortcuts = {
      items: shortcutsFor({
        focused: this.app.focused,
        multiLine: this.app.prompt.multiLine,
        turnRunning: this.app.turn !== undefined,
        mode: this.app.mode,
        planReview: this.planReviewActive(),
      }),
    }
  }

  /** M40 G2 (C13): plan review is active when plan mode is on (app-side AND
   * engine-observed — a local Shift+Tab flip without an engine plan/mode
   * event never arms the bar) and the LAST display line belongs to an
   * assistant block (the plan text is the last assistant message — plan-mode
   * discipline). The bar shows `a approve / c comment / q quit plan`; the
   * keys route while the prompt is EMPTY (typing wins once it has content). */
  private planReviewActive(): boolean {
    if (this.app.mode !== "plan") return false
    if (this.opts.engine.plan?.() !== true) return false
    const total = this.opts.engine.lineCount()
    if (total <= 0) return false
    return this.opts.engine.lineBlock(total - 1)?.title === "Assistant"
  }

  // ------------------------------------------------------------------ plan review (C13)

  /** `a` — approve the plan: steer the confirmation (the turned model takes
   * it as the plan's approval annotation; the embedded backend degrades an
   * idle steer to a send-tier turn). */
  private planApprove(): void {
    void this.opts.backend.steer("Approved — proceed").catch((error: unknown) => {
      this.toast(`plan approve failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.toast("Plan approved")
  }

  /** `c` — comment: prefill the prompt with `comment: ` so the user's text
   * rides the plan conversation. M49 Task 7: an editor transaction. */
  private planComment(): void {
    this.editor.replaceAll("comment: ", this.nowMs())
    this.syncPrompt()
    this.refreshDropdowns()
    this.refreshShortcuts()
  }

  /** `q` — quit plan mode: steer the exit sentence (the exit_plan_mode
   * discipline stays the MODEL's tool; the shortcut steers the intent). */
  private planQuit(): void {
    void this.opts.backend.steer("quit plan mode").catch((error: unknown) => {
      this.toast(`plan quit failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.toast("Exiting plan mode")
  }

  // ------------------------------------------------------------------ slash registry wiring (M46a G2)

  /** M49 Task 14 (spec §10.1): the typed capability inventory the registry
   * gates on — derived from the REAL backend/host members. plan-mode/
   * guardian/vim-mode have NO live backend capability at M49 and are NEVER
   * supplied (their commands stay hidden — no UI-state-only fakes). */
  private slashCapabilities(): SlashCapability[] {
    const b = this.opts.backend
    const caps: SlashCapability[] = []
    if (b.listSessions !== undefined) caps.push("session-list")
    if (b.createSession !== undefined) caps.push("session-create")
    if (b.dashboard !== undefined) caps.push("dashboard")
    if (b.rewind !== undefined) caps.push("rewind")
    if (b.compact !== undefined) caps.push("compact")
    if (b.forkSession !== undefined) caps.push("fork")
    if (b.context !== undefined) caps.push("context")
    if (this.providerController() !== undefined) caps.push("provider-settings")
    return caps
  }

  /** The per-invocation SlashContext: every command behavior is a closure
   * here (the impls never import the loop — unit-testable against a fake ctx). */
  private slashCtx(input: string, arg = ""): SlashContext {
    const app = this.app
    return {
      app,
      backend: this.opts.backend,
      engine: this.opts.engine,
      input,
      arg,
      capabilities: this.slashCapabilities(),
      workspace: this.opts.workspace,
      sessionId: this.currentSessionId,
      toast: (text) => this.toast(text),
      turns: () => this.turnAnchors().length,
      jumpAnchors: () => this.turnAnchors(),
      gotoLine: (line) => {
        app.scroll = { offset: Math.max(0, line), follow: false }
        this.requestFrame()
      },
      openPanel: (req) => this.openLightPanel(req),
      openSessions: () => {
        if (app.sessions === undefined) this.toggleSessions()
      },
      openHistoryPanel: () => this.openHistoryPicker(),
      openRewind: () => this.openRewind(),
      startSearch: (pattern) => this.activateSearch(pattern),
      planRows: () => this.lastAssistantRows(),
      toggleBtwWith: (question) => this.toggleBtwWith(question),
      openBtwInput: () => this.openBtwInput(),
      setScreen: (screen) => {
        if (screen === "welcome") {
          this.activateWelcome()
          app.welcome = {
            version: "0.1.0",
            menus: app.welcome?.menus ?? [],
            cursor: 0,
            modelState: app.welcome?.modelState ?? { status: "loading" },
          }
        } else if (this.currentSessionId !== undefined) {
          this.activateAgent(this.currentSessionId)
        } else {
          app.screen = "agent"
        }
        this.requestFrame()
      },
      setTheme: (kind) => {
        void this.themeCommit(kind).catch((error: unknown) => {
          this.toast(`theme: not persisted — ${error instanceof Error ? error.message : String(error)}`)
        })
      },
      setTimestamps: (on) => this.setTimestamps(on),
      setMultiline: (on) => {
        app.prompt.multiLine = on
        this.refreshShortcuts()
      },
      setCompactMode: (on) => {
        app.compactMode = on
      },
      focusPrompt: () => this.focus("prompt"),
      resetSession: () => this.resetSession(),
      renameSession: (title) => void this.renameSession(title),
      relaunch: () => this.relaunchSlash(input),
      quitApp: () => this.requestQuit(),
      copy: () => this.copySelectedBlock(),
      editPromptInEditor: () => this.editPromptInEditor(),
      exportTranscript: () => this.exportTranscript(),
      openTranscriptPager: () => this.openTranscriptPager(),
      // M47 G2: /doctor is LIVE — the command opened the Probing… panel first;
      // the microtask checkpoint lets that frame PAINT (the suspend must not
      // swallow it), then the probe re-issues the queries behind the
      // paint-suspend and the rows land when the run settles.
      probeReport: async () => {
        await new Promise<void>((resolve) => queueMicrotask(resolve))
        await this.armLiveProbe()
        return doctorRows(this.cap)
      },
      effort: (level) => this.effort(level),
      mouseReportingToggle: this.mouseToggleFeature(),
      // M46c G2: the /workflow surface + the text-input seam (workflow run
      // params line — the existing bindTextInput overlay under a ctx call).
      workflow: this.workflowSurface(),
      openTextInput: (opts) => this.openTextInputOverlay(opts),
      // ---- M49 Task 14 capability-gated seams (spec §10.2)
      createSession: () => this.newSession(),
      dashboard: () => void this.openDashboard(),
      queue: () => this.togglePane("queue"),
      tasks: () => this.togglePane("tasks"),
      openSettings: () => this.openSettings(),
      provider: (arg) => this.openProvider(arg),
      model: (arg) => this.openModelPicker(arg === "" ? undefined : arg),
      fork: (title) => this.forkSession(title),
      openContext: () => this.openContextPanel(),
      visibleCommands: () => this.slash.visible(this.slashCtx(""))
        .map((c) => ({ name: c.name, description: c.description })),
      keyBindings: () => shortcutsFor({
        focused: app.focused,
        multiLine: app.prompt.multiLine,
        turnRunning: app.turn !== undefined,
        mode: app.mode,
        planReview: this.planReviewActive(),
      }).map((s) => ({ key: s.key, label: s.label })),
    }
  }

  /** /new — real backend create (Task 4 rule: absent member fails loudly). */
  private newSession(): void {
    const create = this.opts.backend.createSession
    if (create === undefined) {
      this.toast("new session: backend create seam absent")
      return
    }
    void create().then(
      (sessionId) => {
        this.activateAgent(sessionId)
        this.requestFrame()
      },
      (error: unknown) => this.toast(`new session failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  }

  /** /fork [title] — backend fork (forkSession), optional title rename. */
  private forkSession(title?: string): void {
    const fork = this.opts.backend.forkSession
    if (fork === undefined) {
      this.toast("fork: backend fork seam absent")
      return
    }
    void fork().then(
      (sessionId) => {
        this.activateAgent(sessionId)
        if (title !== undefined && title !== "") void this.renameSession(title)
        this.requestFrame()
      },
      (error: unknown) => this.toast(`fork failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  }

  /** /context — the LOCAL context meter (backend.context; honest empties). */
  private openContextPanel(): void {
    void this.opts.backend.context?.().then(
      (usage) => {
        if (usage === undefined) {
          this.openLightPanel({ kind: "usage", title: "Context · this session", rows: [{ label: "no context usage available (backend probe absent)" }] })
          return
        }
        this.openLightPanel({ kind: "usage", title: "Context · this session", rows: usageRows(usage) })
      },
      (error: unknown) => {
        this.openLightPanel({
          kind: "usage",
          title: "Context · this session",
          rows: [{ label: `context probe failed: ${error instanceof Error ? error.message : String(error)}` }],
        })
      },
    )
  }

  /** /copy — the copy-block action (the checked clipboard adapter; same as y). */
  private copySelectedBlock(): void {
    const sel = this.opts.engine.selection()
    if (sel !== undefined) {
      const total = this.opts.engine.lineCount()
      const lines = this.opts.engine.viewport(0, total).slice(Math.max(0, sel.a), Math.min(total, sel.b + 1))
      this.clipboard.copy(lines.map((l) => l.runs.map((r) => r.text).join("")).join("\n"))
    }
    this.toast("Copied!")
  }

  /**
   * M46c G2: the /workflow surface — the host's option when wired, else the
   * default @i-harness/workflow-backed surface. Cached per app (the executor
   * sits on the process-shared job store — real runs stay visible across
   * invocations). Absent default is never a thing here: command-level honesty
   * lives in the fake-surface tests.
   */
  private workflowSurface(): WorkflowSurface {
    this.workflowHost ??= this.opts.workflow ?? createDefaultWorkflowSurface(this.opts.workspace)
    return this.workflowHost
  }

  /** M46c G2: open the text-input overlay (the /workflow run params line —
   * G1-M46a bindTextInput is the existing seam, already in use for /btw).
   * The ctx signature's onCancel is optional; the binder wants a function. */
  private openTextInputOverlay(opts: { title: string; initial?: string; onSubmit(text: string): void; onCancel?(): void }): void {
    this.app.overlay = bindTextInput({
      title: opts.title,
      ...(opts.initial !== undefined ? { initial: opts.initial } : {}),
      onSubmit: opts.onSubmit,
      onCancel: () => opts.onCancel?.(),
    })
    this.requestFrame()
  }

  /** Open/assure the prompt-history picker (the existing panel). */
  private openHistoryPicker(): void {
    if (this.app.history.length === 0) {
      this.toast("no prompt history yet")
      return
    }
    this.app.historyPanel = {
      entries: this.app.history.map((t) => ({ text: t, highlight: [] })),
      cursor: Math.max(0, this.app.history.length - 1),
    }
    this.requestFrame()
  }

  /** The light panel: state on app.lightPanel (dropdown slot). */
  private openLightPanel(req: SlashPanelRequest): void {
    const panel: LightPanelState = {
      kind: req.kind,
      title: req.title,
      rows: req.rows,
      cursor: req.cursor ?? 0,
      loading: req.loading,
      emptyText: undefined,
      onSelect: req.onSelect,
      // M46c G2: the /workflow status panel's [r] refresh closure (re-fetch
      // rows; the loop's key intercept calls it while the panel is open).
      refresh: req.refresh,
    }
    // Mutually exclusive with the other dropdowns (sessions/history/slash/…).
    this.app.slash = undefined
    this.app.completion = undefined
    this.app.fileSearch = undefined
    this.app.historyPanel = undefined
    this.app.sessions = undefined
    this.app.lightPanel = panel
    this.requestFrame()
  }

  /** Ctrl+S / Alt+S: the draft stash/pop — SWAP semantics (store the current
   * text, restore the stashed one). Toast states per the keys truth. M49 Task
   * 7: both directions are editor transactions (the pop is ONE undoable
   * replaceAll — the previous draft rides the undo stack). */
  private stashDraft(): void {
    const current = this.app.prompt.text
    if (this.app.draft === undefined) {
      if (current.trim().length === 0) {
        this.toast("nothing to stash")
        return
      }
      this.app.draft = current
      this.editor.clear(this.nowMs())
      this.syncPrompt()
      this.toast("Draft stashed")
    } else {
      const stashed = this.app.draft
      this.app.draft = current // swap — the current text returns to the slot
      this.editor.replaceAll(stashed, this.nowMs())
      this.syncPrompt()
      this.toast("Draft restored")
    }
    this.refreshDropdowns()
    this.refreshShortcuts()
    this.requestFrame()
  }

  /** /find: activate the scrollback search mode (the prompt box becomes the
   * search bar; the loop intercepts chars while search is active). An optional
   * pattern prefills the search text (/find <pattern> — the pattern is NOT
   * applied until Enter runs engine.search). */
  private activateSearch(pattern?: string): void {
    this.app.search = { active: true, text: pattern ?? "", matches: [], current: 1 }
    this.focus("scrollback")
    this.toast("find: type the pattern · Enter applies · Esc exits")
  }

  /** Search-mode capture (before the keymap): plain chars/Backspace edit the
   * pattern, Enter applies it (engine.search), Esc exits. */
  private searchKey(ev: InputEvent): boolean {
    const s = this.app.search
    if (s === undefined || s.active !== true || this.app.focused !== "scrollback") return false
    if (ev.type !== "key") return false
    if (ev.code === "char" && !ev.ctrl && !ev.alt) {
      s.text += ev.key
      this.requestFrame()
      return true
    }
    if (ev.code === "Backspace") {
      s.text = s.text.slice(0, -1)
      this.requestFrame()
      return true
    }
    if (ev.code === "Enter") {
      const count = this.opts.engine.search(s.text)
      if (count < 0) this.toast("invalid pattern")
      else if (count === 0) this.toast("no matches")
      else {
        s.matches = this.opts.engine.matches()
        s.current = 0
        this.toast(`find: ${count} match${count === 1 ? "" : "es"}`)
      }
      this.requestFrame()
      return true
    }
    if (ev.code === "Esc") {
      this.opts.engine.clearSearch()
      this.app.search = undefined
      this.toast("find closed")
      return true
    }
    return false
  }

  /** /jump anchors + turn navigation: the ENGINE's O(turns) turnAnchors when
   * present (M46c G1), else the lineBlock walk fallback. Every User block
   * header line (display line → label). */
  private turnAnchors(): Array<{ line: number; n: number; text?: string }> {
    const eng = this.opts.engine
    if (eng.turnAnchors !== undefined) {
      return eng.turnAnchors().map((a, i) => ({ line: a.lineIndex, n: i + 1, text: a.preview }))
    }
    const total = eng.lineCount()
    const out: Array<{ line: number; n: number; text?: string }> = []
    let n = 0
    for (let line = 0; line < total; line++) {
      const block = eng.lineBlock(line)
      if (block === undefined || block.title !== "User") continue
      n++
      const text = block.runs.map((r) => r.text).join("").replace(/^[❯\s]+/, "").slice(0, 40)
      out.push({ line, n, text })
    }
    return out
  }

  /** M46c G1: turn navigation — jump the viewport to the previous/next turn
   * RELATIVE to the current view (the LAST turn anchored at/above the
   * viewport's bottom line is the active — the L/H keys + the timeline
   * chevrons share it). */
  private gotoTurnRel(dir: -1 | 1): void {
    const anchors = this.turnAnchors()
    if (anchors.length === 0) return
    const off = this.app.scroll.follow
      ? Math.max(0, this.opts.engine.lineCount() - this.opts.renderer.buffer.height + 1)
      : this.app.scroll.offset
    // active anchor = the LAST anchor at/above the viewport's bottom line.
    let active = 0
    for (let i = 0; i < anchors.length; i++) {
      if (anchors[i]!.line <= off + this.opts.renderer.buffer.height - 1) active = i
    }
    const target = active + dir
    if (target < 0 || target >= anchors.length) return
    const line = anchors[target]!.line
    this.app.scroll = { offset: Math.max(0, line), follow: false }
    this.requestFrame()
  }

  /** The LAST assistant block's display rows (the /plan //view-plan viewer —
   * C13's plan text = the last assistant message). */
  private lastAssistantRows(): Array<{ label: string }> {
    const total = this.opts.engine.lineCount()
    for (let start = total - 1; start >= 0; start--) {
      const block = this.opts.engine.lineBlock(start)
      if (block === undefined || block.title !== "Assistant") continue
      const rows: Array<{ label: string }> = []
      const lines = this.opts.engine.viewport(start, Math.min(24, total - start))
      for (const line of lines) {
        rows.push({ label: line.runs.map((r) => r.text).join("") })
      }
      return rows.length > 0 ? rows : [{ label: "(empty plan)" }]
    }
    return [{ label: "(no plan yet)" }]
  }

  /** /btw <question>: show the btw overlay + steer the question (real
   * interject); a bare /btw when one is open closes it. */
  private toggleBtwWith(question: string): void {
    if (question.trim().length === 0) {
      this.toggleBtwInput()
      return
    }
    const existing = this.app.paneData?.btw
    this.app.paneData = { ...(this.app.paneData ?? {}), btw: { question, state: "asking", nowMs: this.opts.now?.() ?? Date.now() } }
    if (existing !== undefined) {
      // second /btw with a question — toast + re-steer (no toggle confusion).
      this.toast(`btw: ${question}`)
    }
    void this.opts.backend.steer(question).catch((error: unknown) => {
      this.toast(`btw failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.requestFrame()
  }

  /** The btw input overlay (bare /btw — asks for the question). */
  private toggleBtwInput(): void {
    if (this.app.paneData?.btw !== undefined && this.app.overlay === undefined) {
      this.app.paneData = { ...(this.app.paneData ?? {}) }
      delete this.app.paneData.btw
      this.toast("btw closed")
      this.requestFrame()
      return
    }
    this.openBtwInput()
  }

  private openBtwInput(): void {
    this.app.overlay = bindTextInput({
      title: "btw",
      initial: "",
      onSubmit: (text) => {
        this.app.overlay = undefined
        if (text.trim().length > 0) this.toggleBtwWith(text)
        else this.toast("btw cancelled")
      },
      onCancel: () => {
        this.app.overlay = undefined
        this.toast("btw cancelled")
      },
    })
    this.requestFrame()
  }

  /** M49 Task 8 — the SHARED theme path (design §9.3): preview (live palette
   * re-resolve) → commit (durable settings write) → rollback (re-apply the
   * previous when the persist fails). `/theme`'s ctx.setTheme and the Settings
   * row's host.applyTheme use the SAME two closures: themePreview (live) is the
   * Settings definition's preview/rollback, themeCommit is /theme's route. */
  private themePreview(theme: SettingsTheme): void {
    this.app.theme = theme === "system" ? "auto" : theme
    this.palette = resolvePalette(this.cap, theme === "system" ? undefined : theme)
    this.requestFrame()
  }

  /** /theme's route: preview, persist through the settings surface, and roll
   * the live preview back when the write fails. Hosts without a wired settings
   * surface (legacy unit hosts) keep the live-only behavior — never a silent
   * degrade in production, whose executable always wires the store. */
  private themeCommit(theme: SettingsTheme): Promise<void> {
    const surface = this.providerController()?.settingsSurface()
    const current: SettingsTheme = this.app.theme === "auto"
      ? "system"
      : (this.app.theme ?? "system")
    const previous = surface?.get().theme ?? current
    this.themePreview(theme)
    if (surface === undefined) return Promise.resolve()
    return surface.set({ theme }).then(
      () => undefined,
      (error: unknown) => {
        this.themePreview(previous)
        throw error
      },
    )
  }

  /** /timestamps — the engine's runtime toggle (rows gain ts on the next
   * viewport draw); engines without the accessor → honest toast. */
  private setTimestamps(on: boolean): void {
    this.app.timestamps = on
    const engine = this.opts.engine
    if (engine.setShowTimestamps === undefined) {
      this.toast("timestamps: engine has no runtime toggle")
      return
    }
    engine.setShowTimestamps(on)
    this.requestFrame()
  }

  /** /new //delete — the in-session reset (persistence limits documented in
   * the commands' descriptions; the embedded session is in-process M38). */
  private resetSession(): void {
    this.app.history = []
    this.app.historyIndex = 0
    this.editor.clear(this.nowMs())
    this.syncPrompt()
    this.app.prompt.multiLine = false
    this.app.prompt.title = "untitled"
    this.app.title = "untitled"
    this.app.mode = "normal"
    this.app.status.plan = false
    this.app.prompt.plan = false
    this.app.status.todo = { done: 0, total: 0 }
    this.app.paneData = undefined
    this.app.panes.clear()
    this.app.turn = undefined
    this.app.search = undefined
    this.app.lightPanel = undefined
    this.app.sessions = undefined
    this.app.historyPanel = undefined
    this.app.slash = undefined
    this.app.completion = undefined
    this.refreshShortcuts()
    this.refreshDropdowns()
    this.toast("new session (in-process reset — persistence lands M38)")
    this.requestFrame()
  }

  /** Backend-committed session switch. The control event is ordered before
   * replacement history, so low sequence numbers and all derived UI state
   * start from one atomic boundary. Global appearance/provider state stays. */
  private resetSessionView(sessionId: string): void {
    this.sessionGeneration++
    this.activateAgent(sessionId)
    this.app.history = []
    this.app.historyIndex = 0
    this.editor.clear(this.nowMs())
    this.syncPrompt()
    this.app.prompt.multiLine = false
    this.app.prompt.focused = true
    this.app.prompt.title = "untitled"
    this.app.prompt.plan = false
    this.app.promptCursor = 0
    this.app.title = "untitled"
    this.app.mode = "normal"
    this.app.status.plan = false
    this.app.status.goal = undefined
    this.app.status.contextUsed = undefined
    this.app.status.contextTotal = undefined
    this.app.status.todo = { done: 0, total: 0 }
    this.app.status.tasks = { running: 0, labels: [] }
    this.app.status.queue = 0
    // M49 Task 13: the derived status segments belong to the closed session
    // (the recompute below re-derives them from backend truth).
    this.app.status.session = undefined
    this.app.status.turnTimerMs = undefined
    // M49 Task 13 (spec §9.6): the reset cleared the session-derived counts —
    // RECOMPUTE from backend truth NOW (the next boundary may be far away and
    // the empty queue/0 may be the lie — the real queued prompt still waits).
    this.refreshStatusLine()
    this.app.paneData = undefined
    // M49 Task 12: the task-view cache belongs to the closed session.
    this.tasksViewCache = undefined
    this.app.panes.clear()
    this.app.turn = undefined
    this.app.scroll = { offset: 0, follow: true }
    this.app.focused = "prompt"
    this.app.search = undefined
    this.app.overlay = undefined
    this.app.lightPanel = undefined
    this.app.sessions = undefined
    this.app.historyPanel = undefined
    this.app.slash = undefined
    this.app.completion = undefined
    // M49 Task 10: a session switch closes any open modal (the owner + state).
    this.modalOwner.close()
    this.app.modal = undefined
    this.app.fileSearch = undefined
    this.app.dimFrom = undefined
    this.app.draft = undefined
    this.app.selectionFlashUntil = undefined
    this.app.promptSelect = undefined
    this.app.selectionDragLine = undefined
    this.armedQuit = false
    this.armedRewind = false
    this.commits = undefined
    this.refreshShortcuts()
    this.refreshDropdowns()
    this.refreshContext()
    this.refreshQueue()
  }

  /** /rename — app title + the backend rename bridge (the session-title
   * backend; embedded appends the session/title event → the title event
   * flows back through the stream). */
  private async renameSession(title: string): Promise<void> {
    const norm = title.trim().slice(0, 200)
    if (norm.length === 0) {
      this.toast("rename: empty title")
      return
    }
    this.app.title = norm
    this.app.prompt.title = norm
    this.toast(`session title: ${norm}`)
    if (this.opts.backend.rename !== undefined) {
      await this.opts.backend.rename(norm).catch((error: unknown) => {
        this.toast(`rename failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    this.toast("rename: backend seam absent — title updated in-session only")
  }

  /** /delete — confirm → the deleted marker + welcome (the honest embedded
   * limits: an in-process session has no durable store to delete). */
  /** /minimal //fullscreen — the host's ModeSwitch relay (spawns the same
   * session in the target mode); true ⇒ the command's run quits the loop. */
  private relaunchSlash(input: string): boolean {
    const modeSwitch = this.opts.modeSwitch
    if (modeSwitch !== undefined && modeSwitch(input)) return true
    this.toast("mode relay: host modeSwitch not wired")
    return false
  }

  /** /effort — the REAL settings write (llm.defaultModel.reasoningEffort via
   * the provider controller's settings surface); the interactive six-level
   * picker is the settings modal's Models & Providers flow. No arg → report
   * the current effort. */
  private effort(level: string): void {
    const controller = this.providerController()
    if (controller === undefined) {
      this.toast("effort: settings host store not wired")
      return
    }
    const dm = controller.defaultModel()
    if (level.trim() === "") {
      this.toast(`effort: ${dm.reasoningEffort ?? "default"} — /effort <level> to set`)
      return
    }
    const lv = level.trim()
    const surface = controller.settingsSurface()
    const cur = surface.get()
    void surface
      .set({ llm: { ...cur.llm, defaultModel: { ...cur.llm.defaultModel, reasoningEffort: lv } } })
      .then(
        () => this.toast(`effort: ${lv}`),
        (error: unknown) => this.toast(`effort failed: ${error instanceof Error ? error.message : String(error)}`),
      )
  }

  /** Minimal Ctrl+G: spawn $EDITOR over the current prompt text (temp file
   * round-trip — honest simple; Windows fallback notepad). */
  private editPromptInEditor(): void {
    void this.editorRoundTrip()
  }

  private async editorRoundTrip(): Promise<void> {
    try {
      const { writeFileSync, readFileSync } = await import("node:fs")
      const { tmpdir } = await import("node:os")
      const { join } = await import("node:path")
      const file = join(tmpdir(), `ih-prompt-${Date.now()}.txt`)
      writeFileSync(file, this.app.prompt.text, "utf8")
      const editor = process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "vi")
      const { spawn } = await import("node:child_process")
      const child = spawn(editor, [file], { stdio: "inherit", shell: process.platform === "win32" })
      await new Promise<void>((resolve) => child.once("close", () => resolve()))
      const text = readFileSync(file, "utf8")
      // M49 Task 7: the external-editor replacement is ONE undoable replaceAll.
      this.editor.replaceAll(text, this.nowMs())
      this.syncPrompt()
      this.refreshDropdowns()
      this.toast("prompt edited")
    } catch (error) {
      this.toast(`$EDITOR failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** /export — serialize the engine rows into <workspace>/transcript-*.txt (a
   * REAL write; the transcript is the display rows' text). */
  private async exportTranscript(): Promise<string | undefined> {
    try {
      const { writeFileSync } = await import("node:fs")
      const { join } = await import("node:path")
      const dir = this.opts.workspace ?? process.cwd()
      const file = join(dir, `transcript-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`)
      writeFileSync(file, this.transcriptText(), "utf8")
      this.toast(`exported: ${file}`)
      return file
    } catch (error) {
      this.toast(`export failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** /transcript — same serialization into a temp .ansi and spawn $PAGER
   * (honest simple: PAGER env honored; Windows fallback `cmd /c start`). */
  private async openTranscriptPager(): Promise<boolean> {
    try {
      const { writeFileSync } = await import("node:fs")
      const { tmpdir } = await import("node:os")
      const { join } = await import("node:path")
      const file = join(tmpdir(), `ih-transcript-${Date.now()}.ansi`)
      writeFileSync(file, this.transcriptText(), "utf8")
      const { spawn } = await import("node:child_process")
      const pager = process.env.PAGER
      if (pager !== undefined && pager !== "") {
        const child = spawn(pager, [file], { stdio: "inherit", shell: true })
        await new Promise<void>((resolve) => child.once("close", () => resolve()))
        return true
      }
      if (process.platform === "win32") {
        const child = spawn("cmd", ["/c", "start", "", file], { stdio: "ignore", detached: true })
        child.unref()
        return true
      }
      const child = spawn("less", [file], { stdio: "inherit" })
      await new Promise<void>((resolve) => child.once("close", () => resolve()))
      return true
    } catch (error) {
      this.toast(`transcript failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** The plain-transcript text (display rows, one per line). */
  private transcriptText(): string {
    const total = this.opts.engine.lineCount()
    const lines = this.opts.engine.viewport(0, total)
    return lines.map((l) => l.runs.map((r) => r.text).join("")).join("\n") + "\n"
  }

  // ------------------------------------------------------------------ provider/settings/model modals (M49 Task 6)

  /** The provider controller (host option else undefined). */
  private providerController(): ProviderController | undefined {
    return this.opts.providerController
  }

  /** The G1 slash-text interception: "/provider [variant]", "/model [name]",
   * "/settings" — returns true when handled (the prompt is cleared; the modal
   * opens or a toast explains). Unrecognized G1 text (e.g. "/effort" — G2's)
   * falls through to the backend. */
  private tryG1SlashModal(line: string): boolean {
    const controller = this.providerController()
    // M49 Task 14: with no live provider controller the G1 modals are NOT
    // reachable — the registry's provider-settings gate hides them and the
    // submit path renders the exact "Unsupported command: /<name>" contract
    // (never a separate not-wired toast-fake).
    if (controller === undefined) return false
    if (line === "/settings" || line.startsWith("/settings ")) {
      this.openSettings()
      return true
    }
    if (line.startsWith("/model")) {
      const arg = line.slice("/model".length).trim()
      this.openModelPicker(arg.startsWith("(") ? undefined : arg === "" ? undefined : arg)
      return true
    }
    if (/^\/provider(\s|$)/.test(line)) {
      const arg = line.slice("/provider".length).trim()
      this.openProvider(arg)
      return true
    }
    return false
  }

  /** `/provider [args]` — variants: show|list → the menu; add <id> [base] →
   * the editor prefilled; update <id> → the editor editing; use|switch <id> →
   * select (discovery) + toast; delete [id] → the confirm preselect; reload →
   * re-run discovery over the selected provider (toast result/error). A bare
   * `/provider` = the menu (cc parity). */
  private openProvider(args: string): void {
    const controller = this.providerController()
    if (controller === undefined) {
      this.toast("provider UI: host store not wired")
      return
    }
    const tokens = args.split(/\s+/).filter((t) => t !== "")
    const cmd = tokens[0] ?? ""

    if (cmd === "reload") {
      const id = this.selectedProviderId(controller)
      if (id === "") {
        this.toast("no provider selected — add one with /provider add first")
        return
      }
      this.toast(`discovering models for ${id}…`)
      void controller.discoverModels(id, true).then(
        (count) => this.toast(`discovered ${count} model(s) for ${id}`),
        (error: unknown) => this.toast(error instanceof Error ? error.message : String(error)),
      )
      return
    }
    if (cmd === "use" || cmd === "switch" || cmd === "show" || cmd === "list") {
      const id = tokens[1] ?? this.selectedProviderId(controller)
      if (cmd === "show" || cmd === "list") {
        this.openProviderMenu()
        return
      }
      if (id === "" || tokens[1] === undefined) {
        this.toast("no provider selected — add one with /provider add first")
        return
      }
      void controller.selectProvider(id).then(
        () => this.toast(`provider selected: ${id} — ${controller.state().discovery.status === "ready" ? `${controller.state().discovery.modelCount ?? 0} model(s)` : controller.state().discovery.status}`),
        (error: unknown) => this.toast(error instanceof Error ? error.message : String(error)),
      )
      return
    }
    if (cmd === "add" || cmd === "update") {
      const id = tokens[1]
      const base = tokens[2]
      // protocol=x / modelsUrl=y optional tokens (arg form only — the editor
      // itself defaults the protocol to the canonical openai-completions).
      let protocol: SettingsProviderProtocol | undefined
      let modelsUrl: string | undefined
      for (const t of tokens.slice(1)) {
        const p = /^protocol=(.+)$/.exec(t)
        if (p !== null && p !== undefined && (TUI_PROTOCOLS as readonly string[]).includes(p[1]!)) {
          protocol = canonicalProtocolOf(p[1]!)
        }
        const u = /^modelsUrl=(.+)$/.exec(t)
        if (u !== null && u !== undefined) modelsUrl = u[1]
      }
      const editing = cmd === "update" ? controller.configOf(id ?? "") : undefined
      if (cmd === "update" && editing === undefined) {
        this.toast(`provider "${id}" is not configured`)
        return
      }
      if (id !== undefined && base !== undefined) {
        // Prefilled save path (arg form): create/update + discover.
        void (async () => {
          try {
            await controller.saveProvider({
              id,
              ...(editing?.displayName !== undefined ? { displayName: editing.displayName } : {}),
              protocol: protocol ?? editing?.protocol ?? "openai-completions",
              baseURL: base.replace(/\/+$/, ""),
              ...(modelsUrl !== undefined ? { modelsURL: modelsUrl } : {}),
            })
            await controller.selectProvider(id)
            this.toast(`provider saved: ${id}`)
          } catch (error) {
            this.toast(error instanceof Error ? error.message : String(error))
          }
        })()
        return
      }
      // Interactive editor (prefilled only with the id/base token — the key
      // field starts empty: "Leave empty to keep the current key.").
      const state = this.providerEditorState()
      state.mode = "edit"
      state.editingId = editing !== undefined ? id : undefined
      state.hasExistingKey = editing !== undefined
        && controller.state().providers.find((p) => p.id === id)?.auth?.configured === true
      state.draft = {
        id: id ?? "",
        baseURL: editing?.baseURL ?? "",
        apiKey: "",
      }
      state.field = 0
      state.error = undefined
      state.cursor = 0
      this.app.overlay = bindProviderOverlay(state, this.providerBindOptions(controller))
      this.requestFrame()
      return
    }
    if (cmd === "delete") {
      const target = tokens[1] ?? ""
      this.openProviderMenu(target)
      return
    }
    // bare /provider → the menu (cc parity)
    this.openProviderMenu()
  }

  /** The provider the UI operations target: the controller's selection, else
   * the durable default provider. */
  private selectedProviderId(controller: ProviderController): string {
    return controller.state().selectedProviderId ?? controller.defaultModel().provider ?? ""
  }

  /** A fresh provider editor state (directory rows arrive async — the binder
   * renders it as the honest empty while it loads). */
  private providerEditorState(): ProviderEditorState {
    return {
      mode: "list",
      cursor: 0,
      rows: [],
      draft: undefined,
      field: 0,
      editingId: undefined,
      hasExistingKey: false,
      models: [],
      manual: undefined,
      providerId: "",
      pendingId: undefined,
      error: undefined,
    }
  }

  private async providerRows(controller: ProviderController): Promise<ProviderRow[]> {
    const rows = await controller.directory()
    return rows.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      configured: r.configured,
      hasKey: r.auth.configured,
    }))
  }

  private openProviderMenu(preselectTarget = ""): void {
    const controller = this.providerController()
    if (controller === undefined) {
      this.toast("provider UI: host store not wired")
      return
    }
    const state = this.providerEditorState()
    if (preselectTarget !== "") {
      state.mode = "confirm-delete"
      state.pendingId = preselectTarget
      state.cursor = 0
    }
    void this.providerRows(controller).then((rows) => {
      state.rows = rows
      if (preselectTarget !== "" && !rows.some((r) => r.id === preselectTarget)) {
        state.mode = "list"
        state.pendingId = undefined
        this.toast(`provider "${preselectTarget}" is not configured`)
      }
      this.requestFrame()
    })
    this.app.overlay = bindProviderOverlay(state, this.providerBindOptions(controller))
    this.requestFrame()
  }

  /** The shared provider-binder options: the loop's close + toast channels. */
  private providerBindOptions(controller: ProviderController): ProviderBindOptions {
    return {
      controller,
      onSaved: (outcome) => {
        const verb = outcome.kind === "delete" ? "deleted" : outcome.kind === "add" ? "saved & active" : "updated"
        this.toast(`provider ${verb}: ${outcome.id}`)
      },
      onClose: () => this.closeModal(),
      onToast: (text) => this.toast(text),
    }
  }

  private closeModal(): void {
    this.app.overlay = undefined
    this.requestFrame()
  }

  /** The settings modal (F2/Ctrl+,//settings) — keys per the typed registry
   * (sidebar categories; Enter browses; Esc backs). */
  private openSettings(modelsAndProviders = false): void {
    const controller = this.providerController()
    if (controller === undefined) {
      this.toast("settings modal: host provider controller not wired")
      return
    }
    const registry = createTuiSettingsRegistry({
      settings: controller.settingsSurface(),
      // M49 Task 8: the SAME live path /theme uses (preview — the controller
      // owns the preview/commit/rollback ordering per row).
      colorLevel: this.cap.colorLevel,
      applyTheme: (theme) => this.themePreview(theme),
      applyTimestamps: (on) => {
        // Live engine flip (the knob renders what the engine does).
        this.opts.engine.setShowTimestamps?.(on)
        this.requestFrame()
      },
      applyCompact: (on) => {
        this.app.compactMode = on
        this.requestFrame()
      },
      applyAutoApprove: (on) => {
        this.app.autoApprove = on
      },
      onOpenProviders: () => {
        // The dedicated Models & Providers master/detail flow.
        this.closeModal()
        this.openProviderMenu()
      },
      onOpenPicker: () => {
        // default_model → the same picker Ctrl+M//model use; its select
        // writes the settings default (settings modal reopens below).
        this.openModelPicker(undefined, true)
      },
    })
    const state: SettingsModalState = modelsAndProviders
      ? { phase: "category", cursor: 0, category: "Models & Providers", error: undefined }
      : { phase: "categories", cursor: 0, category: undefined, error: undefined }
    const ctx = {
      has: () => false,
      settings: controller.settingsSurface(),
      providers: controller.providerRuntime(),
      backend: this.opts.backend,
    }
    const overlay = bindSettingsOverlay(state, {
      registry,
      controller: createSettingsController(registry.definitions(), ctx),
      ctx,
      onClose: () => this.closeModal(),
    })
    this.app.overlay = modelsAndProviders
      ? {
          ...overlay,
          draw: (ctxD, view, palette, glyphs) => {
            overlay.draw(ctxD, view, palette, glyphs)
            view.text(ctxD.x + 2, ctxD.y, "Models & Providers", view.color(palette.textPrimary, { bold: true }), ctxD.x + ctxD.w - 1)
          },
        }
      : overlay
    this.requestFrame()
  }

  /** The model picker (Ctrl+M on the agent screen, /model, settings default).
   * The list comes from the SELECTED provider's catalog; an un-discovered
   * provider kicks discovery (loading state). `reopenSettings` — after the
   * picker select, reopen the settings modal (the default_model row now shows
   * the pick). */
  private openModelPicker(_preselect?: string, reopenSettings = false): void {
    const controller = this.providerController()
    if (controller === undefined) {
      this.toast("model picker: host provider controller not wired")
      return
    }
    const selectedId = this.selectedProviderId(controller)
    if (selectedId === "") {
      this.toast("no provider selected — /provider add first")
      return
    }
    const state: ModelPickerState = {
      entries: modelPickerEntries(controller.modelsOf(selectedId)),
      cursor: 0,
      loading: false,
      provider: selectedId,
    }
    this.app.overlay = bindModelPickerOverlay(state, {
      onSelect: (value) => {
        const choice = value === undefined || value === "" ? "(no override)" : value
        const apply = value === undefined || value === ""
          ? controller.clearModelSelection()
          : controller.selectModel(value)
        void apply.then(
          () => this.toast(`default model: ${choice}`),
          (error: unknown) => this.toast(error instanceof Error ? error.message : String(error)),
        )
        if (reopenSettings) this.openSettings()
      },
      onClose: () => this.closeModal(),
    })
    // ONE discovery run per picker open: selectProvider sets the selection
    // synchronously (a concurrent Enter never races it) and runs discovery
    // exactly once (the runtime memo skips the probe when the catalog is
    // already loaded). The continuation refreshes the picker rows from the
    // merged result; a failure keeps the stored catalog + toasts the summary.
    void controller.selectProvider(selectedId).then(
      () => {
        // The picker may have closed (Esc) before discovery resolved — guard.
        if (this.app.overlay === undefined) return
        const cur = this.app.overlay
        if ((cur as { kind?: string }).kind !== "model-picker") return
        state.entries = modelPickerEntries(controller.modelsOf(selectedId))
        const discovery = controller.state().discovery
        state.loading = discovery.status === "loading"
        if (discovery.status === "failed" || discovery.status === "manual-only") {
          this.toast(discovery.message ?? "discovery failed")
        }
        this.requestFrame()
      },
      (error: unknown) => {
        if (this.app.overlay === undefined) return
        const cur = this.app.overlay
        if ((cur as { kind?: string }).kind !== "model-picker") return
        // Failure preserves stored models — the catalog below is the stored
        // one; the toast carries the attempt summary.
        state.entries = modelPickerEntries(controller.modelsOf(selectedId))
        state.loading = false
        this.toast(error instanceof Error ? error.message : String(error))
        this.requestFrame()
      },
    )
    this.requestFrame()
  }

  // ------------------------------------------------------------------ panes / pickers / dropdowns (M37b)

  private togglePane(kind: "todo" | "tasks" | "queue"): void {
    if (this.app.panes.has(kind)) {
      this.app.panes.delete(kind)
      // M49 Task 12: closing the tasks pane clears the stale row selection
      // (the pane's data itself stays backend-refreshable).
      if (kind === "tasks") {
        this.app.paneData = { ...(this.app.paneData ?? {}), tasksSelectId: undefined }
      }
    } else {
      this.app.panes.add(kind)
      // M49 Task 11: opening the queue pane fetches backend truth at OPEN time
      // (not a stale fixture projection).
      if (kind === "queue") this.refreshQueuePane()
      // M49 Task 12: same for the tasks pane.
      if (kind === "tasks") this.refreshTasksPane()
    }
    this.requestFrame()
  }

  private toggleSessions(): void {
    if (this.app.sessions !== undefined) {
      this.app.sessions = undefined
      this.requestFrame()
      return
    }
    const loader = this.opts.listSessions ?? (() => this.opts.backend.listSessions())
    const now = this.opts.now?.() ?? Date.now()
    const title = this.app.view?.kind === "welcome" ? "Resume session" : "sessions"
    this.app.sessions = { groups: [], cursor: 0, loading: true, now, title }
    void loader().then((list) => {
      if (this.app.sessions === undefined) return
      this.app.sessions = {
        groups: [{ repo: "sessions", sessions: list.map((s): SessionRow => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          ...(s.turnCount !== undefined ? { turnCount: s.turnCount } : {}),
          contextUsed: s.contextUsed,
          contextTotal: s.contextTotal,
        })) }],
        cursor: 0,
        loading: false,
        now,
        title,
      }
      this.requestFrame()
    }, (error: unknown) => {
      if (this.app.sessions === undefined) return
      this.app.sessions.loading = false
      this.toast(`session list failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /** Cursor moves: -1/+1 (or a page) over the open panel's rows. */
  private overlayNav(delta: number): void {
    const move = (len: number, cursor: number, d: number): number =>
      len <= 0 ? 0 : Math.max(0, Math.min(len - 1, cursor + d))
    const s = this.app.slash
    if (s !== undefined) { s.cursor = move(s.entries.length, s.cursor, delta) }
    const c = this.app.completion
    if (c !== undefined) { c.cursor = move(c.entries.length, c.cursor, delta) }
    const f = this.app.fileSearch
    if (f !== undefined) { f.cursor = move(f.files.length, f.cursor, delta) }
    const h = this.app.historyPanel
    if (h !== undefined) { h.cursor = move(h.entries.length, h.cursor, delta) }
    const lp = this.app.lightPanel
    if (lp !== undefined) { lp.cursor = move(lp.rows.length, lp.cursor, delta) }
    const ss = this.app.sessions
    if (ss !== undefined) {
      const n = flattenSessions(ss).length
      ss.cursor = move(n, ss.cursor, delta)
    }
    if (this.app.overlay !== undefined) this.app.overlay.act?.(delta < 0 ? "overlay-nav-prev" : "overlay-nav-next")
    this.requestFrame()
  }

  private overlayPage(): number {
    return Math.max(1, Math.floor(this.opts.renderer.buffer.height / 10))
  }

  /** Enter / Tab — accept the open dropdown/picker entry. */
  private overlaySelect(): void {
    const ov = this.app.overlay
    if (ov !== undefined) { ov.act?.("overlay-select"); return }
    const s = this.app.slash
    if (s !== undefined) {
      const e = s.entries[s.cursor]
      if (e !== undefined) this.replaceTokenAtCursor(`/${e.command} `)
      this.app.slash = undefined
      this.app.completion = undefined
      return
    }
    const c = this.app.completion
    if (c !== undefined) {
      const e = c.entries[c.cursor]
      if (e !== undefined) this.replaceTokenAtCursor(`${e.label} `)
      this.app.completion = undefined
      return
    }
    const f = this.app.fileSearch
    if (f !== undefined) {
      const file = f.files[f.cursor]
      if (file !== undefined) this.replaceTokenAtCursor(`@${file.path} `)
      this.app.fileSearch = undefined
      return
    }
    const h = this.app.historyPanel
    if (h !== undefined) {
      const e = h.entries[h.cursor]
      if (e !== undefined) {
        // M49 Task 7: the history-panel restore is an undoable transaction.
        this.editor.replaceAll(e.text, this.nowMs())
        this.syncPrompt()
        this.refreshDropdowns()
      }
      this.app.historyPanel = undefined
      return
    }
    const ss = this.app.sessions
    if (ss !== undefined) {
      if (ss.loading === true) return
      const sel = flattenSessions(ss)[ss.cursor]
      if (sel === undefined) return
      ss.loading = true
      this.requestFrame()
      void this.opts.backend.open(sel.session.id).then(
        () => {
          if (this.app.sessions === ss) this.app.sessions = undefined
          this.activateAgent(sel.session.id)
          this.requestFrame()
        },
        (error: unknown) => {
          if (this.app.sessions === ss) ss.loading = false
          this.toast(`session open failed: ${error instanceof Error ? error.message : String(error)}`)
          this.requestFrame()
        },
      )
      return
    }
    // M46a G2 light panels: Enter fires the panel's onSelect (e.g. /jump
    // jumps the viewport; /tutorial swaps to the topic's content — the
    // handler may reopen a panel which re-opens/clears the state below).
    const lp = this.app.lightPanel
    if (lp !== undefined) {
      this.app.lightPanel = undefined
      lp.onSelect?.(lp.cursor)
      this.requestFrame()
      return
    }
  }

  /** Digit accept (1-9). G1 overlays handle it through the seam; my pickers
   * jump straight to the row. */
  private overlayAccept(index: number): void {
    const ov = this.app.overlay
    if (ov !== undefined) { ov.act?.({ type: "overlay-accept", index }); return }
    const h = this.app.historyPanel
    if (h !== undefined) { h.cursor = index; this.overlaySelect(); return }
    const ss = this.app.sessions
    if (ss !== undefined) { ss.cursor = index; this.overlaySelect(); return }
    const s = this.app.slash
    if (s !== undefined && index < s.entries.length) { s.cursor = index; this.overlaySelect(); return }
    const c = this.app.completion
    if (c !== undefined && index < c.entries.length) { c.cursor = index; this.overlaySelect(); return }
    const f = this.app.fileSearch
    if (f !== undefined && index < f.files.length) { f.cursor = index; this.overlaySelect(); return }
  }

  private overlayDismiss(): void {
    const ov = this.app.overlay
    if (ov !== undefined) { ov.act?.("overlay-dismiss"); return }
    this.app.slash = undefined
    this.app.completion = undefined
    this.app.fileSearch = undefined
    this.app.historyPanel = undefined
    this.app.sessions = undefined
    this.app.lightPanel = undefined
    this.requestFrame()
  }

  // ------------------------------------------------------------------ rewind (M43)

  /** Esc-Esc eligibility (spec §4 — empty prompt + ≥1 turn): the backend must
   * expose the rewind bridge AND the scrollback must have content (≥1 turn).
   * The mock factory wires no bridge ⇒ Esc-empty keeps the pre-M43 quit arm. */
  private rewindEligible(): boolean {
    return this.opts.backend.rewind !== undefined
      && !this.inlineActive()
      && this.opts.engine.lineCount() > 0
  }

  /** Open the rewind overlay (the armed second Esc): a FRESH state object per
   * open; the binder drives loading → picker → … via backend.rewind. The
   * engine itself is never touched — its `Rewound to turn {N}` marker + anchor
   * ARRIVE through the event stream when a rewind executes. G2's dim-from
   * (TuiAppState.dimFrom — present.ts) is set to the anchor on open and
   * cleared on close (anchor undefined before any rewind ⇒ no dim). */
  private openRewind(): void {
    if (this.opts.backend.rewind === undefined) return
    this.armedRewind = false
    const state: RewindState = { phase: "loading", points: [], cursor: 0, cleanPaths: [], conflicts: [] }
    this.app.dimFrom = this.opts.engine.rewindAnchor?.()
    this.app.overlay = bindRewindOverlay(state, {
      backend: this.opts.backend,
      onClose: () => {
        this.app.overlay = undefined
        this.app.dimFrom = undefined
        this.armedRewind = false
        this.requestFrame()
      },
    })
    this.requestFrame()
  }

  /** Picker extras whose M37b behavior is cursor-only (tabs/filters: M38). */
  private overlaySub(action: AppAction): void {
    switch (action) {
      case "overlay-search":
      case "overlay-filter": this.toast("picker search/filter: M38"); break
      case "overlay-tab":
      case "overlay-tab-back": this.toast("picker tabs: M38"); break
      case "overlay-toggle": break // Space — marker toggling lands M38
      case "overlay-expand":
      case "overlay-collapse": break // row preview expand: M38
      case "overlay-range-left":
      case "overlay-range-right":
        // permission scope ←/→ — G1's seam owns this; nothing local.
        this.app.overlay?.act?.(action)
        break
      case "overlay-question-prev":
      case "overlay-question-next": this.app.overlay?.act?.(action); break
      default: break
    }
    this.requestFrame()
  }

  // ------------------------------------------------------------------ welcome (M37b)

  private welcomeNav(delta: number): void {
    const w = this.app.welcome
    if (w === undefined || w.menus.length === 0) return
    w.cursor = Math.max(0, Math.min(w.menus.length - 1, w.cursor + delta))
    this.requestFrame()
  }

  private welcomeActivate(action?: "new" | "resume" | "settings" | "quit"): void {
    const w = this.app.welcome
    if (w === undefined || this.welcomeActionP !== undefined) return
    const raw = this.app.prompt.text
    if (action === undefined && raw.trim() !== "") {
      this.runWelcomeAction(async () => {
        const modelState = await this.refreshWelcomeModelState()
        if (modelState.status !== "ready") {
          this.openSettings(true)
          return
        }
        await this.createSessionAndSubmit(raw)
      })
      return
    }

    const selectedAction = action ?? w.menus[w.cursor]?.action
    switch (selectedAction) {
      case "quit": this.requestQuit(); return
      case "resume": this.toggleSessions(); return
      // M49 Task 13: the Dashboard row needs no model gate — the local view
      // opens directly (the SAME view /dashboard uses).
      case "dashboard": void this.openDashboard(); return
      case "settings": this.openSettings(true); return
      case "new":
        this.runWelcomeAction(async () => {
          const modelState = await this.refreshWelcomeModelState()
          if (modelState.status !== "ready") {
            this.openSettings(true)
            return
          }
          // M49 Task 4 rule: optional capability member — guard + METHOD call
          // (extracting the member and calling it unbound would lose the
          // embedded impl's `this` — case-026 regression).
          if (this.opts.backend.createSession === undefined) {
            this.setStartupError("session create unavailable on this backend")
            this.activateWelcome()
            return
          }
          const sessionId = await this.opts.backend.createSession()
          this.activateAgent(sessionId)
        })
        return
      default: return
    }
  }

  private runWelcomeAction(action: () => Promise<void>): void {
    let pending!: Promise<void>
    pending = action()
      .catch((error: unknown) => {
        this.setStartupError(error instanceof Error ? error.message : String(error))
        this.activateWelcome()
      })
      .finally(() => {
        if (this.welcomeActionP === pending) this.welcomeActionP = undefined
        this.requestFrame()
      })
    this.welcomeActionP = pending
  }

  // ------------------------------------------------------------------ slash / @ token plumbing (M37b)

  /** Token under the caret (last whitespace-separated chunk). */
  private tokenAt(text: string, cursor: number): string | undefined {
    const before = text.slice(0, cursor)
    const sp = before.lastIndexOf(" ")
    return before.slice(sp + 1)
  }

  /** Call on every prompt edit: keep the slash/@ dropdowns in sync. */
  private refreshDropdowns(): void {
    const p = this.app.prompt
    const token = this.tokenAt(p.text, p.cursor)

    // Slash dropdown: `/query` — token starts with `/` (empty query = all).
    if (token === undefined || !token.startsWith("/")) {
      this.app.slash = undefined
    } else {
      const query = token.slice(1)
      // M46a G2: the dropdown is the REGISTRY's visible set (visibility-gated
      // completion entries) unless the host still wires the M37b adapter.
      const raw = this.opts.slashCommands ?? this.slash.completionEntries(this.slashCtx(p.text))
      this.app.slash = {
        entries: raw
          .filter((e) => query.length === 0 || e.command.toLowerCase().includes(query.toLowerCase()))
          .map((e) => ({ ...e, fuzzyHit: fuzzyHits(e.command, query) })),
        cursor: 0,
      }
    }

    // `@` file search: token starts with `@`; host option resolves results.
    if (token === undefined || !token.startsWith("@")) {
      this.app.fileSearch = undefined
    } else {
      const query = token.slice(1)
      if (query.length === 0) {
        this.app.fileSearch = undefined
      } else {
        const prev = this.app.fileSearch
        this.app.fileSearch = {
          files: prev?.query === query ? prev.files : [],
          cursor: 0,
          loading: true,
          query,
        }
        void this.resolveSearch(query)
      }
    }

    // Completion (slash args): host rows when the prompt ends `slashcmd `.
    const comp = this.opts.completions
    this.app.completion =
      comp !== undefined && /(^|\s)\/[-\w]+\s$/.test(p.text.slice(0, p.cursor))
        ? { entries: comp(), cursor: 0 }
        : undefined
    this.requestFrame()
  }

  private async resolveSearch(query: string): Promise<void> {
    const searcher = this.opts.searchFiles
    const files = searcher !== undefined ? await searcher(query) : []
    const s = this.app.fileSearch
    if (s !== undefined && s.query === query) {
      this.app.fileSearch = { files, cursor: 0, loading: false, query }
      this.requestFrame()
    }
  }

  /** Replace the token under the caret (slash/at/completion accept). M49 Task
   * 7: an editor transaction (atom-safe range replace). */
  private replaceTokenAtCursor(replacement: string): void {
    const p = this.app.prompt
    const before = p.text.slice(0, p.cursor)
    const start = before.lastIndexOf(" ") + 1
    this.editor.replaceRange(start, p.cursor, replacement, this.nowMs())
    this.syncPrompt()
    this.refreshDropdowns()
  }

  private toast(text: string): void {
    const until = (this.opts.now?.() ?? Date.now()) + 3000
    this.app.toasts.push({ text, until })
    if (this.app.toasts.length > 3) this.app.toasts.shift()
    this.requestFrame()
  }

  private async quitNow(): Promise<void> {
    this.armedQuit = false
    try {
      await this.opts.backend.close()
    } finally {
      await this.stop()
    }
  }

  /** Fire-and-forget quit actions must own close failures; the host-level
   * shutdown path still observes the same backend error when it awaits. */
  private requestQuit(): void {
    void this.quitNow().catch((error: unknown) => {
      console.error(`[i-harness] shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private requestFrame(): void {
    if (this.frameQueued || this.stopped) return
    this.frameQueued = true
    queueMicrotask(() => {
      this.frameQueued = false
      if (!this.stopped) this.frame()
    })
  }

  // ------------------------------------------------------------------ real values (M38b G2)

  /** OPTIONAL backend.context() → app.status.contextUsed/contextTotal. A
   * backend without the member never probes (the chip stays hidden); a probe
   * resolving undefined leaves the previous values untouched. Never concurrent
   * (the owning promise is the guard). */
  private refreshContext(): void {
    const probe = this.opts.backend.context
    if (probe === undefined || this.contextProbe !== undefined) return
    const generation = this.sessionGeneration
    let pending!: Promise<void>
    pending = probe()
      .then((usage) => {
        if (generation !== this.sessionGeneration || usage === undefined) return
        this.app.status.contextUsed = usage.used
        if (usage.total !== undefined) this.app.status.contextTotal = usage.total
        this.requestFrame()
      })
      .catch(() => {})
      .finally(() => {
        if (this.contextProbe !== pending) return
        this.contextProbe = undefined
        if (generation !== this.sessionGeneration) this.refreshContext()
      })
    this.contextProbe = pending
  }

  /** Sync status bits (queue surface) → app.status.queue — refreshed at the
   * turn boundaries + start (the embedded backend is sync; the remote backend
   * serves its notification-cached snapshot). */
  private refreshQueue(): void {
    const q = this.opts.backend.status()
    if (this.app.status.queue !== q.queued) {
      this.app.status.queue = q.queued
      this.requestFrame()
    }
    this.refreshQueuePane()
    this.refreshTasksPane()
    // M49 Task 13: the queue/task counts ride the same boundaries.
    this.refreshStatusLine()
  }

  // ------------------------------------------------------------------ real queue pane (M49 Task 11)

  /** In-flight pane-row probe (never two concurrent refreshes — the promise
   * itself is the guard, same pattern as refreshContext). */
  private queuePaneProbe: Promise<void> | undefined

  /** M49 Task 11: the queue PANE rows — backend truth only. A backend without
   * the queue capability flips the pane to the honest unavailable state
   * (never "Queue is empty." as a stand-in); a failed probe keeps the previous
   * rows (stale truth stays truthful, never fabricated). */
  private refreshQueuePane(): void {
    const probe = this.opts.backend.queue
    // The pane rows belong to the OPEN pane only — a closed pane keeps
    // paneData undefined (session-derived state stays clean across resets).
    const paneOpen = this.app.panes.has("queue")
    if (probe === undefined) {
      if (paneOpen) {
        this.app.paneData = { ...(this.app.paneData ?? {}), queue: [], queueUnavailable: true }
      }
      return
    }
    if (this.queuePaneProbe !== undefined) return
    const generation = this.sessionGeneration
    let pending!: Promise<void>
    pending = probe()
      .then((items: SessionQueueItem[]) => {
        if (generation !== this.sessionGeneration) return
        if (!this.app.panes.has("queue")) return
        const canCancel = this.opts.backend.cancelQueued !== undefined
        this.app.paneData = {
          ...(this.app.paneData ?? {}),
          queue: items.map((item): QueueRow => ({
            id: item.id,
            text: item.text,
            delivery: item.delivery,
            intent: item.intent,
            state: item.state,
            order: item.order,
            canCancel,
          })),
          queueUnavailable: false,
        }
        this.requestFrame()
      })
      .catch(() => { /* backend truth failed — previous rows stay */ })
      .finally(() => {
        if (this.queuePaneProbe !== pending) return
        this.queuePaneProbe = undefined
        if (generation !== this.sessionGeneration) this.refreshQueuePane()
      })
    this.queuePaneProbe = pending
  }

  /** M49 Task 11 (public test seam + behavior): open the queue pane and
   * refresh its rows from backend truth. */
  async openQueue(): Promise<void> {
    if (!this.app.panes.has("queue")) this.app.panes.add("queue")
    this.refreshQueue()
    await this.queuePaneProbe
    this.requestFrame()
  }

  /** M49 Task 11: cancel ONE queued row — the single action both call paths
   * (mouse [cancel], the app-level seam) share; the view then refreshes from
   * backend truth (a `cancelled:false` host leaves the row exactly as the
   * backend lists it). */
  async cancelQueueItem(id: string): Promise<void> {
    const cancel = this.opts.backend.cancelQueued
    if (cancel === undefined) {
      this.toast("queue cancel: backend capability absent")
      return
    }
    try {
      await cancel(id)
    } catch (error) {
      this.toast(`queue cancel failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.refreshQueue()
    await this.queuePaneProbe
    this.requestFrame()
  }

  // ------------------------------------------------------------------ real tasks pane (M49 Task 12)

  /** M49 Task 12: the server-side task snapshot cache (the summary rows the
   * pane derived from — the detail viewer reads them; always refreshed from
   * backend truth). */
  private tasksViewCache: Map<string, AgentTaskView> | undefined

  /** In-flight pane-row probe (never two concurrent refreshes — the same
   * promise guard pattern as refreshQueuePane). */
  private tasksPaneProbe: Promise<void> | undefined

  /** M49 Task 12: the tasks PANE rows — backend truth only. A backend without
   * the tasks capability flips the pane to the honest unavailable state
   * (never "No active tasks." as a stand-in); a failed probe keeps the
   * previous rows (stale truth stays truthful). */
  private refreshTasksPane(): void {
    const probe = this.opts.backend.tasks
    const paneOpen = this.app.panes.has("tasks")
    if (probe === undefined) {
      if (paneOpen) {
        this.app.paneData = { ...(this.app.paneData ?? {}), tasks: [], tasksUnavailable: true }
      }
      return
    }
    if (this.tasksPaneProbe !== undefined) return
    const generation = this.sessionGeneration
    let pending!: Promise<void>
    pending = probe()
      .then((items: AgentTaskView[]) => {
        if (generation !== this.sessionGeneration) return
        if (!this.app.panes.has("tasks")) return
        this.tasksViewCache = new Map(items.map((row) => [row.id, row]))
        const canCancel = this.opts.backend.cancelTask !== undefined
        this.app.paneData = {
          ...(this.app.paneData ?? {}),
          tasks: groupTaskViews(items, canCancel, this.opts.now?.() ?? Date.now(), this.app.paneData?.tasks),
          tasksUnavailable: false,
        }
        this.requestFrame()
      })
      .catch(() => { /* backend truth failed — previous rows stay */ })
      .finally(() => {
        if (this.tasksPaneProbe !== pending) return
        this.tasksPaneProbe = undefined
        if (generation !== this.sessionGeneration) this.refreshTasksPane()
      })
    this.tasksPaneProbe = pending
  }

  /** M49 Task 12 (public test seam + behavior): open the tasks pane and
   * refresh its rows from backend truth. */
  async openTasks(): Promise<void> {
    if (!this.app.panes.has("tasks")) this.app.panes.add("tasks")
    this.refreshTasksPane()
    await this.tasksPaneProbe
    this.requestFrame()
  }

  /** M49 Task 12: cancel ONE task — the single action both call paths (mouse
   * [✗], the app-level seam) share; the pane then refreshes from backend
   * truth (a refusal leaves the row exactly as the backend lists it). */
  async cancelTaskId(id: string): Promise<void> {
    const cancel = this.opts.backend.cancelTask
    if (cancel === undefined) {
      this.toast("task cancel: backend capability absent")
      return
    }
    try {
      const status = await cancel(id)
      this.toast(status === "already-finished" ? `task ${id}: already finished` : `task ${id}: cancellation requested`)
    } catch (error) {
      this.toast(`task cancel failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.refreshTasksPane()
    await this.tasksPaneProbe
    this.requestFrame()
  }

  /** M49 Task 12: open the Task detail viewer for the row with the STABLE id —
   * the same action the Enter-seam, the mouse double-click and the app-level
   * seam share. The viewer extends the block viewer: the row's summary data +
   * the honest transcript evidence lines (parent-log evidence when
   * reconstructible, an unavailable explanation otherwise). */
  async openTaskViewer(id: string): Promise<void> {
    if (this.inlineActive()) return
    const view = this.tasksViewCache?.get(id)
    if (view === undefined) {
      this.toast(`task viewer: unknown task ${id}`)
      return
    }
    const presentation = createTaskPresentation(view, this.taskTranscriptLines(view))
    const viewer = createBlockViewer(presentation, {
      copy: async (text) => {
        const r = await checkedCopy(this.clipboard, text)
        if (!r.ok) throw new Error(r.error)
      },
    })
    this.modalOwner.open({ kind: "block-viewer", viewer })
    this.app.modal = { kind: "block-viewer", viewer }
    this.app.slash = undefined
    this.app.completion = undefined
    this.app.fileSearch = undefined
    this.app.historyPanel = undefined
    this.app.sessions = undefined
    this.app.lightPanel = undefined
    this.requestFrame()
  }

  // ------------------------------------------------------------------ local dashboard + status line (M49 Task 13)

  /** The shared dashboard state (rows/filter/selection/pins). */
  get dashboard(): DashboardState {
    return this.app.dashboard!
  }

  /** Open the dashboard (from the welcome screen or the agent screen). The
   * dashboard state persists — the filter/cursor survive the round trip
   * (spec §8.3: Agent→Dashboard preserves them). */
  async openDashboard(): Promise<void> {
    this.dashboardFrom = this.app.screen === "welcome" ? "welcome" : "agent"
    this.app.view = { kind: "dashboard" }
    this.app.screen = "dashboard"
    this.app.dashboardPeek = undefined
    this.refreshDashboard()
    this.refreshStatusLine()
    this.requestFrame()
  }

  /** Toggle: agent/welcome → dashboard; dashboard → the previous surface. */
  toggleDashboard(): void {
    if (this.app.screen === "dashboard") {
      this.backFromDashboard()
      return
    }
    void this.openDashboard()
  }

  /** Close the dashboard back to the surface it was opened from (the row
   * selection/filter survive — the dashboard state is the app's). */
  async goHome(): Promise<void> {
    this.app.dashboardPeek = undefined
    if (this.dashboardFrom === "welcome") {
      this.activateWelcome()
    } else if (this.currentSessionId !== undefined) {
      this.activateAgent(this.currentSessionId)
    } else {
      this.app.screen = "agent"
    }
    this.requestFrame()
  }

  private backFromDashboard(): void {
    void this.goHome()
  }

  /** Open the SELECTED dashboard row (Enter — the same action the keyboard
   * and the mouse double-click share): the backend switches, the agent view
   * activates; the return path (goHome) preserves the dashboard state. */
  async openSelectedDashboardSession(): Promise<void> {
    const id = this.app.dashboard?.selectedId()
    if (id === undefined) {
      this.toast("dashboard: nothing to open")
      return
    }
    try {
      await this.opts.backend.open(id)
    } catch (error) {
      this.toast(`session open failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.activateAgent(id)
    this.app.dashboardPeek = undefined
    this.refreshDashboard()
    this.requestFrame()
  }

  /** Refresh the dashboard rows from backend truth. A capability-absent
   * backend flips the honest unavailable state (never a fabricated empty
   * list); a FAILED fetch keeps the previous rows (stale truth stays
   * truthful). */
  async refreshDashboard(): Promise<void> {
    const probe = this.opts.backend.dashboard
    if (probe === undefined) {
      this.app.dashboardLoading = false
      this.app.dashboardUnavailable = true
      this.app.dashboardFetchFailed = false
      this.app.dashboard?.replaceRows([])
      this.requestFrame()
      return
    }
    this.app.dashboardLoading = true
    this.requestFrame()
    try {
      const result = await probe()
      this.app.dashboard?.replaceRows(result.sessions)
      // listingUnavailable (the server's honest blank — no listing source)
      // renders the SAME unavailable state as a capability-absent backend,
      // NEVER "No local sessions yet" for it.
      this.app.dashboardUnavailable = result.listingUnavailable === true
      this.app.dashboardFetchFailed = false
    } catch {
      // Backend truth failed — the previous rows STAY (stale truth stays
      // truthful) and the honest fetch-failed note marks the surface (never
      // "no sessions" standing in for an error).
      this.app.dashboardUnavailable = false
      this.app.dashboardFetchFailed = true
    } finally {
      this.app.dashboardLoading = false
      this.requestFrame()
    }
  }

  /** Dashboard "new session" (Ctrl+N): the normal create gate — capability-
   * gated (an absent seam fails loudly, never a silent no-op), opens the
   * created session in the agent view and refreshes the dashboard list. */
  private dashboardCreateSession(): void {
    if (this.opts.backend.createSession === undefined) {
      this.toast("dashboard: session create unavailable on this backend")
      return
    }
    void this.opts.backend.createSession().then(
      (id) => {
        void this.refreshDashboard()
        this.activateAgent(id)
        this.requestFrame()
      },
      (error: unknown) => {
        this.toast(`dashboard: session create failed: ${error instanceof Error ? error.message : String(error)}`)
        void this.refreshDashboard()
        this.requestFrame()
      },
    )
  }

  /** Dashboard tail peek (p): the selected LIVE session's real log tail. */
  private peekDashboardSession(): void {
    const id = this.app.dashboard?.selectedId()
    if (id === undefined) {
      this.toast("dashboard: nothing to peek")
      return
    }
    const peek = this.opts.backend.peekTail
    if (peek === undefined) {
      this.toast("dashboard: tail peek unavailable on this backend")
      return
    }
    void peek(id).then(
      (lines) => {
        this.app.dashboardPeek = { id, lines: lines.slice(-5) }
        this.requestFrame()
      },
      (error: unknown) => {
        if (this.app.screen !== "dashboard") return
        this.toast(`dashboard peek failed: ${error instanceof Error ? error.message : String(error)}`)
        this.requestFrame()
      },
    )
  }

  /** Dashboard pin toggle (P) — persisted ONLY as the id lists (the host
   * commit path prunes missing ids after a successful write). */
  private toggleDashboardPin(): void {
    const dash = this.app.dashboard
    const id = dash?.selectedId()
    if (dash === undefined || id === undefined) return
    if (dash.isPinned(id)) dash.unpin(id)
    else dash.pin(id)
    this.persistDashboardPrefs()
    this.requestFrame()
  }

  /** Dashboard pin-order move ([ / ]) — reorders the pinned block. */
  private dashboardMoveOrder(delta: 1 | -1): void {
    const dash = this.app.dashboard
    const id = dash?.selectedId()
    if (dash === undefined || id === undefined || !dash.isPinned(id)) return
    dash.movePin(id, delta)
    this.persistDashboardPrefs()
    this.requestFrame()
  }

  /** The host persistence hook — the loop NEVER writes settings itself (the
   * host owns the store; this only forwards the current id lists). When the
   * write RESOLVES successfully the state prunes ids that are no longer in
   * the authoritative rows (missing ids are deleted only there — a failed
   * write keeps them). */
  private persistDashboardPrefs(): void {
    const dash = this.app.dashboard
    if (dash === undefined) return
    const result = this.opts.onDashboardPrefs?.(dash.persistedDashboard())
    void Promise.resolve(result).then(
      () => {
        if (this.app.dashboard !== dash) return
        dash.pruneMissing(dash.rows())
      },
      () => { /* failed write — missing ids stay (not deleted) */ },
    )
  }

  private dashboardFilterBackspace(): void {
    const dash = this.app.dashboard
    if (dash === undefined) return
    dash.setFilter(dash.filter().slice(0, -1))
    this.requestFrame()
  }

  /** M49 Task 13 (spec §9.6): recompute the status row from the app's REAL
   * sources — guarded by the in-flight promise (never two concurrent, same
   * pattern as refreshContext). The command branch refreshes through the
   * injected source (the source owns the ≥300ms floor and the two-failure
   * retention — the loop only expects its sanitized text or the error
   * indicator). */
  private refreshStatusLine(): void {
    if (this.statusLineProbe !== undefined) return
    const cfg = this.opts.statusLine
    if (cfg === undefined) return
    const generation = this.sessionGeneration
    let pending!: Promise<void>
    pending = (async () => {
      // The command branch is gated FIRST (its cadence): the anim pump calls
      // the recompute every 33ms — a not-due tick does NO backend work
      // (no tasks() RPC 30×/s against a remote backend), and the draw path
      // never blocks on the source (fire-and-forget, guarded per interval).
      if (cfg.mode === "command") {
        const source = cfg.commandSource
        if (source === undefined) return
        // refresh cadence (spec §9.6): the source is skipped until
        // max(300ms, refreshMs) elapsed (the source never drops an explicit
        // refresh itself: this is the ONLY rate gate).
        const now = this.nowMs()
        const interval = Math.max(STATUS_LINE_MIN_REFRESH_MS, cfg.commandRefreshMs ?? STATUS_LINE_MIN_REFRESH_MS)
        if (now - this.lastCommandRefreshAt < interval) return
        this.lastCommandRefreshAt = now
        // the context carries the CURRENT task count — backend-tasks truth
        // only; a failed fetch keeps the last known count (never a fabricated
        // zero), a capability-absent backend sends the app's last known too.
        let tasksRunning = this.app.status.tasks.running
        const tasksProbe = this.opts.backend.tasks
        if (tasksProbe !== undefined) {
          try {
            const rows = await tasksProbe()
            tasksRunning = rows.filter(
              (row) => row.status === "queued" || row.status === "running" || row.status === "waiting",
            ).length
          } catch {
            /* backend truth failed — the ctx keeps the last known count */
          }
        }
        if (generation !== this.sessionGeneration) return
        const s = this.app.status
        const ctx: StatusCommandContext = {
          workspace: this.opts.workspace ?? process.cwd(),
          ...(this.currentSessionId !== undefined ? { sessionId: this.currentSessionId } : {}),
          ...(s.session !== undefined ? { sessionTitle: s.session } : {}),
          ...(s.modelKnown === true && s.model !== "" ? { model: s.model } : {}),
          queue: this.opts.backend.status(),
          tasks: tasksRunning,
          ...(s.todo.total > 0 ? { todo: s.todo } : {}),
          ...(s.goal !== undefined ? { goal: s.goal } : {}),
          nowMs: this.nowMs(),
        }
        try {
          const text = await source.refresh(ctx)
          if (generation !== this.sessionGeneration) return
          if (this.app.status.command !== text) {
            this.app.status.command = text
            this.requestFrame()
          }
        } catch {
          /* the source never rejects (it owns the error indicator) — a
           * defensive catch keeps the previous row value */
        }
        return
      }
      // tasks segment: backend-tasks truth only (capability-absent → omitted).
      let tasks: { running: number } | undefined
      const probe = this.opts.backend.tasks
      if (probe !== undefined) {
        try {
          const rows = await probe()
          const running = rows.filter(
            (row) => row.status === "queued" || row.status === "running" || row.status === "waiting",
          ).length
          if (running > 0) tasks = { running }
        } catch {
          /* backend truth failed — the tasks segment stays omitted */
        }
      }
      if (generation !== this.sessionGeneration) return
      const s = this.app.status
      const input: StatusAggregateInput = {
        workspace: this.opts.workspace ?? process.cwd(),
        ...(cfg.branch !== undefined ? { branch: cfg.branch } : {}),
        ...(this.lastModelState !== undefined ? { modelState: this.lastModelState } : {}),
        context: s.contextUsed !== undefined
          ? { used: s.contextUsed, ...(s.contextTotal !== undefined ? { total: s.contextTotal } : {}) }
          : undefined,
        turnTimerMs: this.app.turn !== undefined ? this.app.turn.turnMs : undefined,
        ...(s.session !== undefined && s.session !== "" ? { session: s.session } : {}),
        queueState: this.opts.backend.status(),
        tasks,
        ...(s.todo.total > 0 ? { todo: s.todo } : {}),
        ...(s.goal !== undefined ? { goal: s.goal } : {}),
      }
      const st = await collectStatus(input, { items: cfg.items })
      if (generation !== this.sessionGeneration) return
      this.applyStatusState(st, tasks)
      this.requestFrame()
    })().finally(() => {
      if (this.statusLineProbe === pending) this.statusLineProbe = undefined
    })
    this.statusLineProbe = pending
  }

  /** The StatusLineState → app.status mapping: a segment with NO source is
   * CLEARED (unknown → omitted — never a fabricated default left behind). */
  private applyStatusState(st: StatusLineState, tasks: { running: number } | undefined): void {
    const s = this.app.status
    s.modelKnown = st.model !== undefined
    s.branch = st.branch
    s.path = st.cwd ?? s.path
    s.contextUsed = st.context?.used
    s.contextTotal = st.context?.total
    s.turnTimerMs = st.turnTimerMs
    s.session = st.session
    if (tasks !== undefined) s.tasks = { running: tasks.running, labels: [] }
    else s.tasks = { running: 0, labels: [] }
    // the queue chip: the source's 0/absent means nothing queued (the
    // aggregation only emits >0) — the previous value MUST clear or a
    // drained queue leaves a stale "+N" on the row.
    s.queue = st.queue ?? 0
    if (st.todo !== undefined) s.todo = st.todo
    if (st.goal !== undefined) s.goal = st.goal
  }

  /** M49 Task 12: the TRANSCRIPT evidence lines for one task — parents can
   * only reconstruct the subagent lifecycle from the PARENT log (memory/disk
   * via the engine): the spawn tool block's parent prompt/role + the
   * subagent started/ended system rows. When the block is absent the viewer
   * explains the unavailable state honestly (the child's own conversation
   * lives in a separate child session — not in the parent log). */
  private taskTranscriptLines(view: AgentTaskView): Array<{ text: string }> {
    const taskName = view.label
    const eng = this.opts.engine
    const total = eng.lineCount()
    const spawnTitle = `spawn_agent: ${taskName}`
    const lines: Array<{ text: string }> = []
    let spawnFound = false
    for (let l = 0; l < total; l++) {
      if (!spawnFound) {
        const info = eng.toolAt?.(l)
        if (info !== undefined && info.kind === "subagent") {
          const args = info.args as { task_name?: unknown; message?: unknown } | undefined
          if (args?.task_name === taskName) {
            spawnFound = true
            lines.push({ text: `${spawnTitle} (parent prompt: ${typeof args.message === "string" ? args.message : "?"})` })
            if (info.status === "done") lines.push({ text: `spawn result: ${info.output ?? ""}` })
            else if (info.error !== undefined) lines.push({ text: `spawn error: ${info.error}` })
          }
        }
      }
      const block = eng.lineBlock(l)
      if (block !== undefined && block.title.length > 0
        && (block.title.includes(`subagent started: ${taskName}`) || block.title.includes(`subagent ended: ${taskName}`))) {
        lines.push({ text: block.title })
      }
    }
    return lines
  }

  // ------------------------------------------------------------------ minimal mode (M38a G2)

  /** Active when the minimal host resolved — everything (frame, keys,
   * commits) routes through the InlineHost + write sink, never the cells. */
  private inlineActive(): boolean {
    return this.inlineHost !== undefined
  }

  private minimalCommits(): MinimalCommits {
    this.commits ??= new MinimalCommits(this.opts.engine, { now: this.opts.now })
    return this.commits
  }

  private async resolveInlineNow(): Promise<void> {
    if (this.inlineResolved) return
    this.inlineResolved = true
    if (this.opts.inline !== undefined) {
      this.inlineHost = this.opts.inline
      return
    }
    const factory = this.opts.inlineFactory
    if (factory === undefined || this.uiMode !== "minimal") return
    this.inlineHost = await factory().catch(() => undefined)
  }

  /** Boundary → commit the engine delta print-once; otherwise the 500ms
   * idle check (long stream) may commit right away. */
  private minimalOnEvent(ev: TuiEvent): void {
    const commits = this.minimalCommits()
    const due = commits.onEvent(ev)
    if (due || commits.idleFlushDue(this.opts.now?.() ?? Date.now())) {
      this.commitMinimalDelta()
    }
  }

  /** pendingDelta → InlineHost.commit; all bytes through the app sink. */
  private commitMinimalDelta(): void {
    const host = this.inlineHost
    if (host === undefined) return
    commitDelta(host, this.minimalCommits().pendingDelta(), (s) => this.opts.write?.(s))
  }

  /** Minimal frame: refresh the region content (todos/status/prompt from the
   * app state — the tail window re-read from the engine) + `drawRegion`
   * repaint. No cell renderer touch at all. */
  private frameMinimal(): void {
    const host = this.inlineHost!
    host.setRegion?.(this.composeMinimalRegion())
    // Zero-byte idle gate (M38a): the engine returns "" when the region is
    // unchanged (the anim pump ticks at 30fps while a turn runs — identical
    // repaints must not reach the tty; mirrors the fullscreen diff path).
    host.drawRegion((s) => {
      if (s !== "") this.opts.write?.(s)
    })
  }

  private composeMinimalRegion(): RegionLine[] {
    const host = this.inlineHost!
    const budget = Math.max(2, host.regionRows())
    // M49 Task 8: an open modal/viewer/dropdown embeds its chrome in the
    // region — BORDERLESS region rows (minimal has no cell surface, so the
    // content replaces the tail window while it is open; the region stays
    // prompt-anchored). The overlay's optional minimalRows() seam owns the
    // row model for the draw-based modal binders; state surfaces (light panel,
    // sessions/history/dropdowns) project theirs from the app state.
    const chrome = this.minimalChromeRows()
    const total = this.opts.engine.lineCount()
    // Over-fetch by the todo height +1 so todo rows don't starve the tail
    // window; composeRegion truncates the tail (keeps the LAST lines).
    const window = Math.min(total, budget + 1)
    const tail = chrome ?? this.opts.engine.viewport(Math.max(0, total - window), window).map(displayToRegion)
    return composeRegion(
      {
        tail,
        todos: this.todoRows(),
        status: this.statusRow(),
        prompt: this.promptRow(),
        info: this.infoRow(),
      },
      budget,
      {},
    )
  }

  /** The minimal embedded chrome rows for the open surface (undefined = no
   * surface — the normal tail window). Borderless: plain text, no box. */
  private minimalChromeRows(): RegionLine[] | undefined {
    const ov = this.app.overlay
    if (ov !== undefined && typeof ov.minimalRows === "function") {
      return ov.minimalRows()
    }
    const lp = this.app.lightPanel
    if (lp !== undefined) {
      const rows: RegionLine[] = []
      for (const r of lp.rows) {
        rows.push({ runs: [{ text: `${r.label}${r.detail !== undefined ? `  ${r.detail}` : ""}`, style: "text" }] })
      }
      return rows
    }
    if (this.app.historyPanel !== undefined) {
      const h = this.app.historyPanel
      const rows: RegionLine[] = []
      h.entries.forEach((e, i) => {
        rows.push({ runs: [{ text: `${i === h.cursor ? "● " : "○ "}${e.text}`, style: "text" }] })
      })
      return rows
    }
    if (this.app.slash !== undefined) {
      return this.app.slash.entries.map((e) => ({
        runs: [{ text: `/${e.command}${e.description !== undefined ? `  ${e.description}` : ""}`, style: "text" }],
      }))
    }
    if (this.app.completion !== undefined) {
      return this.app.completion.entries.map((e) => ({
        runs: [{ text: `${e.label}${e.desc !== undefined ? `  ${e.desc}` : ""}`, style: "text" }],
      }))
    }
    if (this.app.fileSearch !== undefined) {
      return this.app.fileSearch.files.map((f) => ({
        runs: [{ text: `${f.path}${f.preview !== undefined ? `  ${f.preview}` : ""}`, style: "text" }],
      }))
    }
    if (this.app.sessions !== undefined) {
      const rows: RegionLine[] = []
      for (const g of this.app.sessions.groups) {
        for (const s of g.sessions) {
          rows.push({ runs: [{ text: `${s.id}  ${s.title}${g.repo !== "" ? `  ${g.repo}` : ""}`, style: "text" }] })
        }
      }
      return rows
    }
    return undefined
  }

  /** Status row (spec §5.5): `model · flag · context · queued`. */
  private statusRow(): RegionLine {
    const s = this.app.status
    const parts: string[] = [s.model]
    if (s.plan) parts.push("plan")
    if (s.contextUsed !== undefined && s.contextUsed >= 0) {
      const used = fmtCompact(s.contextUsed)
      parts.push(
        s.contextTotal !== undefined && s.contextTotal > 0
          ? `${used} / ${fmtCompact(s.contextTotal)}`
          : used,
      )
    }
    if (s.queue > 0) parts.push(`+${s.queue}`)
    return { runs: [{ text: parts.join(" · "), style: "dim" }] }
  }

  /** Prompt chrome info row (plans/multiline flags; title fallback). */
  private infoRow(): RegionLine {
    const p = this.app.prompt
    const parts: string[] = []
    if (p.plan) parts.push("plan")
    if (p.multiLine) parts.push("multiline")
    const text = parts.length > 0 ? parts.join(" · ") : this.app.title
    return { runs: [{ text, style: "muted" }] }
  }

  /** The prompt row — the bottom row, always focused; `❯` pinned glyph. */
  private promptRow(): RegionLine {
    const p = this.app.prompt
    return { runs: [{ text: p.text, style: "text" }], glyph: "❯" }
  }

  /** Todo summary lines (spec §1.1 `… · todos · …`) — hidden at 0 items. */
  private todoRows(): RegionLine[] {
    const t = this.app.status.todo
    if (t.total <= 0) return []
    return [{ runs: [{ text: `${t.done}/${t.total}`, style: "muted" }], glyph: "✓" }]
  }
}
