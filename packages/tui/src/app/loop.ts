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
import { resolvePalette } from "@i-harness/tui-core"
import type { BackendClient, ScrollbackEngine, SessionSummary, TuiEvent } from "../contracts.ts"
import { dispatchKey, shortcutsFor } from "./keys.ts"
import type { AppAction, Kbd, KeymapState, OverlayKind } from "./keys.ts"
import { present } from "./present.ts"
import type { TuiAppState } from "./present.ts"
import { bindRewindOverlay, isRewindOverlay } from "./overlay-seam.ts"
import type { RewindState } from "../views/rewind.ts"
// M46a G1: provider menu/wizard + settings modal + model picker overlays.
import { bindProviderOverlay, makeWizard, type ProviderBindOptions, type ProviderViewState } from "../views/provider.ts"
import { bindModelPickerOverlay, modelPickerEntries, type ModelPickerState } from "../views/model-picker.ts"
import { bindSettingsOverlay, type SettingsModalState } from "../views/settings.ts"
import type { FetchedModel, ProviderEntry, ProviderStore } from "./provider-store.ts"
import { FpsMeter } from "./hud.ts"
import type { HudState } from "./hud.ts"
import type { RegionLine } from "../minimal/contracts.ts"
import { MinimalCommits, commitDelta, displayToRegion } from "../minimal/commit.ts"
import { composeRegion } from "../minimal/live-region.ts"
import { fmtCompact } from "../views/status.ts"
import type { TurnPhase } from "../views/turn-status.ts"
import type { PaneState } from "../views/agent.ts"
import type { SlashEntry } from "../views/slash-dropdown.ts"
import type { CompletionEntry } from "../views/completion-dropdown.ts"
import type { SearchResult } from "../views/file-search.ts"
import { flattenSessions } from "../views/session-picker.ts"
import type { SessionRow } from "../views/session-picker.ts"
// M46a G2: the slash command registry (builtin map + visible gating) + the
// light panel/kitchen seams the commands' ctx exposes.
import { CommandRegistry, defaultRegistry } from "./slash/registry.ts"
import type { SlashCommand, SlashContext, SlashPanelRequest } from "./slash/types.ts"
import { bindTextInput } from "./slash/impl/text-input.ts"
import type { LightPanelState } from "../views/light-panel.ts"
import { doctorRows } from "../views/light-doctor.ts"

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
  /** M46a G1: the provider/model store behind `/provider`, `/model`,
   * `/settings` + Ctrl+M/F2/Ctrl+, — host-constructed over real settings +
   * credentials (the injected fetchFn is the CI discovery seam). Absent →
   * the modal slash surfaces toast "provider UI: host store not wired". */
  providerStore?: ProviderStore
  /** M46a G2: workspace root — the skills/hooks/plugins/workflow scans
   * (eco panels) land under it. Absent → process.cwd() at run time. */
  workspace?: string
  /** M46a G2: the session id when the host knows it (e.g. --attach; embedded
   * sessions are in-process and the app cannot introspect their id). */
  sessionId?: string
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

/** M46a G1: the TUI provider protocol vocabulary (the /provider arg parse). */
const TUI_PROTOCOLS = ["openai-responses", "openai-compatible", "anthropic", "gemini", "bedrock"] as const

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

export class TuiApp {
  private readonly opts: TuiAppOptions
  private readonly app: TuiAppState
  private stopped = false
  private frameQueued = false
  private animTimer: ReturnType<typeof setInterval> | null = null
  private runP: Promise<unknown> = Promise.resolve()
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
  /** M39 debug HUD meter — allocated ONLY when opts.hud is on (zero otherwise). */
  private fpsMeter: FpsMeter | undefined
  /** M46a G2: the slash command registry (builtin map + visible gate). */
  private readonly slash: CommandRegistry = defaultRegistry()
  /** M46a G2: the ACTIVE palette — the host's at start; /theme re-resolves
   * (resolvePalette groknight/grokday/auto) and every frame draws with it. */
  private palette: Palette

