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
import type { BackendClient, ScrollbackEngine, SessionSummary, TuiEvent } from "../contracts.ts"
import { dispatchKey, shortcutsFor } from "./keys.ts"
import type { AppAction, Kbd, KeymapState, OverlayKind } from "./keys.ts"
import { present } from "./present.ts"
import type { TuiAppState } from "./present.ts"
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

/** Fallback slash registry when the host wires no adapter (spec §10 #8). */
const DEFAULT_SLASH_COMMANDS: SlashEntry[] = [
  { command: "help", description: "Shows help for built-in commands" },
  { command: "compact", description: "Compacts the conversation" },
  { command: "clear", description: "Clears the screen history" },
  { command: "tasks", description: "Lists tasks on the current session" },
  { command: "menu", description: "Shows the menu" },
]

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
  private turnStartedAt = 0
  private phaseStartedAt = 0
  /** UI surface mode (M38a): distinct from `app.mode` (normal/plan discipline). */
  private readonly uiMode: "fullscreen" | "minimal"
  private inlineHost: InlineHost | undefined
  private inlineResolved = false
  private commits: MinimalCommits | undefined

  constructor(opts: TuiAppOptions) {
    this.opts = opts
    this.uiMode = opts.mode ?? "fullscreen"
    const model = "mock-model"
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
    await this.runP
  }

  /** Terminal resize relay — engine re-wrap + minimal inline-host geometry
   * (the host's renderer does not exist in minimal mode). */
  setSize(cols: number, rows: number): void {
    this.app.engine.setWidth(cols)
    this.inlineHost?.resize(cols, rows)
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
    if (this.inlineActive()) {
      this.frameMinimal()
      return
    }
    present(this.app, this.opts.renderer, this.opts.palette, this.opts.glyphs, {
      compact: this.opts.compact,
      cap: this.opts.capabilities,
    })
    this.opts.renderer.flush((s) => this.opts.write?.(s))
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
      // ---- welcome (spec §2a)
      case "menu-up": this.welcomeNav(-1); break
      case "menu-down": this.welcomeNav(1); break
      case "menu-top": this.welcomeNav(-Number.MAX_SAFE_INTEGER); break
      case "menu-bottom": this.welcomeNav(Number.MAX_SAFE_INTEGER); break
      case "menu-activate": this.welcomeActivate(); break
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
    if (ev.type !== "key") return
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
    }
  }

  /** Open interaction surface (spec §4 priority: G1 overlays > pickers > dropdowns). */
  private overlayState(): { kind: OverlayKind; dropdown?: "slash" | "completion" | "file-search" } | undefined {
    const ov = this.app.overlay
    if (ov !== undefined) return { kind: ov.kind }
    if (this.app.sessions !== undefined) return { kind: "sessions" }
    if (this.app.historyPanel !== undefined) return { kind: "history" }
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
        break
      }
      case "user":
      case "user/edit":
      case "system":
        break // engine.append handled the visible surface
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
    this.app.scroll.follow = false
    this.app.scroll.offset = Math.max(0, Math.min(max, this.app.scroll.offset + dy))
  }

  private pageStep(): number {
    return Math.max(1, Math.floor(this.opts.renderer.buffer.height / 2))
  }

  private submitPrompt(): void {
    const text = this.app.prompt.text.trim()
    if (text.length === 0) return // queue-top force-send lands M38 (spec §4)
    // Mode-switch relay (spec §1): "/minimal"/"/fullscreen" text match — the
    // host spawns the SAME session relaunched in the target mode and the loop
    // ends this process (quitNow); nothing else is submitted.
    const modeSwitch = this.opts.modeSwitch
    if (modeSwitch !== undefined && modeSwitch(text)) {
      this.clearPrompt()
      void this.quitNow()
      return
    }
    this.app.history.push(this.app.prompt.text)
    this.app.historyIndex = this.app.history.length
    this.clearPrompt()
    void this.opts.backend.submit(text)
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
      }),
    }
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
      const raw = this.opts.slashCommands ?? DEFAULT_SLASH_COMMANDS
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
    host.drawRegion((s) => this.opts.write?.(s))
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