  constructor(opts: TuiAppOptions) {
    this.opts = opts
    this.uiMode = opts.mode ?? "fullscreen"
    this.palette = opts.palette
    if (opts.hud === true) {
      this.fpsMeter = new FpsMeter()
      this.fpsMeter.start()
    }
    // M38b G2: REAL model label — the host's --model spec when wired, else the
    // backend's own knowledge (embedded's modelLabel seam); the "mock-model"
    // fallback stays for hosts that pass neither (existing tests' text).
    const model = this.opts.modelLabel ?? this.opts.backend.modelLabel ?? "mock-model"
    this.app = {
      title: "untitled",
      mode: "normal",
      engine: opts.engine,
      prompt: { text: "", cursor: 0, multiLine: false, focused: true, model, plan: false, title: "untitled" },
      promptCursor: 0,
      history: [],
      historyIndex: 0,
      scroll: { offset: 0, follow: true },
      focused: "prompt",
      search: undefined,
      status: {
        branch: undefined,
        path: "~/workspace",
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
      screen: opts.initialScreen ?? (this.uiMode === "minimal" ? "minimal" : "agent"),
      welcome: {
        version: "0.1.0",
        menus: [
          { key: "ctrl+s", label: "Resume session" },
          { key: "ctrl+n", label: "New session" },
          { key: "ctrl+q", label: "Quit" },
        ],
        cursor: 0,
      },
      paneData: opts.initialPanes,
      // M46a G2: the real toggle knobs (theme auto = the capability guess).
      theme: "auto",
      timestamps: false,
      compactMode: false,
      autoApprove: false,
      draft: undefined,
      lightPanel: undefined,
    }
  }

  /** Coordinator state (the loop mutates; tests/host read). */
  state(): TuiAppState {
    return this.app
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
    this.app.engine.setWidth(this.opts.renderer.buffer.width)
    this.animTimer = setInterval(() => this.animPump(), ANIM_MS)
    this.runP = Promise.all([this.pumpInput(), this.pumpBackend()])
    // Real-value refresh (M38b G2): the initial context/queue snapshots land
    // before the first frame — afterwards they ride the turn boundaries.
    this.refreshContext()
    this.refreshQueue()
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
    this.app.toasts = this.app.toasts.filter((toast) => toast.until > t)
    if (this.app.turn !== undefined) {
      const turn = this.app.turn
      turn.nowMs = t
      turn.phaseMs = t - this.phaseStartedAt
      turn.turnMs = t - this.turnStartedAt
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
      cap: this.opts.capabilities,
      ...(this.fpsMeter !== undefined ? { hud: this.hudState() } : {}),
    })
    this.opts.renderer.flush((s) => this.opts.write?.(s))
  }

  /** Per-frame HUD snapshot — meter + the honest visible line count. */
  private hudState(): HudState {
    return { meter: this.fpsMeter!, lineCount: this.opts.engine.lineCount() }
  }

  /** Keymap/backend/anim results funnel here; the loop paints after. */
  dispatch(action: AppAction): void {
    // Index-carrying accept (digits 1-9, spec §4 permission/question/cancel).
    if (typeof action !== "string") {
      if (action.type === "overlay-accept") this.overlayAccept(action.index)
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
        // Turn navigation needs the engine's turn index — M38.
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
      case "copy-block": this.toast("Copied!"); break // clipboard: M38
      case "focus-scrollback": this.focus("scrollback"); break
      case "focus-prompt": this.focus("prompt"); break
      case "submit": this.submitPrompt(); break
      case "newline": {
        const p = this.app.prompt
        p.text += "\n"
        p.cursor = p.text.length
        p.multiLine = true
        this.refreshShortcuts()
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
      // M46a G1: the provider/model modal surfaces (F2/Ctrl+, → settings;
      // Ctrl+M on the agent screen → the model picker).
      case "open-settings": this.openSettings(); break
      case "open-model-picker": this.openModelPicker(); break
      case "quit": void this.quitNow(); break
      case "quit-arm1":
        // First press (Esc-empty / unarmed) arms; a later press quits.
        if (this.armedQuit) void this.quitNow()
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
    // Minimal mode: the 500ms tail-flush sits on THIS pump (idle tick) — a
    // long assistant stream with no block close commits its partial delta.
    if (this.inlineActive() && this.minimalCommits().idleFlushDue(t)) {
      this.commitMinimalDelta()
    }
    if (this.needsAnim(t)) this.requestFrame()
  }

  /** "Needs repaint" polling (spec §7): turn running or a live toast. */
  private needsAnim(t: number): boolean {
    if (this.app.turn !== undefined) return true
    for (const toast of this.app.toasts) if (toast.until > t) return true
    return false
  }

  private onInput(ev: InputEvent): void {
    if (ev.type === "paste") {
      if (this.app.focused === "prompt") {
        const p = this.app.prompt
        p.text = p.text.slice(0, p.cursor) + ev.text + p.text.slice(p.cursor)
        p.cursor += ev.text.length
        this.refreshDropdowns()
      }
      this.requestFrame()
      return
    }
    if (ev.type === "mouse") {
      // Wheel → the existing scroll actions (M40 G2 / C11): ±3, follow-aware
      // (scrollBy resolves the follow pin before offsetting — one notch leaves
      // the tail, no jump to the top). 1006/1015/1016 wheel reports decode in
      // tui-core; the coordinates are unused (no hit-testing in this wheel).
      // Minimal mode has no fullscreen scrollback surface → no-op there.
      if (!this.inlineActive()) {
        if (ev.button === "wheel-up") { this.dispatch("scroll-up"); return }
        if (ev.button === "wheel-down") { this.dispatch("scroll-down"); return }
      }
      return
    }
    if (ev.type !== "key") return
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
        const p = this.app.prompt
        p.text = p.text.slice(0, p.cursor) + p.text.slice(p.cursor + 1)
        this.refreshDropdowns()
        return
      }
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
      minimal: this.inlineActive(),
      rewindAvailable: this.rewindEligible(),
      rewindArmed: this.armedRewind,
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
    this.opts.engine.append(ev)
    // Minimal commit pipeline (M38a): boundary events commit the engine
    // delta print-once; the region repaint rides the frame below.
    if (this.inlineActive()) this.minimalOnEvent(ev)
    const now = this.opts.now?.() ?? Date.now()
    switch (ev.type) {
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

  private pageStep(): number {
    return Math.max(1, Math.floor(this.opts.renderer.buffer.height / 2))
  }

  private submitPrompt(): void {
    const text = this.app.prompt.text.trim()
    if (text.length === 0) return // queue-top force-send lands M38 (spec §4)
    // M46a G1 slash modals: /provider, /model, /settings (each = the modal
    // surface; harmonized with G2's registry below — the G1 text-match stays
    // FIRST: it owns those three names and never fights the registry run).
    if (this.tryG1SlashModal(text)) {
      this.clearPrompt()
      return
    }
    // M46a G2: the slash REGISTRY run — every backend-supported command hits
    // here (the M37b text-match relay is superseded). Matched → run + return;
    // UNKNOWN "/x" falls through to the normal submit (spec §2 fallback).
    const matched = this.slash.matches(text, this.slashCtx(text))
    if (matched !== undefined) {
      this.app.history.push(this.app.prompt.text)
      this.app.historyIndex = this.app.history.length
      this.clearPrompt()
      void this.runSlashCommand(matched.command, matched.arg, text)
      return
    }
    // Mode-switch relay (spec §1, still the /minimal //fullscreen host path
    // when a host wires it without the registry relay — harmless fallback).
    const modeSwitch = this.opts.modeSwitch
    if (modeSwitch !== undefined && modeSwitch(text)) {
      this.clearPrompt()
      void this.quitNow()
      return
    }
    this.app.history.push(this.app.prompt.text)
    this.app.historyIndex = this.app.history.length
    this.clearPrompt()
    // Catch: a SUBMIT failure surfaces as a toast instead of an unhandled
    // rejection (the remote bridge rethrows server -32603 + connection
    // errors; the embedded path has the same rejection profile). The turn's
    // events — success or failure — flow through events() regardless.
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

  private insertText(s: string): void {
    const p = this.app.prompt
    p.text = p.text.slice(0, p.cursor) + s + p.text.slice(p.cursor)
    p.cursor += s.length
    this.refreshDropdowns()
  }

  private backspace(): void {
    const p = this.app.prompt
    if (p.cursor <= 0) return
    p.text = p.text.slice(0, p.cursor - 1) + p.text.slice(p.cursor)
    p.cursor -= 1
    this.refreshDropdowns()
  }

  private clearPrompt(): void {
    this.app.prompt.text = ""
    this.app.prompt.cursor = 0
    this.refreshDropdowns()
    this.refreshShortcuts()
  }

  private historyStep(dir: 1 | -1): void {
    const h = this.app.history
    if (h.length === 0) return
    if (dir === 1) {
      if (this.app.historyIndex >= h.length - 1) {
        this.app.historyIndex = h.length
        this.app.prompt.text = ""
        this.app.prompt.cursor = 0
        return
      }
    }
    let i = Math.max(0, Math.min(h.length, this.app.historyIndex + dir))
    if (i >= h.length) i = h.length - 1
    this.app.historyIndex = i
    this.app.prompt.text = h[i]
    this.app.prompt.cursor = h[i].length
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
   * rides the plan conversation. */
  private planComment(): void {
    this.app.prompt.text = "comment: "
    this.app.prompt.cursor = "comment: ".length
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
      workspace: this.opts.workspace,
      sessionId: this.opts.sessionId,
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
      startSearch: () => this.activateSearch(),
      planRows: () => this.lastAssistantRows(),
      toggleBtwWith: (question) => this.toggleBtwWith(question),
      openBtwInput: () => this.openBtwInput(),
      togglePane: (kind) => this.togglePane(kind),
      setScreen: (screen) => {
        app.screen = screen
        if (screen === "welcome") {
          app.welcome = { version: "0.1.0", menus: app.welcome?.menus ?? [], cursor: 0 }
        }
        this.requestFrame()
      },
      setTheme: (kind) => this.setTheme(kind),
      setTimestamps: (on) => this.setTimestamps(on),
      setMultiline: (on) => {
        app.prompt.multiLine = on
        this.refreshShortcuts()
      },
      setCompactMode: (on) => {
        app.compactMode = on
      },
      setAutoApprove: (on) => {
        app.autoApprove = on
      },
      focusPrompt: () => this.focus("prompt"),
      resetSession: () => this.resetSession(),
      renameSession: (title) => void this.renameSession(title),
      deleteSession: () => this.deleteSession(),
      relaunch: () => this.relaunchSlash(input),
      quitApp: () => void this.quitNow(),
      copyBlock: () => this.toast("Copied!"), // clipboard M38 (parity with `y`)
      editPromptInEditor: () => this.editPromptInEditor(),
      exportTranscript: () => this.exportTranscript(),
      openTranscriptPager: () => this.openTranscriptPager(),
      probeReport: async () => doctorRows(this.opts.capabilities),
      g1Modal: (line) => this.tryG1SlashModal(line),
      effort: (level) => this.effort(level),
    }
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
   * text, restore the stashed one). Toast states per the keys truth. */
  private stashDraft(): void {
    const current = this.app.prompt.text
    if (this.app.draft === undefined) {
      if (current.trim().length === 0) {
        this.toast("nothing to stash")
        return
      }
      this.app.draft = current
      this.app.prompt.text = ""
      this.app.prompt.cursor = 0
      this.toast("Draft stashed")
    } else {
      const stashed = this.app.draft
      this.app.draft = current // swap — the current text returns to the slot
      this.app.prompt.text = stashed
      this.app.prompt.cursor = stashed.length
      this.toast("Draft restored")
    }
    this.refreshDropdowns()
    this.refreshShortcuts()
    this.requestFrame()
  }

  /** /find: activate the scrollback search mode (the prompt box becomes the
   * search bar; the loop intercepts chars while search is active). */
  private activateSearch(): void {
    this.app.search = { active: true, text: "", matches: [], current: 1 }
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

  /** /jump anchors: every User block header line (display line → label). */
  private turnAnchors(): Array<{ line: number; n: number; text?: string }> {
    const total = this.opts.engine.lineCount()
    const out: Array<{ line: number; n: number; text?: string }> = []
    let n = 0
    for (let line = 0; line < total; line++) {
      const block = this.opts.engine.lineBlock(line)
      if (block === undefined || block.title !== "User") continue
      n++
      const text = block.runs.map((r) => r.text).join("").replace(/^[❯\s]+/, "").slice(0, 40)
      out.push({ line, n, text })
    }
    return out
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

  /** /theme — re-resolve the palette (groknight/grokday/auto via tui-core). */
  private setTheme(kind: "groknight" | "grokday" | "auto"): void {
    this.app.theme = kind
    this.palette = resolvePalette(this.opts.capabilities, kind === "auto" ? undefined : kind)
    this.requestFrame()
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
    this.app.prompt.text = ""
    this.app.prompt.cursor = 0
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
  private deleteSession(): void {
    this.resetSession()
    this.app.screen = "welcome"
    this.toast("session deleted (embedded store is in-process — persistence M38)")
    this.requestFrame()
  }

  /** /minimal //fullscreen — the host's ModeSwitch relay (spawns the same
   * session in the target mode); true ⇒ the command's run quits the loop. */
  private relaunchSlash(input: string): boolean {
    const modeSwitch = this.opts.modeSwitch
    if (modeSwitch !== undefined && modeSwitch(input)) return true
    this.toast("mode relay: host modeSwitch not wired")
    return false
  }

  /** /effort — the REAL settings write (llm.defaultModel.reasoningEffort via
   * G1's settings store surface); the interactive 6-dial ArgPicker is the
   * settings modal's Models class. No arg → report the current effort. */
  private effort(level: string): void {
    const store = this.opts.providerStore
    if (store === undefined) {
      this.toast("effort: settings host store not wired")
      return
    }
    const dm = store.defaultModel()
    if (level.trim() === "") {
      this.toast(`effort: ${dm.reasoningEffort ?? "default"} — /effort <level> to set`)
      return
    }
    const lv = level.trim()
    const surface = store.settingsSurface()
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
      this.app.prompt.text = text
      this.app.prompt.cursor = text.length
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

  // ------------------------------------------------------------------ provider/settings/model modals (M46a G1)

  /** The G1 slash-text interception: "/provider [variant]", "/model [name]",
   * "/settings" — returns true when handled (the prompt is cleared; the modal
   * opens or a toast explains). Unrecognized G1 text (e.g. "/effort" — G2's)
   * falls through to the backend. */
  private tryG1SlashModal(line: string): boolean {
    const store = this.opts.providerStore
    if (store === undefined) {
      if (/^\/provider(?:\s|$)/.test(line) || /^\/model(?:\s|$)/.test(line) || line === "/settings") {
        this.toast("provider UI: host store not wired")
        return true
      }
      return false
    }
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
   * the wizard prefilled; update <id> → the wizard editing; use|switch <id> →
   * setActive + toast; delete [id] → the delete view (row preselected); reload
   * → re-run discovery over the active provider (toast result/error). A bare
   * `/provider` = the menu (cc parity). */
  private openProvider(args: string): void {
    const store = this.opts.providerStore
    if (store === undefined) {
      this.toast("provider UI: host store not wired")
      return
    }
    const tokens = args.split(/\s+/).filter((t) => t !== "")
    const cmd = tokens[0] ?? ""

    if (cmd === "reload") {
      const active = store.activeEntry()
      if (active === undefined) {
        this.toast("no active provider — add one with /provider add first")
        return
      }
      this.toast(`discovering models for ${active.id}…`)
      void store.discoverModels(active.id, { force: true }).then(
        (models) => this.toast(`discovered ${models.length} model(s) for ${active.id}`),
        (error: unknown) => this.toast(error instanceof Error ? error.message : String(error)),
      )
      return
    }
    if (cmd === "use" || cmd === "switch" || cmd === "show" || cmd === "list") {
      const id = tokens[1] ?? store.activeId()
      if (id === "") {
        if (cmd === "show" || cmd === "list") this.openProviderMenu()
        else this.toast("no active provider — add one with /provider add first")
        return
      }
      if (cmd === "show" || cmd === "list") {
        this.openProviderMenu()
        return
      }
      void store.setActive(id).then(
        () => this.toast(`active provider: ${id}`),
        (error: unknown) => this.toast(error instanceof Error ? error.message : String(error)),
      )
      return
    }
    if (cmd === "add" || cmd === "update") {
      const id = tokens[1]
      const base = tokens[2]
      // protocol=x / modelsUrl=y optional tokens (arg form only — the wizard
      // itself defaults protocol to openai-compatible).
      let protocol: ProviderEntry["protocol"] | undefined
      for (const t of tokens.slice(1)) {
        const m = /^protocol=(.+)$/.exec(t)
        if (m !== null) {
          const p = m[1]
          if (p !== undefined && (TUI_PROTOCOLS as readonly string[]).includes(p)) {
            protocol = p as ProviderEntry["protocol"]
          }
        }
      }
      const editing = cmd === "update" ? store.get(id ?? "") : undefined
      if (cmd === "update" && editing === undefined) {
        this.toast(`provider "${id}" is not configured`)
        return
      }
      if (id !== undefined && base !== undefined) {
        // Prefilled save path (arg form): create/update + activate + discover.
        void (async () => {
          try {
            const entry: ProviderEntry = {
              id,
              baseUrl: base.replace(/\/+$/, ""),
              protocol: protocol ?? (editing?.protocol ?? "openai-compatible"),
              ...(editing?.name !== undefined ? { name: editing.name } : {}),
            }
            await store.upsert(entry)
            await store.setActive(id)
            void store.discoverModels(id).catch(() => {})
            this.toast(`provider saved & active: ${id}`)
          } catch (error) {
            this.toast(error instanceof Error ? error.message : String(error))
          }
        })()
        return
      }
      // Interactive wizard (prefilled only with the id/base token — the key
      // field starts empty: "Leave empty to keep the current key.").
      const state: ProviderViewState = {
        phase: "wizard",
        cursor: 0,
        providers: store.list(),
        wizard: editing !== undefined
          ? makeWizard(editing, store.maskFor(editing.id) !== "not set")
          : makeWizard(id !== undefined ? { id, baseUrl: "" } : undefined, false),
        error: undefined,
        pendingId: undefined,
      }
      this.app.overlay = bindProviderOverlay(state, this.providerBindOptions(store))
      this.requestFrame()
      return
    }
    if (cmd === "delete") {
      const rows = store.list()
      const target = tokens[1]
      const cursor = target === undefined ? 0 : Math.max(0, rows.findIndex((p) => p.id === target))
      const state: ProviderViewState = {
        phase: "delete",
        cursor,
        providers: rows,
        error: undefined,
        pendingId: undefined,
        wizard: undefined,
      }
      this.app.overlay = bindProviderOverlay(state, this.providerBindOptions(store))
      this.requestFrame()
      return
    }
    // bare /provider → the menu (cc parity)
    this.openProviderMenu()
  }

  private openProviderMenu(): void {
    const store = this.opts.providerStore
    if (store === undefined) {
      this.toast("provider UI: host store not wired")
      return
    }
    const state: ProviderViewState = {
      phase: "menu",
      cursor: 0,
      providers: store.list(),
      error: undefined,
      pendingId: undefined,
      wizard: undefined,
    }
    this.app.overlay = bindProviderOverlay(state, this.providerBindOptions(store))
    this.requestFrame()
  }

  /** The shared provider-binder options: the loop's close + toast channels. */
  private providerBindOptions(store: ProviderStore): ProviderBindOptions {
    return {
      store,
      activeId: store.activeId(),
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

  /** The settings modal (F2/Ctrl+,//settings) — keys per the new-new truth
   * (sidebar categories; Enter browses; Esc backs). */
  private openSettings(): void {
    const store = this.opts.providerStore
    if (store === undefined || store === null) {
      this.toast("settings modal: host provider store not wired")
      return
    }
    const state: SettingsModalState = { phase: "categories", cursor: 0, category: undefined, error: undefined }
    this.app.overlay = bindSettingsOverlay(state, {
      settings: store.settingsSurface(),
      providerStore: store,
      onTimestamps: (on) => {
        // Live engine flip (the knob renders what the engine does).
        this.opts.engine.setShowTimestamps?.(on)
        this.requestFrame()
      },
      onOpenPicker: () => {
        // Models default_model → the same picker Ctrl+M//model use; its
        // select writes the settings default (settings modal reopens below).
        this.openModelPicker(undefined, true)
      },
      onClose: () => this.closeModal(),
    })
    this.requestFrame()
  }

  /** The model picker (Ctrl+M on the agent screen, /model, settings Models).
   * The list comes from the ACTIVE provider's discovered catalog (runtime
   * memo); an un-discovered provider kicks discovery (loading state).
   * `reopenSettings` — after the picker select, reopen the settings modal
   * (the default_model row now shows the pick). */
  private openModelPicker(_preselect?: string, reopenSettings = false): void {
    const store = this.opts.providerStore
    if (store === undefined) {
      this.toast("model picker: host provider store not wired")
      return
    }
    const active = store.activeEntry()
    if (active === undefined) {
      this.toast("no active provider — /provider add first")
      return
    }
    const cached = store.cachedModels(active.id)
    const state: ModelPickerState = {
      entries: cached !== undefined ? modelPickerEntries(cached) : [],
      cursor: 0,
      loading: cached === undefined,
      provider: active.id,
    }
    this.app.overlay = bindModelPickerOverlay(state, {
      onSelect: (value) => {
        const choice = value === undefined || value === "" ? "(no override)" : value
        void store.setDefaultModel(value ?? "").then(
          () => this.toast(`default model: ${choice}`),
          (error: unknown) => this.toast(error instanceof Error ? error.message : String(error)),
        )
        if (reopenSettings) this.openSettings()
      },
      onClose: () => this.closeModal(),
    })
    if (cached === undefined) {
      void store.discoverModels(active.id).then(
        (models: FetchedModel[]) => {
          // The picker may have closed (Esc) before discovery resolved — guard.
          if (this.app.overlay === undefined) return
          const cur = this.app.overlay
          if ((cur as { kind?: string }).kind !== "model-picker") return
          state.entries = modelPickerEntries(models)
          state.loading = false
          this.requestFrame()
        },
        (error: unknown) => {
          if (this.app.overlay === undefined) return
          const cur = this.app.overlay
          if ((cur as { kind?: string }).kind !== "model-picker") return
          state.entries = []
          state.loading = false
          this.toast(error instanceof Error ? error.message : String(error))
          this.requestFrame()
        },
      )
    }
    this.requestFrame()
  }

  // ------------------------------------------------------------------ panes / pickers / dropdowns (M37b)

  private togglePane(kind: "todo" | "tasks" | "queue"): void {
    if (this.app.panes.has(kind)) this.app.panes.delete(kind)
    else this.app.panes.add(kind)
    this.requestFrame()
  }

  private toggleSessions(): void {
    if (this.app.sessions !== undefined) {
      this.app.sessions = undefined
      this.requestFrame()
      return
    }
    const loader = this.opts.listSessions
    const now = this.opts.now?.() ?? Date.now()
    if (loader === undefined) {
      this.app.sessions = { groups: [], cursor: 0, now }
      this.toast("session picker: host listSessions option not wired")
      return
    }
    this.app.sessions = { groups: [], cursor: 0, loading: true, now }
    void loader().then((list) => {
      if (this.app.sessions === undefined) return
      this.app.sessions = {
        groups: [{ repo: "sessions", sessions: list.map((s): SessionRow => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          turnCount: s.turnCount,
          contextUsed: s.contextUsed,
          contextTotal: s.contextTotal,
        })) }],
        cursor: 0,
        loading: false,
        now,
      }
      this.requestFrame()
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
        this.app.prompt.text = e.text
        this.app.prompt.cursor = e.text.length
      }
      this.app.historyPanel = undefined
      return
    }
    const ss = this.app.sessions
    if (ss !== undefined) {
      const sel = flattenSessions(ss)[ss.cursor]
      this.app.sessions = undefined
      if (sel !== undefined) void this.opts.backend.open(sel.session.id)
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

  private welcomeActivate(): void {
    const w = this.app.welcome
    if (w === undefined) return
    const m = w.menus[w.cursor]
    if (m?.key.endsWith("q")) { void this.quitNow(); return }
    if (m?.key.includes("Resume session")) { this.toast("resume session: M38"); return }
    // agent screen; the host wires real session creation at G4/harmonization.
    this.app.screen = "agent"
    this.toast(`welcome: '${m?.label ?? "activate"}' → agent (host wiring M38)`)
    this.requestFrame()
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

  /** Replace the token under the caret (slash/at/completion accept). */
  private replaceTokenAtCursor(replacement: string): void {
    const p = this.app.prompt
    const before = p.text.slice(0, p.cursor)
    const start = before.lastIndexOf(" ") + 1
    p.text = p.text.slice(0, start) + replacement + p.text.slice(p.cursor)
    p.cursor = start + replacement.length
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
    this.contextProbe = probe()
      .then((usage) => {
        this.contextProbe = undefined
        if (usage === undefined) return
        this.app.status.contextUsed = usage.used
        if (usage.total !== undefined) this.app.status.contextTotal = usage.total
        this.requestFrame()
      })
      .catch(() => {
        this.contextProbe = undefined
      })
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
    const total = this.opts.engine.lineCount()
    // Over-fetch by the todo height +1 so todo rows don't starve the tail
    // window; composeRegion truncates the tail (keeps the LAST lines).
    const window = Math.min(total, budget + 1)
    const tail = this.opts.engine.viewport(Math.max(0, total - window), window).map(displayToRegion)
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
